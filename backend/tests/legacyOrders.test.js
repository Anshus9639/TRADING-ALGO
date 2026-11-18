const mongoose = require('mongoose');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { createMatcher } = require('../services/matcher');
const { findUnmigratedLegacyOrders } = require('../services/legacyOrders');
const { loadAccountView } = require('../services/accountView');
const { runMigration } = require('../scripts/legacyMigration');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

function legacyOrder(symbol, type, quantity, limitPrice) {
  return {
    _id: new mongoose.Types.ObjectId(),
    symbol,
    type,
    quantity,
    limitPrice,
    timestamp: new Date('2026-01-01T00:00:00.000Z')
  };
}

// Legacy placement semantics (verified against the pre-Batch-D engine):
// a BUY limit already deducted balance, a SELL limit already deducted quantity.
async function createLegacyBuyUser() {
  return createTestUser({
    balance: 9000,
    pendingOrders: [legacyOrder('BTCUSDT', 'BUY', 0.1, 10000)]
  });
}

async function createLegacySellUser() {
  return createTestUser({
    balance: 5000,
    portfolio: [{ symbol: 'ETHUSDT', quantity: 2, avgPrice: 1000 }],
    pendingOrders: [legacyOrder('ETHUSDT', 'SELL', 1, 4000)]
  });
}

describe('legacy embedded pending orders', () => {
  let feed;
  let service;
  let matcher;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
    feed = createMarketFeed();
    feed.setQuote('BTCUSDT', 9000);
    feed.setQuote('ETHUSDT', 4500);
    service = createTradeService({ feed });
    matcher = createMatcher({ feed, tradeService: service });
  });

  test('the canonical matcher never executes embedded legacy orders', async () => {
    const buyUser = await createLegacyBuyUser();
    const sellUser = await createLegacySellUser();

    const stats = await matcher.runCycle();

    expect(stats.examined).toBe(0);
    expect(stats.filled).toBe(0);
    expect(await Order.countDocuments()).toBe(0);
    expect(await Trade.countDocuments()).toBe(0);

    const buyAfter = await snapshotUser(buyUser._id);
    expect(buyAfter.balance).toBe(9000);
    expect(buyAfter.portfolio).toEqual([]);
    expect((await User.findById(buyUser._id)).pendingOrders).toHaveLength(1);

    const sellAfter = await snapshotUser(sellUser._id);
    expect(sellAfter.balance).toBe(5000);
    expect(sellAfter.portfolio).toEqual([{ symbol: 'ETHUSDT', quantity: 2, avgPrice: 1000 }]);
    expect((await User.findById(sellUser._id)).pendingOrders).toHaveLength(1);

    // Dual-read keeps the order visible in the account view even though the
    // matcher cannot execute it.
    const buyView = await loadAccountView(await User.findById(buyUser._id));
    expect(buyView.pendingOrders).toHaveLength(1);
  });

  test('legacy BUY and SELL orders can be cancelled and refunded exactly once', async () => {
    const buyUser = await createLegacyBuyUser();
    const sellUser = await createLegacySellUser();

    const buyCancel = await service.cancelOrder({
      orderId: buyUser.pendingOrders[0]._id,
      userId: buyUser._id
    });
    expect(buyCancel.status).toBe(200);
    expect(buyCancel.body.legacy).toBe(true);
    expect((await snapshotUser(buyUser._id)).balance).toBe(10000);

    const buyCancelAgain = await service.cancelOrder({
      orderId: buyUser.pendingOrders[0]._id,
      userId: buyUser._id
    });
    expect(buyCancelAgain.status).toBe(404);
    expect((await snapshotUser(buyUser._id)).balance).toBe(10000);

    const sellCancel = await service.cancelOrder({
      orderId: sellUser.pendingOrders[0]._id,
      userId: sellUser._id
    });
    expect(sellCancel.status).toBe(200);
    expect(sellCancel.body.legacy).toBe(true);

    const sellAfter = await snapshotUser(sellUser._id);
    expect(sellAfter.balance).toBe(5000);
    expect(sellAfter.portfolio).toEqual([{ symbol: 'ETHUSDT', quantity: 3, avgPrice: 1000 }]);
    expect(sellAfter.lockedQuantities).toEqual({});

    const sellCancelAgain = await service.cancelOrder({
      orderId: sellUser.pendingOrders[0]._id,
      userId: sellUser._id
    });
    expect(sellCancelAgain.status).toBe(404);
    expect((await snapshotUser(sellUser._id)).portfolio).toEqual([
      { symbol: 'ETHUSDT', quantity: 3, avgPrice: 1000 }
    ]);
  });

  test('cancelling a legacy SELL keeps an unknown cost basis UNKNOWN', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'ETHUSDT', quantity: 2, avgPrice: null, costBasisStatus: 'UNKNOWN' }],
      pendingOrders: [legacyOrder('ETHUSDT', 'SELL', 1, 4000)]
    });

    const cancel = await service.cancelOrder({
      orderId: user.pendingOrders[0]._id,
      userId: user._id
    });

    expect(cancel.status).toBe(200);
    const stored = await User.findById(user._id).lean();
    expect(stored.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'ETHUSDT',
        quantity: 3,
        avgPrice: null,
        costBasisStatus: 'UNKNOWN'
      })
    ]);

    const view = await loadAccountView(await User.findById(user._id));
    expect(view.portfolio[0].costBasisStatus).toBe('UNKNOWN');
    expect(view.portfolio[0].avgPrice).toBeNull();
  });

  test('after migration legacy orders fill once with no double matching', async () => {
    const buyUser = await createLegacyBuyUser();
    const sellUser = await createLegacySellUser();

    const before = await findUnmigratedLegacyOrders({ User, Order });
    expect(before).toHaveLength(2);
    expect(before.every(entry => entry.count === 1)).toBe(true);

    const report = await runMigration({
      User,
      Order,
      Trade,
      mongoose,
      mode: 'apply'
    });
    expect(report.usersFailed).toBe(0);

    expect(await findUnmigratedLegacyOrders({ User, Order })).toEqual([]);
    expect(await Order.countDocuments({ status: 'OPEN' })).toBe(2);

    const canonicalBuy = await Order.findOne({ symbol: 'BTCUSDT' }).lean();
    expect(String(canonicalBuy._id)).toBe(String(buyUser.pendingOrders[0]._id));

    const migratedBuy = await snapshotUser(buyUser._id);
    expect(migratedBuy.balance).toBe(9000);
    expect(migratedBuy.lockedBalance).toBe(1000);

    const migratedSell = await snapshotUser(sellUser._id);
    expect(migratedSell.portfolio).toEqual([{ symbol: 'ETHUSDT', quantity: 3, avgPrice: 1000 }]);
    expect(migratedSell.lockedQuantities).toEqual({ ETHUSDT: 1 });

    const firstCycle = await matcher.runCycle();
    expect(firstCycle.filled).toBe(2);

    const filledBuy = await snapshotUser(buyUser._id);
    expect(filledBuy.balance).toBe(9100);
    expect(filledBuy.lockedBalance).toBe(0);
    expect(filledBuy.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 9000 }]);

    const filledSell = await snapshotUser(sellUser._id);
    expect(filledSell.balance).toBe(9500);
    expect(filledSell.portfolio).toEqual([{ symbol: 'ETHUSDT', quantity: 2, avgPrice: 1000 }]);

    const secondCycle = await matcher.runCycle();
    expect(secondCycle.filled).toBe(0);
    expect(await Trade.countDocuments()).toBe(2);
    expect(await Order.countDocuments({ status: 'FILLED' })).toBe(2);
  });

  test('migration followed by cancellation refunds exactly once', async () => {
    const buyUser = await createLegacyBuyUser();
    const legacyId = buyUser.pendingOrders[0]._id;

    await runMigration({ User, Order, Trade, mongoose, mode: 'apply' });
    expect(await findUnmigratedLegacyOrders({ User, Order })).toEqual([]);

    const cancelled = await service.cancelOrder({ orderId: legacyId, userId: buyUser._id });
    expect(cancelled.status).toBe(200);
    expect((await snapshotUser(buyUser._id)).balance).toBe(10000);

    // Embedded arrays are intentionally retained until the separate prune
    // stage; a second migration apply must not re-escrow or re-refund.
    const second = await runMigration({ User, Order, Trade, mongoose, mode: 'apply' });
    expect(second.usersFailed).toBe(0);
    expect((await snapshotUser(buyUser._id)).balance).toBe(10000);
    expect((await snapshotUser(buyUser._id)).lockedBalance).toBe(0);

    const cancelAgain = await service.cancelOrder({ orderId: legacyId, userId: buyUser._id });
    expect(cancelAgain.status).toBe(200);
    expect(cancelAgain.body.message).toMatch(/already cancelled/i);
    expect((await snapshotUser(buyUser._id)).balance).toBe(10000);

    expect((await User.findById(buyUser._id)).pendingOrders).toHaveLength(1);
    expect(await Order.countDocuments({ status: 'CANCELLED' })).toBe(1);
  });
});
