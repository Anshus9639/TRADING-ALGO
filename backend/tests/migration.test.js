const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');

const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { loadAccountView } = require('../services/accountView');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { createMatcher } = require('../services/matcher');
const { findUnmigratedLegacyOrders } = require('../services/legacyOrders');
const { checkIdempotencyIndex } = require('../scripts/check-idempotency-index');
const {
  planAccount,
  runMigration,
  auditLegacyData,
  verifyMigration,
  createBackup,
  verifyBackup
} = require('../scripts/legacyMigration');
const { startTestDb, stopTestDb, createTestUser } = require('./helpers');

function models() {
  return { User, Order, Trade };
}

async function clearCollections() {
  await Promise.all([
    User.deleteMany({}),
    Order.deleteMany({}),
    Trade.deleteMany({})
  ]);
}

function legacyTrade(symbol, type, quantity, price, timestamp) {
  return {
    _id: new mongoose.Types.ObjectId(),
    symbol,
    type,
    quantity,
    price,
    ...(timestamp ? { timestamp } : {})
  };
}

function legacyOrder(symbol, type, quantity, limitPrice, timestamp) {
  return {
    _id: new mongoose.Types.ObjectId(),
    symbol,
    type,
    quantity,
    limitPrice,
    ...(timestamp ? { timestamp } : {})
  };
}

describe('legacy embedded data migration', () => {
  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await clearCollections();
  });

  test('dry run reports changes and writes nothing', async () => {
    const buyOrder = legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date('2025-01-01T00:00:00Z'));
    const sellOrder = legacyOrder('BTCUSDT', 'SELL', 0.1, 60000, new Date('2025-01-02T00:00:00Z'));
    const buyTrade = legacyTrade('BTCUSDT', 'BUY', 0.2, 45000, new Date('2024-12-01T00:00:00Z'));
    const sellTrade = legacyTrade('BTCUSDT', 'SELL', 0.1, 50000, new Date('2024-12-02T00:00:00Z'));

    const user = await createTestUser({
      balance: 6000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }],
      pendingOrders: [buyOrder, sellOrder],
      trades: [buyTrade, sellTrade]
    });
    const before = await User.findById(user._id).lean();

    const report = await runMigration({ ...models(), mongoose, mode: 'dry-run' });

    expect(report.mode).toBe('dry-run');
    expect(report.writes).toEqual({ users: 0, orders: 0, trades: 0 });
    expect(report.totals.legacyPendingOrders).toBe(2);
    expect(report.totals.legacyTrades).toBe(2);
    expect(report.totals.ordersToInsert).toBe(2);
    expect(report.totals.tradesToInsert).toBe(2);

    expect(await Order.countDocuments({})).toBe(0);
    expect(await Trade.countDocuments({})).toBe(0);
    expect(await User.findById(user._id).lean()).toEqual(before);
  });

  test('apply migrates history with preserved ids and values', async () => {
    const buyOrder = legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date('2025-01-01T00:00:00Z'));
    const sellOrder = legacyOrder('BTCUSDT', 'SELL', 0.1, 60000, new Date('2025-01-02T00:00:00Z'));
    const buyTrade = legacyTrade('BTCUSDT', 'BUY', 0.2, 45000, new Date('2024-12-01T00:00:00Z'));
    const sellTrade = legacyTrade('BTCUSDT', 'SELL', 0.1, 50000, new Date('2024-12-02T00:00:00Z'));

    const user = await createTestUser({
      balance: 6000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }],
      pendingOrders: [buyOrder, sellOrder],
      trades: [buyTrade, sellTrade]
    });

    const report = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(report.usersUpdated).toBe(1);
    expect(report.usersFailed).toBe(0);
    expect(report.writes).toEqual({ users: 1, orders: 2, trades: 2 });

    const migratedTrades = await Trade.find({ userId: user._id }).sort({ timestamp: 1 }).lean();
    expect(migratedTrades.map(trade => String(trade._id))).toEqual([
      String(buyTrade._id),
      String(sellTrade._id)
    ]);
    expect(migratedTrades[0]).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0.2,
      executionPrice: 45000,
      notional: 9000,
      realizedPnl: null
    });
    expect(migratedTrades[0].timestamp).toEqual(buyTrade.timestamp);

    const migratedOrders = await Order.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
    expect(migratedOrders.map(order => String(order._id))).toEqual([
      String(buyOrder._id),
      String(sellOrder._id)
    ]);
    expect(migratedOrders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: 40000,
      status: 'OPEN',
      clientOrderId: `legacy:${user._id}:${buyOrder._id}`
    });

    const after = await User.findById(user._id).lean();
    // The legacy BUY already deducted 4000 from balance; the migration only
    // annotates it as locked.
    expect(after.balance).toBe(6000);
    expect(after.lockedBalance).toBe(4000);
    // The legacy SELL already deducted 0.1 from holdings; the migration
    // restores total holdings and marks the escrowed unit as locked.
    expect(after.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        quantity: 0.2,
        lockedQuantity: 0.1,
        avgPrice: 45000
      })
    ]);
    // Embedded arrays are retained untouched.
    expect(after.pendingOrders).toHaveLength(2);
    expect(after.trades).toHaveLength(2);
  });

  test('apply is idempotent and does not double count escrow', async () => {
    const user = await createTestUser({
      balance: 6000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }],
      pendingOrders: [
        legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date('2025-01-01T00:00:00Z')),
        legacyOrder('BTCUSDT', 'SELL', 0.1, 60000, new Date('2025-01-02T00:00:00Z'))
      ],
      trades: [legacyTrade('BTCUSDT', 'BUY', 0.2, 45000, new Date('2024-12-01T00:00:00Z'))]
    });

    const first = await runMigration({ ...models(), mongoose, mode: 'apply' });
    expect(first.writes).toEqual({ users: 1, orders: 2, trades: 1 });

    const afterFirst = await User.findById(user._id).lean();
    const second = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(second.writes).toEqual({ users: 0, orders: 0, trades: 0 });
    expect(second.usersUnchanged).toBe(1);
    expect(await User.findById(user._id).lean()).toEqual(afterFirst);
    expect(await Order.countDocuments({ userId: user._id })).toBe(2);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(1);
  });

  test('SELL orders with a missing position are reconstructed and reported', async () => {
    const sellOrder = legacyOrder('SOLUSDT', 'SELL', 2, 200, new Date('2025-01-02T00:00:00Z'));
    const user = await createTestUser({
      balance: 10000,
      portfolio: [],
      pendingOrders: [sellOrder]
    });

    const report = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(report.usersFailed).toBe(0);
    expect(report.ambiguity.issueCounts.MISSING_POSITION_RECONSTRUCTED).toBe(1);
    expect(report.ambiguity.issueCounts.MISSING_COST_BASIS).toBe(1);

    const after = await User.findById(user._id).lean();
    expect(after.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'SOLUSDT',
        quantity: 2,
        lockedQuantity: 2,
        avgPrice: null,
        costBasisStatus: 'UNKNOWN'
      })
    ]);
    expect(await Order.countDocuments({ userId: user._id, status: 'OPEN' })).toBe(1);
  });

  test('duplicate portfolio symbols block the user instead of dropping holdings', async () => {
    const user = await createTestUser({
      balance: 10000,
      portfolio: [
        { symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 40000 },
        { symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 50000 }
      ],
      pendingOrders: [legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date())]
    });

    const before = await User.findById(user._id).lean();
    const report = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(report.usersBlocked).toBe(1);
    expect(report.writes).toEqual({ users: 0, orders: 0, trades: 0 });
    expect(report.ambiguity.issueCounts.DUPLICATE_POSITION_SYMBOL).toBe(1);
    expect(await Order.countDocuments({})).toBe(0);
    expect(await User.findById(user._id).lean()).toEqual(before);
  });

  test('invalid legacy orders and trades are reported, retained, and not migrated', async () => {
    const invalidOrder = legacyOrder('DOGEUSDT', 'BUY', 1, 1, new Date());
    const invalidSell = legacyOrder('DOGEUSDT', 'SELL', -1, 1, new Date());
    const invalidTrade = legacyTrade('BTCUSDT', 'BUY', 0, 100, new Date());
    const user = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 100 }]
    });
    // Raw updates bypass current schema guards so the fixture can represent
    // pre-existing corrupt legacy data, which the migration must report.
    await User.collection.updateOne(
      { _id: user._id },
      { $push: { pendingOrders: { $each: [invalidOrder, invalidSell] }, trades: invalidTrade } }
    );

    const report = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(report.ambiguity.issueCounts.INVALID_LEGACY_ORDER).toBe(2);
    expect(report.ambiguity.issueCounts.INVALID_LEGACY_TRADE).toBe(1);
    expect(report.ambiguity.issueCounts.IRRECOVERABLE_ESCROW).toBe(1);
    expect(await Order.countDocuments({})).toBe(0);
    expect(await Trade.countDocuments({})).toBe(0);

    const after = await User.findById(user._id).lean();
    expect(after.pendingOrders).toHaveLength(2);
    expect(after.trades).toHaveLength(1);
  });

  test('missing timestamps fall back deterministically to the account creation time', async () => {
    const order = legacyOrder('ETHUSDT', 'BUY', 1, 3000);
    const trade = legacyTrade('ETHUSDT', 'BUY', 1, 2900);
    const user = await createTestUser({
      balance: 7000,
      portfolio: [{ symbol: 'ETHUSDT', quantity: 1, avgPrice: 2900 }]
    });
    // Raw updates avoid the schema's default timestamp so the fixture can
    // represent records written before timestamps were populated.
    await User.collection.updateOne(
      { _id: user._id },
      { $push: { pendingOrders: order, trades: trade } }
    );

    const report = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(report.ambiguity.issueCounts.MISSING_TIMESTAMP).toBe(2);
    const migratedOrder = await Order.findById(order._id).lean();
    const migratedTrade = await Trade.findById(trade._id).lean();
    expect(migratedOrder.createdAt).toEqual(user.createdAt);
    expect(migratedTrade.createdAt).toEqual(user.createdAt);
  });

  test('conflicting canonical records are reported and never overwritten', async () => {
    const trade = legacyTrade('BNBUSDT', 'BUY', 1, 600, new Date('2025-01-01T00:00:00Z'));
    const user = await createTestUser({
      balance: 9400,
      portfolio: [{ symbol: 'BNBUSDT', quantity: 1, avgPrice: 600 }],
      trades: [trade]
    });
    await Trade.create({
      _id: trade._id,
      userId: user._id,
      symbol: 'BNBUSDT',
      side: 'BUY',
      quantity: 2,
      executionPrice: 500,
      notional: 1000,
      timestamp: new Date('2025-01-01T00:00:00Z')
    });

    const report = await runMigration({ ...models(), mongoose, mode: 'apply' });

    expect(report.ambiguity.issueCounts.CONFLICTING_EXISTING_TRADE).toBe(1);
    const canonical = await Trade.findById(trade._id).lean();
    expect(canonical.quantity).toBe(2);
    expect(canonical.executionPrice).toBe(500);
  });

  test('backup is verified before apply and embedded arrays remain intact', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexustrade-migration-'));
    const backupFile = path.join(directory, 'users-backup.json');
    try {
      const user = await createTestUser({
        balance: 6000,
        portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }],
        pendingOrders: [legacyOrder('BTCUSDT', 'SELL', 0.1, 60000, new Date())],
        trades: [legacyTrade('BTCUSDT', 'BUY', 0.2, 45000, new Date())]
      });

      const backup = await createBackup(models(), backupFile);
      expect(backup.userCount).toBe(1);
      expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);

      const applied = await runMigration({ ...models(), mongoose, mode: 'apply' });
      expect(applied.usersFailed).toBe(0);

      const backupCheck = await verifyBackup(models(), backupFile);
      expect(backupCheck.ok).toBe(true);
      expect(backupCheck.changedEmbedded).toEqual([]);

      const verification = await verifyMigration(models(), { backupFile });
      expect(verification.mismatches).toEqual([]);
      expect(verification.ok).toBe(true);
      expect(verification.migrated.orders).toBe(1);
      expect(verification.migrated.trades).toBe(1);
      expect(verification.lockReconciliation.mismatches).toBe(0);

      const view = await loadAccountView(await User.findById(user._id));
      expect(view.pendingOrders).toHaveLength(1);
      expect(view.trades).toHaveLength(1);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('verification flags unmigrated records before apply', async () => {
    await createTestUser({
      balance: 6000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }],
      pendingOrders: [legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date())],
      trades: [legacyTrade('BTCUSDT', 'BUY', 0.2, 45000, new Date())]
    });

    const verification = await verifyMigration(models());
    expect(verification.ok).toBe(false);
    expect(verification.mismatches.map(item => item.code)).toEqual(
      expect.arrayContaining(['UNMIGRATED_ORDERS', 'UNMIGRATED_TRADES'])
    );
  });

  test('audit is read-only and reports legacy counts and ambiguity', async () => {
    const user = await createTestUser({
      balance: 6000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }],
      pendingOrders: [
        legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date()),
        legacyOrder('BTCUSDT', 'SELL', 0.1, 60000, new Date())
      ],
      trades: [legacyTrade('BTCUSDT', 'BUY', 0.2, 45000, new Date())]
    });
    const before = await User.findById(user._id).lean();

    const report = await auditLegacyData(models());

    expect(report.readOnly).toBe(true);
    expect(report.legacy).toMatchObject({
      users: 1,
      pendingOrders: 2,
      openBuy: 1,
      openSell: 1,
      trades: 1
    });
    expect(report.migration.ordersToInsert).toBe(2);
    expect(report.migration.tradesToInsert).toBe(1);
    expect(await Order.countDocuments({})).toBe(0);
    expect(await Trade.countDocuments({})).toBe(0);
    expect(await User.findById(user._id).lean()).toEqual(before);
  });

  test('multiple legacy orders migrate once with deterministic keys, reconcile escrow, and execute once', async () => {
    const buyOne = legacyOrder('BTCUSDT', 'BUY', 0.1, 40000, new Date('2025-01-01T00:00:00Z'));
    const buyTwo = legacyOrder('BTCUSDT', 'BUY', 0.2, 30000, new Date('2025-01-02T00:00:00Z'));
    const sellOne = legacyOrder('ETHUSDT', 'SELL', 0.2, 60000, new Date('2025-01-03T00:00:00Z'));
    const sellTwo = legacyOrder('ETHUSDT', 'SELL', 0.3, 65000, new Date('2025-01-04T00:00:00Z'));

    const user = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'ETHUSDT', quantity: 0.5, avgPrice: 2000 }],
      pendingOrders: [buyOne, buyTwo, sellOne, sellTwo]
    });
    const embeddedBefore = (await User.findById(user._id).lean()).pendingOrders;

    // The isolated replica set must expose the real non-partial unique index.
    const indexBefore = await checkIdempotencyIndex({ collection: Order.collection });
    expect(indexBefore.ok).toBe(true);
    expect(indexBefore.index.partial).toBe(false);
    expect(indexBefore.index.unique).toBe(true);

    const first = await runMigration({ ...models(), mongoose, mode: 'apply' });
    expect(first.usersFailed).toBe(0);
    expect(first.writes).toEqual({ users: 1, orders: 4, trades: 0 });

    // Every embedded order appears exactly once with its original _id.
    const migrated = await Order.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
    expect(migrated.map(order => String(order._id))).toEqual([
      String(buyOne._id),
      String(buyTwo._id),
      String(sellOne._id),
      String(sellTwo._id)
    ]);
    expect(await Order.countDocuments({})).toBe(4);

    // Every key is deterministic (derived from user + embedded id), unique,
    // within the model length limit, and the documents satisfy the schema.
    const keys = migrated.map(order => order.clientOrderId);
    expect(new Set(keys).size).toBe(4);
    for (const order of migrated) {
      expect(order.clientOrderId).toBe(`legacy:${user._id}:${order._id}`);
      expect(Order.hydrate(order).validateSync()).toBeUndefined();
    }

    // A rerun writes nothing and preserves the ids and keys.
    const second = await runMigration({ ...models(), mongoose, mode: 'apply' });
    expect(second.writes).toEqual({ users: 0, orders: 0, trades: 0 });
    expect(second.usersUnchanged).toBe(1);
    expect(second.usersFailed).toBe(0);
    const rerun = await Order.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
    expect(rerun.map(order => String(order._id))).toEqual(migrated.map(order => String(order._id)));
    expect(rerun.map(order => order.clientOrderId)).toEqual(keys);

    const indexAfter = await checkIdempotencyIndex({ collection: Order.collection });
    expect(indexAfter.ok).toBe(true);
    expect(indexAfter.duplicateGroups).toEqual([]);

    // Legacy BUYs already deducted balance; the SELLs already deducted the
    // holdings. Migration only annotates the reservations.
    const migratedUser = await User.findById(user._id).lean();
    expect(migratedUser.balance).toBe(10000);
    expect(migratedUser.lockedBalance).toBe(10000);
    expect(migratedUser.portfolio).toEqual([
      expect.objectContaining({ symbol: 'ETHUSDT', quantity: 1, lockedQuantity: 0.5, avgPrice: 2000 })
    ]);

    const feed = createMarketFeed();
    feed.setQuote('BTCUSDT', 28000);
    feed.setQuote('ETHUSDT', 5000);
    const service = createTradeService({ feed });
    const matcher = createMatcher({ feed, tradeService: service });

    const firstCycle = await matcher.runCycle();
    expect(firstCycle.filled).toBe(2);
    const secondCycle = await matcher.runCycle();
    expect(secondCycle.filled).toBe(0);

    const afterFills = await User.findById(user._id).lean();
    expect(afterFills.balance).toBe(11600);
    expect(afterFills.lockedBalance).toBe(0);
    expect(afterFills.portfolio).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'BTCUSDT', quantity: 0.3, lockedQuantity: 0, avgPrice: 28000 }),
      expect.objectContaining({ symbol: 'ETHUSDT', quantity: 1, lockedQuantity: 0.5, avgPrice: 2000 })
    ]));
    expect(await Trade.countDocuments({ userId: user._id })).toBe(2);
    expect(await Order.countDocuments({ userId: user._id, status: 'FILLED' })).toBe(2);

    const cancelOne = await service.cancelOrder({ orderId: sellOne._id, userId: user._id });
    expect(cancelOne.status).toBe(200);
    const cancelOneAgain = await service.cancelOrder({ orderId: sellOne._id, userId: user._id });
    expect(cancelOneAgain.status).toBe(200);
    expect(cancelOneAgain.body.message).toMatch(/already cancelled/i);
    const cancelTwo = await service.cancelOrder({ orderId: sellTwo._id, userId: user._id });
    expect(cancelTwo.status).toBe(200);
    const cancelTwoAgain = await service.cancelOrder({ orderId: sellTwo._id, userId: user._id });
    expect(cancelTwoAgain.status).toBe(200);
    expect(cancelTwoAgain.body.message).toMatch(/already cancelled/i);

    const idleCycle = await matcher.runCycle();
    expect(idleCycle.filled).toBe(0);

    const finalUser = await User.findById(user._id).lean();
    expect(finalUser.balance).toBe(11600);
    expect(finalUser.lockedBalance).toBe(0);
    expect(finalUser.portfolio).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'BTCUSDT', quantity: 0.3, lockedQuantity: 0, avgPrice: 28000 }),
      expect.objectContaining({ symbol: 'ETHUSDT', quantity: 1, lockedQuantity: 0, avgPrice: 2000 })
    ]));
    expect(await Order.countDocuments({ userId: user._id, status: 'FILLED' })).toBe(2);
    expect(await Order.countDocuments({ userId: user._id, status: 'CANCELLED' })).toBe(2);
    expect(await Order.countDocuments({ userId: user._id })).toBe(4);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(2);
    expect(await findUnmigratedLegacyOrders({ User, Order })).toEqual([]);

    const verification = await verifyMigration(models());
    expect(verification.mismatches).toEqual([]);
    expect(verification.ok).toBe(true);

    // Embedded arrays are never altered or removed by migration or lifecycle.
    const embeddedAfter = (await User.findById(user._id).lean()).pendingOrders;
    expect(embeddedAfter.map(order => String(order._id))).toEqual(embeddedBefore.map(order => String(order._id)));
    expect(embeddedAfter.map(order => order.type)).toEqual(['BUY', 'BUY', 'SELL', 'SELL']);
    expect(embeddedAfter.map(order => order.quantity)).toEqual([0.1, 0.2, 0.2, 0.3]);
  });

  test('plans existing canonical escrow without double counting', () => {
    const userId = new mongoose.Types.ObjectId();
    const plan = planAccount({
      _id: userId,
      createdAt: new Date('2024-01-01T00:00:00Z'),
      balance: 6000,
      lockedBalance: 4000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.2, lockedQuantity: 0.1, avgPrice: 45000 }],
      pendingOrders: [],
      trades: []
    }, [
      {
        _id: new mongoose.Types.ObjectId(),
        userId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        orderType: 'LIMIT',
        quantity: 0.1,
        remainingQuantity: 0.1,
        limitPrice: 40000,
        status: 'OPEN'
      },
      {
        _id: new mongoose.Types.ObjectId(),
        userId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        orderType: 'LIMIT',
        quantity: 0.1,
        remainingQuantity: 0.1,
        limitPrice: 60000,
        status: 'OPEN'
      }
    ], []);

    expect(plan.blocked).toBe(false);
    expect(plan.lockedBalance).toBe(4000);
    expect(plan.lockedBalanceChanged).toBe(false);
    expect(plan.portfolio.positions[0]).toMatchObject({
      symbol: 'BTCUSDT',
      quantity: 0.2,
      lockedQuantity: 0.1
    });
    expect(plan.portfolio.changed).toBe(false);
  });
});
