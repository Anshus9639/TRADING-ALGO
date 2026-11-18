const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { createMarketFeed } = require('../services/marketFeed');
const { createMatcher } = require('../services/matcher');
const { createTradeService } = require('../services/tradeService');
const {
  findLegacyOrderBlockers,
  duplicateIdGroups
} = require('../services/legacyOrders');
const { loadAccountView } = require('../services/accountView');
const {
  runMigration,
  auditLegacyData
} = require('../scripts/legacyMigration');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

// Writes legacy embedded orders exactly as they exist in old documents,
// bypassing Mongoose subdocument casting and automatic _id generation.
async function setEmbeddedOrders(userId, pendingOrders) {
  await User.collection.updateOne({ _id: userId }, { $set: { pendingOrders } });
}

function embeddedOrder(id, overrides = {}) {
  return {
    ...(id ? { _id: id } : {}),
    symbol: 'BTCUSDT',
    type: 'BUY',
    quantity: 0.1,
    limitPrice: 5000,
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides
  };
}

describe('legacy embedded order ambiguity gate', () => {
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
    service = createTradeService({ feed });
    matcher = createMatcher({ feed, tradeService: service });
  });

  test('two embedded orders sharing one _id block the account without financial mutation', async () => {
    const user = await createTestUser({ balance: 9500, lockedBalance: 500 });
    const sharedId = new mongoose.Types.ObjectId();
    await setEmbeddedOrders(user._id, [
      embeddedOrder(sharedId),
      embeddedOrder(sharedId)
    ]);

    // One canonical twin exists for the duplicated id, so a naive dedupe would
    // silently hide one of the embedded copies.
    await Order.create({
      _id: sharedId,
      userId: user._id,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: 5000,
      status: 'OPEN',
      clientOrderId: `legacy:${user._id}:${sharedId}`
    });

    const before = await snapshotUser(user._id);

    const blockers = await findLegacyOrderBlockers({ User, Order });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      userId: user._id,
      count: 2,
      reasons: ['DUPLICATE_ORDER_ID'],
      missingOrderIds: 0,
      invalidOrders: 0,
      unmigratedOrders: 0,
      duplicateGroups: [{ legacyOrderId: String(sharedId), count: 2 }]
    });
    // The blockers expose only account ids and counts, never user PII.
    expect(Object.keys(blockers[0]).sort()).toEqual([
      'count',
      'duplicateGroups',
      'invalidOrders',
      'missingOrderIds',
      'reasons',
      'unmigratedOrders',
      'userId'
    ]);

    // The matcher is not started while the gate is blocked. Even a single
    // canonical cycle cannot fill at 5000 against a 9000 quote.
    const stats = await matcher.runCycle();
    expect(stats.filled).toBe(0);

    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments()).toBe(1);
    expect(await Trade.countDocuments()).toBe(0);

    const view = await loadAccountView(await User.findById(user._id));
    expect(view.legacyAmbiguity.pendingOrderIds).toEqual([String(sharedId)]);
    expect(view.pendingOrders).toHaveLength(3);
    expect(view.pendingOrders.every(order => order.ambiguous === true)).toBe(true);

    const audit = await auditLegacyData({ User, Order, Trade });
    expect(audit.legacy.duplicateOrderGroups).toEqual([
      { userId: String(user._id), legacyOrderId: String(sharedId), count: 2 }
    ]);
    expect(audit.migration.usersBlocked).toBe(1);
  });

  test('migration blocks the whole account instead of inserting either duplicate', async () => {
    const user = await createTestUser({ balance: 9500, lockedBalance: 500 });
    const sharedId = new mongoose.Types.ObjectId();
    await setEmbeddedOrders(user._id, [
      embeddedOrder(sharedId),
      embeddedOrder(sharedId)
    ]);
    await Order.create({
      _id: sharedId,
      userId: user._id,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: 5000,
      status: 'OPEN',
      clientOrderId: `legacy:${user._id}:${sharedId}`
    });

    const report = await runMigration({ User, Order, Trade, mongoose, mode: 'apply' });

    expect(report.usersBlocked).toBe(1);
    expect(report.usersFailed).toBe(0);
    expect(await Order.countDocuments()).toBe(1);
    expect(await Trade.countDocuments()).toBe(0);

    const stored = await User.findById(user._id).lean();
    expect(stored.pendingOrders).toHaveLength(2);
    expect(stored.balance).toBe(9500);
    expect(stored.lockedBalance).toBe(500);

    expect(report.ambiguity.issueCounts.DUPLICATE_LEGACY_ID).toBe(1);
    expect(report.ambiguity.issues.some(entry => String(entry.detail || '').includes('blocked'))).toBe(true);
  });

  test('duplicate embedded trade ids are surfaced and block migration', async () => {
    const user = await createTestUser({
      portfolio: [{ symbol: 'ETHUSDT', quantity: 1, avgPrice: 1000 }]
    });
    const sharedTradeId = new mongoose.Types.ObjectId();
    await User.collection.updateOne(
      { _id: user._id },
      {
        $set: {
          trades: [
            {
              _id: sharedTradeId,
              symbol: 'ETHUSDT',
              type: 'BUY',
              quantity: 1,
              price: 1000,
              timestamp: new Date('2026-01-01T00:00:00.000Z')
            },
            {
              _id: sharedTradeId,
              symbol: 'ETHUSDT',
              type: 'BUY',
              quantity: 2,
              price: 1000,
              timestamp: new Date('2026-01-02T00:00:00.000Z')
            }
          ]
        }
      }
    );

    const view = await loadAccountView(await User.findById(user._id));
    expect(view.legacyAmbiguity.tradeIds).toEqual([String(sharedTradeId)]);
    expect(view.trades).toHaveLength(2);
    expect(view.trades.every(trade => trade.ambiguous === true)).toBe(true);

    const audit = await auditLegacyData({ User, Order, Trade });
    expect(audit.legacy.duplicateTradeGroups).toEqual([
      { userId: String(user._id), legacyTradeId: String(sharedTradeId), count: 2 }
    ]);

    const report = await runMigration({ User, Order, Trade, mongoose, mode: 'apply' });
    expect(report.usersBlocked).toBe(1);
    expect(await Trade.countDocuments()).toBe(0);
    expect((await User.findById(user._id).lean()).trades).toHaveLength(2);
  });

  test('an embedded order without an _id is reported and blocks the gate', async () => {
    const user = await createTestUser({ balance: 9500, lockedBalance: 500 });
    await setEmbeddedOrders(user._id, [embeddedOrder(null)]);

    const blockers = await findLegacyOrderBlockers({ User, Order });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      userId: user._id,
      count: 1,
      reasons: ['MISSING_ORDER_ID'],
      missingOrderIds: 1
    });

    const view = await loadAccountView(await User.findById(user._id));
    expect(view.pendingOrders).toHaveLength(1);
    expect(view.pendingOrders[0].legacy).toBe(true);

    expect(await Order.countDocuments()).toBe(0);
  });

  test('an invalid embedded order blocks the gate without being altered', async () => {
    const user = await createTestUser({ balance: 9500, lockedBalance: 500 });
    const invalidId = new mongoose.Types.ObjectId();
    await setEmbeddedOrders(user._id, [
      embeddedOrder(invalidId, { type: 'HOLD' })
    ]);

    const blockers = await findLegacyOrderBlockers({ User, Order });
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({
      userId: user._id,
      count: 1,
      reasons: ['INVALID_LEGACY_ORDER'],
      invalidOrders: 1
    });

    const stored = await User.findById(user._id).lean();
    expect(stored.pendingOrders).toHaveLength(1);
    expect(stored.pendingOrders[0].type).toBe('HOLD');
    expect(await Order.countDocuments()).toBe(0);
  });

  test('duplicateIdGroups ignores records without ids', () => {
    const id = new mongoose.Types.ObjectId();
    expect(duplicateIdGroups([
      { _id: id },
      { _id: id },
      { _id: new mongoose.Types.ObjectId() },
      {}
    ])).toEqual([{ legacyOrderId: String(id), count: 2 }]);
  });
});
