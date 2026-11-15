const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { createMatcher } = require('../services/matcher');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

describe('claim-lease limit matcher', () => {
  let feed;
  let service;
  let now;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
    now = 1_700_000_000_000;
    feed = createMarketFeed({ now: () => now });
    feed.setQuote('BTCUSDT', 50000);
    service = createTradeService({ feed, now: () => now });
  });

  function matcher(workerId) {
    return createMatcher({ feed, tradeService: service, now: () => now, workerId });
  }

  async function placeBuyLimit(user, overrides = {}) {
    const result = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: `limit-${new mongoose.Types.ObjectId()}`,
      ...overrides
    });
    expect(result.status).toBe(200);
    return result;
  }

  test('BUY limits fill at the quote and refund price improvement', async () => {
    const user = await createTestUser({ balance: 6000 });
    const placed = await placeBuyLimit(user);

    feed.setQuote('BTCUSDT', 39000);
    const stats = await matcher('worker-buy').runCycle();

    expect(stats.filled).toBe(1);
    expect(stats.failed).toBe(0);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(2100);
    expect(after.lockedBalance).toBe(0);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 39000 }]);

    const order = await Order.findById(placed.body.pendingOrders[0]._id).lean();
    expect(order.status).toBe('FILLED');
    expect(order.filledPrice).toBe(39000);
    expect(order.remainingQuantity).toBe(0);

    const trade = await Trade.findOne({ orderId: order._id }).lean();
    expect(trade.executionPrice).toBe(39000);
    expect(trade.notional).toBe(3900);
  });

  test('SELL limits fill at the quote, release the lock, and record PnL', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]
    });
    await placeBuyLimit(user, {
      side: 'SELL',
      limitPrice: 50000,
      clientOrderId: `sell-${new mongoose.Types.ObjectId()}`
    });

    feed.setQuote('BTCUSDT', 51000);
    const stats = await matcher('worker-sell').runCycle();

    expect(stats.filled).toBe(1);
    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(5100);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }]);
    expect(after.lockedQuantities).toEqual({});

    const trade = await Trade.findOne({ userId: user._id }).lean();
    expect(trade.executionPrice).toBe(51000);
    expect(trade.realizedPnl).toBe(600);
  });

  test('orders outside the limit remain open with escrow intact', async () => {
    const user = await createTestUser({ balance: 6000 });
    await placeBuyLimit(user);

    feed.setQuote('BTCUSDT', 41000);
    const stats = await matcher('worker-ineligible').runCycle();

    expect(stats.filled).toBe(0);
    const after = await snapshotUser(user._id);
    expect(after.lockedBalance).toBe(4000);
    expect(after.portfolio).toEqual([]);
    expect(await Order.countDocuments({ userId: user._id, status: 'OPEN' })).toBe(1);
  });

  test('two workers cannot fill the same order twice', async () => {
    const user = await createTestUser({ balance: 6000 });
    await placeBuyLimit(user);
    feed.setQuote('BTCUSDT', 39000);

    const first = matcher('worker-a');
    const second = matcher('worker-b');
    const [statsA, statsB] = await Promise.all([first.runCycle(), second.runCycle()]);

    expect(statsA.filled + statsB.filled).toBe(1);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(1);
    const order = await Order.findOne({ userId: user._id }).lean();
    expect(order.status).toBe('FILLED');
    expect(order.claimedBy).toBeNull();

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(2100);
    expect(after.lockedBalance).toBe(0);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 39000 }]);
  });

  test('cancel racing a fill produces exactly one outcome', async () => {
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const user = await createTestUser({ balance: 10000 });
      const placed = await placeBuyLimit(user);
      const orderId = placed.body.pendingOrders[0]._id;
      feed.setQuote('BTCUSDT', 39000);

      const [cancel, stats] = await Promise.all([
        service.cancelOrder({ orderId, userId: user._id }),
        matcher(`race-${iteration}`).runCycle()
      ]);

      const after = await snapshotUser(user._id);
      const order = await Order.findById(orderId).lean();

      if (cancel.status === 200) {
        expect(stats.filled).toBe(0);
        expect(order.status).toBe('CANCELLED');
        expect(after.balance).toBe(10000);
        expect(after.lockedBalance).toBe(0);
        expect(after.portfolio).toEqual([]);
      } else {
        expect(cancel.status).toBe(409);
        expect(['ORDER_IN_PROGRESS', 'ORDER_ALREADY_FILLED']).toContain(cancel.body.code);
        expect(stats.filled).toBe(1);
        expect(order.status).toBe('FILLED');
        expect(after.balance).toBe(6100);
        expect(after.lockedBalance).toBe(0);
        expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 39000 }]);
      }
      expect(await Trade.countDocuments({ userId: user._id })).toBe(order.status === 'FILLED' ? 1 : 0);
    }
  });

  test('an abandoned FILLING claim is recovered after its lease expires', async () => {
    const user = await createTestUser({ balance: 6000 });
    const placed = await placeBuyLimit(user);
    const orderId = placed.body.pendingOrders[0]._id;

    await Order.updateOne(
      { _id: orderId },
      {
        $set: {
          status: 'FILLING',
          claimedBy: 'crashed-worker',
          claimedAt: new Date(now - 60000),
          leaseExpiresAt: new Date(now - 1000)
        }
      }
    );
    feed.setQuote('BTCUSDT', 39000);

    const stats = await matcher('recovery-worker').runCycle();

    expect(stats.recovered).toBe(1);
    expect(stats.filled).toBe(1);
    const after = await snapshotUser(user._id);
    expect(after.lockedBalance).toBe(0);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 39000 }]);
    const order = await Order.findById(orderId).lean();
    expect(order.status).toBe('FILLED');
    expect(order.claimedBy).toBeNull();
  });

  test('a malformed order is failed without blocking valid orders', async () => {
    const user = await createTestUser({ balance: 6000 });
    await placeBuyLimit(user);

    await Order.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      userId: user._id,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: null,
      status: 'OPEN',
      clientOrderId: 'malformed-order',
      attempts: 0,
      createdAt: new Date(now),
      updatedAt: new Date(now)
    });

    feed.setQuote('BTCUSDT', 39000);
    const stats = await matcher('malformed-worker').runCycle();

    expect(stats.filled).toBe(1);
    expect(stats.failed).toBe(1);

    const malformed = await Order.findOne({ clientOrderId: 'malformed-order' }).lean();
    expect(malformed.status).toBe('FAILED');
    expect(malformed.lastError).toMatch(/[Mm]alformed/);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(2100);
    expect(after.lockedBalance).toBe(0);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 39000 }]);
  });

  test('cycles never overlap within one matcher instance', async () => {
    const user = await createTestUser({ balance: 6000 });
    await placeBuyLimit(user);

    const worker = matcher('single-cycle');
    const first = worker.runCycle();
    const second = worker.runCycle();
    const [resultA, resultB] = await Promise.all([first, second]);

    expect(resultA.skipped).toBe(false);
    expect(resultB).toEqual({ skipped: true, reason: 'CYCLE_IN_PROGRESS' });
  });
});
