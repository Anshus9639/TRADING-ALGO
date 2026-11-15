const crypto = require('crypto');
const request = require('supertest');
const { createApp } = require('../app');
const { createMarketFeed } = require('../services/marketFeed');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  authToken,
  snapshotUser
} = require('./helpers');

describe('manual order idempotency contract', () => {
  let feed;
  let app;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(() => {
    feed = createMarketFeed();
    app = createApp({ feed });
    feed.setQuote('BTCUSDT', 50000);
  });

  function post(token, path, body) {
    return request(app).post(path).set('x-auth-token', token).send(body);
  }

  test('every manual endpoint rejects a missing clientOrderId with 400', async () => {
    const user = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 50000 }]
    });
    const token = authToken(user);
    const before = await snapshotUser(user._id);

    const responses = await Promise.all([
      post(token, '/api/trade/buy', { symbol: 'BTCUSDT', quantity: 0.1 }),
      post(token, '/api/trade/sell', { symbol: 'BTCUSDT', quantity: 0.1 }),
      post(token, '/api/trade/limit', { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, limitPrice: 40000 }),
      post(token, '/api/trade/limit', { symbol: 'BTCUSDT', type: 'SELL', quantity: 0.1, limitPrice: 60000 })
    ]);

    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CLIENT_ORDER_ID');
    }
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('invalid non-UUID keys are rejected before any mutation', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const before = await snapshotUser(user._id);

    const responses = await Promise.all([
      post(token, '/api/trade/buy', { symbol: 'BTCUSDT', quantity: 0.1, clientOrderId: 'order-123' }),
      post(token, '/api/trade/limit', {
        symbol: 'BTCUSDT',
        type: 'BUY',
        quantity: 0.1,
        limitPrice: 40000,
        clientOrderId: 'not-a-uuid'
      })
    ]);

    for (const res of responses) {
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CLIENT_ORDER_ID');
    }
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('retrying the same UUID returns the original market execution', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const clientOrderId = crypto.randomUUID();

    const first = await post(token, '/api/trade/buy', {
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId
    });
    const retry = await post(token, '/api/trade/buy', {
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId
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

  test('retrying the same UUID returns the original limit reservation', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const clientOrderId = crypto.randomUUID();
    const body = { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, limitPrice: 40000, clientOrderId };

    const first = await post(token, '/api/trade/limit', body);
    const retry = await post(token, '/api/trade/limit', body);

    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(6000);
    expect(after.lockedBalance).toBe(4000);
    expect(after.pendingOrders).toHaveLength(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('reusing a UUID with different parameters returns 409 and one trade', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const clientOrderId = crypto.randomUUID();

    const first = await post(token, '/api/trade/buy', {
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId
    });
    const mismatched = await post(token, '/api/trade/buy', {
      symbol: 'BTCUSDT',
      quantity: 0.2,
      clientOrderId
    });
    const wrongSide = await post(token, '/api/trade/sell', {
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId
    });

    expect(first.status).toBe(200);
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(wrongSide.status).toBe(409);
    expect(wrongSide.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(5000);
    expect(after.trades).toHaveLength(1);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(1);
  });

  test('a deliberately different trade uses a different UUID', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const first = await post(token, '/api/trade/buy', {
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: crypto.randomUUID()
    });
    const second = await post(token, '/api/trade/buy', {
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: crypto.randomUUID()
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.newTrade._id).not.toEqual(first.body.newTrade._id);

    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(0);
    expect(after.trades).toHaveLength(2);
    expect(await Order.countDocuments({ userId: user._id })).toBe(2);
  });
});
