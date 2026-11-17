const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

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
});
