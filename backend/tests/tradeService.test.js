const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { symbolUniverse } = require('../services/symbolUniverse');
const { PINNED_SYMBOLS } = require('../lib/symbols');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

// Simulates the race where the pre-transaction lookup misses an order that
// becomes visible to the transaction's snapshot.
function missFirstLookup(OrderModel) {
  let skipped = false;
  return new Proxy(OrderModel, {
    get(target, property, receiver) {
      if (property !== 'findOne') return Reflect.get(target, property, receiver);
      return (filter, ...args) => {
        if (!skipped && filter && filter.clientOrderId) {
          skipped = true;
          return { lean: async () => null, session: () => ({ lean: async () => null }) };
        }
        return target.findOne(filter, ...args);
      };
    }
  });
}

describe('trade service market execution', () => {
  let feed;
  let service;
  let now;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(() => {
    now = 1_700_000_000_000;
    feed = createMarketFeed({ now: () => now });
    service = createTradeService({ feed });
  });

  let orderSeq = 0;
  function execute(params) {
    orderSeq += 1;
    return service.executeMarketOrder({ clientOrderId: `service-test-${orderSeq}`, ...params });
  }

  test('a quote inserted by the market feed is visible to the trade service', async () => {
    const user = await createTestUser({ balance: 10000 });
    expect(feed.setQuote('btcusdt', 50000)).toBe(true);

    const result = await execute({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(200);
    expect(result.body.executedPrice).toBe(50000);
    expect(result.body.balance).toBe(5000);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]);
    expect(after.trades).toEqual([
      { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, price: 50000 }
    ]);
  });

  test('rejects a missing quote with 503 without mutating the account', async () => {
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await execute({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(503);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('rejects a stale quote with 503 without mutating the account', async () => {
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    now += 15001;

    const result = await execute({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(503);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('rejects insufficient balance without mutating the account', async () => {
    const user = await createTestUser({ balance: 1000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    const result = await execute({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(400);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('prevents overselling and leaves the account untouched', async () => {
    const user = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.05, avgPrice: 50000 }]
    });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    const result = await execute({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(400);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('calculates the average entry price across buys', async () => {
    const user = await createTestUser({
      balance: 100000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 40000 }]
    });
    feed.setQuote('BTCUSDT', 50000);

    const result = await execute({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 1
    });

    expect(result.status).toBe(200);
    expect(result.body.balance).toBe(50000);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 2, avgPrice: 45000 }]);
  });

  test('sell credits the authoritative quote and preserves cost basis', async () => {
    const user = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 48000 }]
    });
    feed.setQuote('BTCUSDT', 50000);

    const result = await execute({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(200);
    expect(result.body.executedPrice).toBe(50000);
    expect(result.body.balance).toBe(15000);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([]);
    expect(after.trades).toEqual([
      { symbol: 'BTCUSDT', type: 'SELL', quantity: 0.1, price: 50000 }
    ]);
  });

  test('rejects invalid side and quantity with 400 without mutating the account', async () => {
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    const badSide = await execute({
      userId: user._id,
      side: 'HOLD',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });
    const badQuantity = await execute({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: '0.1'
    });

    expect(badSide.status).toBe(400);
    expect(badQuantity.status).toBe(400);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('requires a clientOrderId and never generates one implicitly', async () => {
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1
    });

    expect(result.status).toBe(400);
    expect(result.body.message).toMatch(/clientOrderId/);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('settles at the caller-supplied quote when it is still fresh', async () => {
    const clocked = createTradeService({ feed, now: () => now });
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);

    const result = await clocked.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'fresh-execution-quote',
      executionQuote: { symbol: 'BTCUSDT', price: 50100, ts: now }
    });

    expect(result.status).toBe(200);
    expect(result.body.executedPrice).toBe(50100);
  });

  test('rejects an execution quote that expired before settlement without mutating', async () => {
    const clocked = createTradeService({ feed, now: () => now });
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    // The feed quote is still fresh, so only the revalidation of the original
    // observation timestamp can reject this settlement.
    const result = await clocked.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'expired-execution-quote',
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now - 15001 }
    });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('PRICE_CHANGED');
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('rejects a future-dated execution quote timestamp', async () => {
    const clocked = createTradeService({ feed, now: () => now });
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    const result = await clocked.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'future-execution-quote',
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now + 1 }
    });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('PRICE_CHANGED');
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('a retry with an expired quote returns the order committed by the original attempt', async () => {
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const key = 'expired-quote-committed-retry';

    const clocked = createTradeService({ feed, now: () => now });
    const original = await clocked.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: key,
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now }
    });
    expect(original.status).toBe(200);
    const afterOriginal = await snapshotUser(user._id);

    // The pre-check misses the committed order, so the transaction's duplicate
    // lookup must run before the quote-expiry rejection to find it.
    const retryService = createTradeService({
      feed,
      now: () => now,
      Order: missFirstLookup(Order)
    });
    const retry = await retryService.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: key,
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now - 20000 }
    });

    expect(retry.status).toBe(200);
    expect(retry.body.success).toBe(true);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.executedPrice).toBe(50000);
    expect(await snapshotUser(user._id)).toEqual(afterOriginal);
    expect(await Order.countDocuments({ userId: user._id, clientOrderId: key })).toBe(1);
    expect(await Trade.countDocuments({ userId: user._id, clientOrderId: key })).toBe(1);
  });

  test('an expired quote for a genuinely new order is rejected before mutating', async () => {
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const before = await snapshotUser(user._id);

    const freshService = createTradeService({
      feed,
      now: () => now,
      Order: missFirstLookup(Order)
    });
    const result = await freshService.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'expired-quote-new-order',
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now - 20000 }
    });

    expect(result.status).toBe(409);
    expect(result.body.code).toBe('PRICE_CHANGED');
    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(0);
  });

  test('a mismatched retry for a committed order is still an idempotency conflict', async () => {
    const user = await createTestUser({ balance: 10000 });
    feed.setQuote('BTCUSDT', 50000);
    const key = 'expired-quote-conflict';

    const clocked = createTradeService({ feed, now: () => now });
    const original = await clocked.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: key,
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now }
    });
    expect(original.status).toBe(200);

    const retryService = createTradeService({
      feed,
      now: () => now,
      Order: missFirstLookup(Order)
    });
    const conflict = await retryService.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.2,
      clientOrderId: key,
      executionQuote: { symbol: 'BTCUSDT', price: 50000, ts: now - 20000 }
    });

    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(await Order.countDocuments({ userId: user._id, clientOrderId: key })).toBe(1);
  });
});

describe('dynamic universe replay', () => {
  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  afterEach(() => {
    symbolUniverse.reset();
  });

  function dynamicFeed(symbols) {
    const created = createMarketFeed({ symbols });
    created.setQuote('DOGEUSDT', 0.5);
    return created;
  }

  test('a market retry for a delisted pair replays the committed order instead of failing', async () => {
    const user = await createTestUser({ balance: 10000 });
    const symbols = [...PINNED_SYMBOLS, 'DOGEUSDT'];
    symbolUniverse.setActive(symbols);

    const service = createTradeService({ feed: dynamicFeed(symbols) });
    const params = {
      userId: user._id,
      side: 'BUY',
      symbol: 'DOGEUSDT',
      quantity: 100,
      clientOrderId: 'retry-delisted-market'
    };

    const original = await service.executeMarketOrder(params);
    expect(original.status).toBe(200);

    symbolUniverse.setActive(PINNED_SYMBOLS);
    const afterShrink = createTradeService({ feed: dynamicFeed(PINNED_SYMBOLS) });

    const retry = await afterShrink.executeMarketOrder(params);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(1);

    const newOrder = await afterShrink.executeMarketOrder({
      ...params,
      clientOrderId: 'new-order-after-delist'
    });
    expect(newOrder.status).toBe(400);
    expect(newOrder.body.message).toContain('Unsupported symbol');
  });

  test('a limit retry for a delisted pair replays without reserving escrow twice', async () => {
    const user = await createTestUser({ balance: 1000 });
    const symbols = [...PINNED_SYMBOLS, 'DOGEUSDT'];
    symbolUniverse.setActive(symbols);

    const service = createTradeService({ feed: dynamicFeed(symbols) });
    const params = {
      userId: user._id,
      side: 'BUY',
      symbol: 'DOGEUSDT',
      quantity: 100,
      limitPrice: 0.4,
      clientOrderId: 'retry-delisted-limit'
    };

    const original = await service.placeLimitOrder(params);
    expect(original.status).toBe(200);
    const beforeRetry = await snapshotUser(user._id);
    expect(beforeRetry.lockedBalance).toBe(40);

    symbolUniverse.setActive(PINNED_SYMBOLS);
    const afterShrink = createTradeService({ feed: dynamicFeed(PINNED_SYMBOLS) });

    const retry = await afterShrink.placeLimitOrder(params);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(await snapshotUser(user._id)).toEqual(beforeRetry);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });
});
