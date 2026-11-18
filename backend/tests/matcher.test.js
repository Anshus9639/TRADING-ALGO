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

  test('a failed order releases only its own reservation while the pool covers every sibling', async () => {
    const user = await createTestUser({ balance: 10000 });
    const firstKey = `sibling-a-${new mongoose.Types.ObjectId()}`;
    const secondKey = `sibling-b-${new mongoose.Types.ObjectId()}`;
    const first = await placeBuyLimit(user, { clientOrderId: firstKey });
    const second = await placeBuyLimit(user, { clientOrderId: secondKey });
    const firstOrder = await Order.findOne({ userId: user._id, clientOrderId: firstKey }).lean();
    const secondOrder = await Order.findOne({ userId: user._id, clientOrderId: secondKey }).lean();

    const failed = await service.failOrder({ orderId: firstOrder._id, error: 'cancelled by test' });

    expect(failed.status).toBe(200);
    const afterFirst = await snapshotUser(user._id);
    expect(afterFirst.balance).toBe(6000);
    expect(afterFirst.lockedBalance).toBe(4000);
    expect(first.body.success).toBe(true);
    expect(second.body.success).toBe(true);

    const sibling = await Order.findById(secondOrder._id).lean();
    expect(sibling.status).toBe('OPEN');
    expect(sibling.remainingQuantity).toBe(0.1);

    const failedTwice = await service.failOrder({ orderId: secondOrder._id });
    expect(failedTwice.status).toBe(200);
    const afterSecond = await snapshotUser(user._id);
    expect(afterSecond.balance).toBe(10000);
    expect(afterSecond.lockedBalance).toBe(0);
  });

  test('a failed order never releases funds that its sibling still needs', async () => {
    const user = await createTestUser({ balance: 10000 });
    const firstKey = `shortfall-a-${new mongoose.Types.ObjectId()}`;
    await placeBuyLimit(user, { clientOrderId: firstKey });
    await placeBuyLimit(user, { clientOrderId: `shortfall-b-${new mongoose.Types.ObjectId()}` });
    const firstOrder = await Order.findOne({ userId: user._id, clientOrderId: firstKey }).lean();

    // Simulate an accounting shortfall: lockedBalance no longer covers both
    // reservations, so ownership of the missing amount is ambiguous.
    await User.collection.updateOne({ _id: user._id }, { $set: { lockedBalance: 4000 } });

    const failed = await service.failOrder({ orderId: firstOrder._id, error: 'cycle failed' });

    expect(failed.status).toBe(200);
    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(2000);
    expect(after.lockedBalance).toBe(4000);

    const quarantined = await Order.findById(firstOrder._id).lean();
    expect(quarantined.status).toBe('FAILED');
    expect(quarantined.lastError).toMatch(/cycle failed/);
    expect(quarantined.lastError).toMatch(/escrow could not be verified/);
  });

  test('a failed SELL order unlocks only the quantity it reserved', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 40000 }]
    });
    const firstKey = `sell-a-${new mongoose.Types.ObjectId()}`;
    const first = await service.placeLimitOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.4,
      limitPrice: 60000,
      clientOrderId: firstKey
    });
    const second = await service.placeLimitOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.4,
      limitPrice: 60000,
      clientOrderId: `sell-b-${new mongoose.Types.ObjectId()}`
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstOrder = await Order.findOne({ userId: user._id, clientOrderId: firstKey }).lean();

    const failed = await service.failOrder({ orderId: firstOrder._id });

    expect(failed.status).toBe(200);
    const stored = await User.findById(user._id).lean();
    const position = stored.portfolio.find(item => item.symbol === 'BTCUSDT');
    expect(position.quantity).toBe(1);
    expect(position.lockedQuantity).toBeCloseTo(0.4, 12);
  });

  test('a SELL failure with a shortfall does not unlock its sibling holdings', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 40000 }]
    });
    const firstKey = `sell-short-a-${new mongoose.Types.ObjectId()}`;
    const first = await service.placeLimitOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.4,
      limitPrice: 60000,
      clientOrderId: firstKey
    });
    expect(first.status).toBe(200);
    await service.placeLimitOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.4,
      limitPrice: 60000,
      clientOrderId: `sell-short-b-${new mongoose.Types.ObjectId()}`
    });
    const firstOrder = await Order.findOne({ userId: user._id, clientOrderId: firstKey }).lean();

    await User.collection.updateOne(
      { _id: user._id },
      { $set: { 'portfolio.0.lockedQuantity': 0.4 } }
    );

    const failed = await service.failOrder({ orderId: firstOrder._id });

    expect(failed.status).toBe(200);
    const stored = await User.findById(user._id).lean();
    const position = stored.portfolio.find(item => item.symbol === 'BTCUSDT');
    expect(position.lockedQuantity).toBeCloseTo(0.4, 12);
    const quarantined = await Order.findById(firstOrder._id).lean();
    expect(quarantined.lastError).toMatch(/SELL escrow could not be verified/);
  });

  test('a limit fill refuses to settle with a stale execution quote', async () => {
    const user = await createTestUser({ balance: 6000 });
    const key = `stale-quote-${new mongoose.Types.ObjectId()}`;
    const placed = await placeBuyLimit(user, { clientOrderId: key });
    expect(placed.status).toBe(200);
    const order = await Order.findOne({ userId: user._id, clientOrderId: key }).lean();

    await Order.updateOne(
      { _id: order._id },
      {
        $set: {
          status: 'FILLING',
          claimedBy: 'stale-quote-worker',
          claimedAt: new Date(now),
          leaseExpiresAt: new Date(now + 30000)
        }
      }
    );

    const result = await service.fillLimitOrder({
      orderId: order._id,
      workerId: 'stale-quote-worker',
      executionQuote: { symbol: 'BTCUSDT', price: 39000, ts: now - 15001 }
    });

    expect(result.status).toBe(503);
    expect(result.code).toBe('QUOTE_UNAVAILABLE');
    expect(await Trade.countDocuments({ userId: user._id })).toBe(0);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(2000);
    expect(after.lockedBalance).toBe(4000);
  });

  test('successive batches eventually examine later eligible orders', async () => {
    const user = await createTestUser({ balance: 20000 });
    // The oldest order can never be priced in this test because ETHUSDT has no
    // quote, so it is deferred on every cycle and stays at the front.
    const deferredKey = `cursor-deferred-${new mongoose.Types.ObjectId()}`;
    const deferred = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'ETHUSDT',
      quantity: 0.1,
      limitPrice: 1000,
      clientOrderId: deferredKey
    });
    expect(deferred.status).toBe(200);

    const laterKey = `cursor-later-${new mongoose.Types.ObjectId()}`;
    const later = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 60000,
      clientOrderId: laterKey
    });
    expect(later.status).toBe(200);
    const deferredOrder = await Order.findOne({ userId: user._id, clientOrderId: deferredKey }).lean();
    const laterOrder = await Order.findOne({ userId: user._id, clientOrderId: laterKey }).lean();

    const worker = createMatcher({
      feed,
      tradeService: service,
      now: () => now,
      workerId: 'cursor-worker',
      batchSize: 1
    });

    const firstCycle = await worker.runCycle();
    expect(firstCycle.examined).toBe(1);
    expect(firstCycle.filled).toBe(0);

    // Without the rotating offset the deferred ETH order would be the only
    // candidate forever and the later BTC order could never fill.
    const secondCycle = await worker.runCycle();
    expect(secondCycle.examined).toBe(1);
    expect(secondCycle.filled).toBe(1);

    expect((await Order.findById(laterOrder._id).lean()).status).toBe('FILLED');
    expect((await Order.findById(deferredOrder._id).lean()).status).toBe('OPEN');
  });

  test('orders filled between cycles cannot shift the page and skip later orders', async () => {
    const user = await createTestUser({ balance: 30000 });
    const keys = [];
    for (let index = 0; index < 4; index += 1) {
      const key = `batch-${index}-${new mongoose.Types.ObjectId()}`;
      keys.push(key);
      const placed = await placeBuyLimit(user, {
        clientOrderId: key,
        quantity: 0.1,
        limitPrice: 60000
      });
      expect(placed.status).toBe(200);
    }

    const worker = createMatcher({
      feed,
      tradeService: service,
      now: () => now,
      workerId: 'batch-worker',
      batchSize: 2
    });

    // The first cycle removes its two orders from the eligible set. An
    // offset-based page would then skip the two remaining orders.
    const firstCycle = await worker.runCycle();
    expect(firstCycle.examined).toBe(2);
    expect(firstCycle.filled).toBe(2);

    const secondCycle = await worker.runCycle();
    expect(secondCycle.examined).toBe(2);
    expect(secondCycle.filled).toBe(2);

    const orders = await Order.find({ clientOrderId: { $in: keys } }).lean();
    expect(orders).toHaveLength(4);
    expect(orders.every(order => order.status === 'FILLED')).toBe(true);
  });

  test('new arrivals are examined after the bounded sweep completes', async () => {
    const user = await createTestUser({ balance: 10000 });
    await placeBuyLimit(user, {
      symbol: 'ETHUSDT',
      quantity: 0.1,
      limitPrice: 1000,
      clientOrderId: `arrival-deferred-${new mongoose.Types.ObjectId()}`
    });

    const worker = createMatcher({
      feed,
      tradeService: service,
      now: () => now,
      workerId: 'arrival-worker',
      batchSize: 1
    });

    // The sweep's upper bound is fixed when it starts, so the arrival is not
    // folded into the running sweep.
    const firstCycle = await worker.runCycle();
    expect(firstCycle.examined).toBe(1);
    expect(firstCycle.filled).toBe(0);

    const newKey = `arrival-new-${new mongoose.Types.ObjectId()}`;
    await placeBuyLimit(user, { clientOrderId: newKey, limitPrice: 60000 });

    const secondCycle = await worker.runCycle();
    expect(secondCycle.examined).toBe(1);
    expect(secondCycle.filled).toBe(0);

    // The sweep resets once it reaches its bound, and the next sweep examines
    // the arrival without waiting for the deferred order to change.
    const thirdCycle = await worker.runCycle();
    expect(thirdCycle.examined).toBe(1);
    expect(thirdCycle.filled).toBe(1);

    const created = await Order.findOne({ clientOrderId: newKey }).lean();
    expect(created.status).toBe('FILLED');
  });

  test('the continuation wraps around so deferred orders are revisited', async () => {
    const user = await createTestUser({ balance: 10000 });
    const deferredKey = `wrap-deferred-${new mongoose.Types.ObjectId()}`;
    await placeBuyLimit(user, {
      symbol: 'ETHUSDT',
      quantity: 0.1,
      limitPrice: 4000,
      clientOrderId: deferredKey
    });
    await placeBuyLimit(user, {
      clientOrderId: `wrap-fill-${new mongoose.Types.ObjectId()}`,
      limitPrice: 60000
    });

    const worker = createMatcher({
      feed,
      tradeService: service,
      now: () => now,
      workerId: 'wrap-worker',
      batchSize: 2
    });

    const firstCycle = await worker.runCycle();
    expect(firstCycle.examined).toBe(2);
    expect(firstCycle.filled).toBe(1);
    expect(firstCycle.deferred).toBe(1);

    // The sweep reached its fixed upper bound and reset.
    const secondCycle = await worker.runCycle();
    expect(secondCycle.examined).toBe(1);
    expect(secondCycle.filled).toBe(0);

    feed.setQuote('ETHUSDT', 3500);
    const thirdCycle = await worker.runCycle();
    expect(thirdCycle.examined).toBe(1);
    expect(thirdCycle.filled).toBe(1);

    const deferred = await Order.findOne({ clientOrderId: deferredKey }).lean();
    expect(deferred.status).toBe('FILLED');
  });

  test('continuous arrivals cannot starve a deferred order at the front', async () => {
    const user = await createTestUser({ balance: 100000 });
    const deferredKey = `starved-${new mongoose.Types.ObjectId()}`;
    await placeBuyLimit(user, {
      symbol: 'ETHUSDT',
      quantity: 0.1,
      limitPrice: 1000,
      clientOrderId: deferredKey
    });

    const worker = createMatcher({
      feed,
      tradeService: service,
      now: () => now,
      workerId: 'starvation-worker',
      batchSize: 1
    });

    // Every cycle adds a fillable arrival after the continuation key. A sweep
    // without an upper bound would keep advancing and never revisit ETH.
    const examined = [];
    for (let cycle = 0; cycle < 6; cycle += 1) {
      const stats = await worker.runCycle();
      examined.push(stats.examined);
      await placeBuyLimit(user, {
        clientOrderId: `arrival-${cycle}-${new mongoose.Types.ObjectId()}`,
        limitPrice: 60000
      });
    }

    const deferred = await Order.findOne({ clientOrderId: deferredKey }).lean();
    expect(deferred.status).toBe('OPEN');
    const filled = await Order.countDocuments({ userId: user._id, status: 'FILLED' });
    expect(filled).toBeGreaterThanOrEqual(3);
    expect(examined.every(count => count === 1)).toBe(true);
  });
});
