const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

describe('transactional financial integrity', () => {
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
    feed.setQuote('ETHUSDT', 3000);
    feed.setQuote('SOLUSDT', 150);
    feed.setQuote('BNBUSDT', 600);
    service = createTradeService({ feed, now: () => now });
  });

  test('20 parallel market BUYs with funds for exactly 5 execute 5 times', async () => {
    const user = await createTestUser({ balance: 25000 });

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      service.executeMarketOrder({
        userId: user._id,
        side: 'BUY',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        clientOrderId: `parallel-market-buy-${index}`
      })
    )));

    expect(results.filter(result => result.status === 200)).toHaveLength(5);
    expect(results.filter(result => result.status === 400)).toHaveLength(15);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(0);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.5, avgPrice: 50000 }]);
    expect(after.trades).toHaveLength(5);
    expect(await Order.countDocuments({ userId: user._id, status: 'FILLED' })).toBe(5);
    expect(after.balance).toBeGreaterThanOrEqual(0);
  });

  test('20 parallel market SELLs can never exceed available holdings', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.5, avgPrice: 45000 }]
    });

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      service.executeMarketOrder({
        userId: user._id,
        side: 'SELL',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        clientOrderId: `parallel-market-sell-${index}`
      })
    )));

    expect(results.filter(result => result.status === 200)).toHaveLength(5);
    expect(results.filter(result => result.status === 400)).toHaveLength(15);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(25000);
    expect(after.portfolio).toEqual([]);
    expect(after.trades).toHaveLength(5);
    expect(after.portfolio.every(position => position.quantity >= 0)).toBe(true);
  });

  test('20 parallel BUY limits with funds for exactly 5 reserve only 5', async () => {
    const user = await createTestUser({ balance: 20000 });

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      service.placeLimitOrder({
        userId: user._id,
        side: 'BUY',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        limitPrice: 40000,
        clientOrderId: `parallel-limit-buy-${index}`
      })
    )));

    expect(results.filter(result => result.status === 200)).toHaveLength(5);
    expect(results.filter(result => result.status === 400)).toHaveLength(15);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(0);
    expect(after.lockedBalance).toBe(20000);
    expect(after.pendingOrders).toHaveLength(5);

    const openReserve = (await Order.find({ userId: user._id, status: 'OPEN', side: 'BUY' }).lean())
      .reduce((sum, order) => sum + (order.quantity * order.limitPrice), 0);
    expect(openReserve).toBe(after.lockedBalance);
  });

  test('20 parallel SELL limits can never lock more than owned', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.5, avgPrice: 45000 }]
    });

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (
      service.placeLimitOrder({
        userId: user._id,
        side: 'SELL',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        limitPrice: 60000,
        clientOrderId: `parallel-limit-sell-${index}`
      })
    )));

    expect(results.filter(result => result.status === 200)).toHaveLength(5);
    expect(results.filter(result => result.status === 400)).toHaveLength(15);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.5, avgPrice: 45000 }]);
    expect(after.lockedQuantities).toEqual({ BTCUSDT: 0.5 });
    expect(after.trades).toEqual([]);
  });

  test('locks always reconcile with open orders and cancels refund exactly once', async () => {
    const user = await createTestUser({
      balance: 20000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]
    });

    const buy = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'reconcile-buy'
    });
    const buySmall = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.05,
      limitPrice: 30000,
      clientOrderId: 'reconcile-buy-small'
    });
    const sell = await service.placeLimitOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 60000,
      clientOrderId: 'reconcile-sell'
    });
    const sellSmall = await service.placeLimitOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.05,
      limitPrice: 70000,
      clientOrderId: 'reconcile-sell-small'
    });

    for (const result of [buy, buySmall, sell, sellSmall]) {
      expect(result.status).toBe(200);
    }

    let after = await snapshotUser(user._id);
    expect(after.balance).toBe(14500);
    expect(after.lockedBalance).toBe(5500);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]);
    expect(after.lockedQuantities).toEqual({ BTCUSDT: 0.15 });

    const buyOrder = await Order.findOne({ clientOrderId: 'reconcile-buy' }).lean();
    expect((await service.cancelOrder({ orderId: buyOrder._id, userId: user._id })).status).toBe(200);
    after = await snapshotUser(user._id);
    expect(after.balance).toBe(18500);
    expect(after.lockedBalance).toBe(1500);

    // Idempotent cancel must not refund twice.
    expect((await service.cancelOrder({ orderId: buyOrder._id, userId: user._id })).status).toBe(200);
    after = await snapshotUser(user._id);
    expect(after.balance).toBe(18500);
    expect(after.lockedBalance).toBe(1500);

    const sellOrder = await Order.findOne({ clientOrderId: 'reconcile-sell' }).lean();
    expect((await service.cancelOrder({ orderId: sellOrder._id, userId: user._id })).status).toBe(200);
    after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]);
    expect(after.lockedQuantities).toEqual({ BTCUSDT: 0.05 });
  });

  test('market BUYs keep existing average entry price correct', async () => {
    const user = await createTestUser({
      balance: 100000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 40000 }]
    });

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 1,
      clientOrderId: 'aep-buy'
    });

    expect(result.status).toBe(200);
    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 2, avgPrice: 45000 }]);
  });

  test('market SELL records realized PnL against cost basis', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]
    });

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'pnl-sell'
    });

    expect(result.status).toBe(200);
    const trade = await Trade.findOne({ clientOrderId: 'pnl-sell' }).lean();
    expect(trade.realizedPnl).toBe(500);
    expect(trade.notional).toBe(5000);
  });

  test('the same clientOrderId executes a market order once and returns the same result', async () => {
    const user = await createTestUser({ balance: 10000 });

    const first = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'retry-market-1'
    });
    const retry = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'retry-market-1'
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.executedPrice).toBe(first.body.executedPrice);
    expect(retry.body.newTrade._id).toEqual(first.body.newTrade._id);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(5000);
    expect(after.trades).toHaveLength(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('parallel retries with one clientOrderId still execute once', async () => {
    const user = await createTestUser({ balance: 10000 });

    const results = await Promise.all(Array.from({ length: 5 }, () => (
      service.executeMarketOrder({
        userId: user._id,
        side: 'BUY',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        clientOrderId: 'parallel-same-key'
      })
    )));

    expect(results.every(result => result.status === 200)).toBe(true);
    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(5000);
    expect(after.trades).toHaveLength(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('the same clientOrderId reserves a limit order once', async () => {
    const user = await createTestUser({ balance: 10000 });

    const first = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'retry-limit-1'
    });
    const retry = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'retry-limit-1'
    });

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(6000);
    expect(after.lockedBalance).toBe(4000);
    expect(after.pendingOrders).toHaveLength(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('invalid clientOrderId values are rejected before any mutation', async () => {
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'bad key with spaces'
    });

    expect(result.status).toBe(400);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('reusing a key with different market parameters is a conflict', async () => {
    const user = await createTestUser({ balance: 10000 });

    const first = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'mismatch-market-1'
    });
    const mismatched = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.2,
      clientOrderId: 'mismatch-market-1'
    });

    expect(first.status).toBe(200);
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(5000);
    expect(after.trades).toHaveLength(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('reusing a key with different limit parameters is a conflict', async () => {
    const user = await createTestUser({ balance: 10000 });

    const first = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'mismatch-limit-1'
    });
    const mismatched = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 45000,
      clientOrderId: 'mismatch-limit-1'
    });

    expect(first.status).toBe(200);
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(6000);
    expect(after.lockedBalance).toBe(4000);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('a journal failure rolls the entire market trade back', async () => {
    class FailingTrade {
      constructor(document) {
        Object.assign(this, document);
        this._id = new mongoose.Types.ObjectId();
      }

      async save() {
        throw new Error('forced journal failure');
      }

      static async findOne() {
        return null;
      }
    }

    const failingService = createTradeService({
      feed,
      Trade: FailingTrade,
      now: () => now
    });
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    await expect(failingService.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'rollback-market'
    })).rejects.toThrow('forced journal failure');

    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(0);
  });

  test('a journal failure rolls limit escrow back', async () => {
    class FailingOrder {
      constructor(document) {
        Object.assign(this, document);
        this._id = new mongoose.Types.ObjectId();
      }

      async save() {
        throw new Error('forced order failure');
      }

      static findOne() {
        const query = {
          session() { return query; },
          async lean() { return null; }
        };
        return query;
      }

      static find() {
        return {
          sort() { return this; },
          session() { return this; },
          async lean() { return []; }
        };
      }
    }

    const failingService = createTradeService({
      feed,
      Order: FailingOrder,
      now: () => now
    });
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    await expect(failingService.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'rollback-limit'
    })).rejects.toThrow('forced order failure');

    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
  });
});
