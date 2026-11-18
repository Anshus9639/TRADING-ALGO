const crypto = require('crypto');
const request = require('supertest');
const { app: defaultApp, createApp } = require('../app');
const { createMarketFeed, setQuote, reset } = require('../services/marketFeed');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  authToken,
  snapshotUser
} = require('./helpers');

// Manual orders now require a UUID idempotency key; individual tests that
// exercise the key contract override it explicitly.
function postTrade(app, token, path, body = {}) {
  return request(app)
    .post(path)
    .set('x-auth-token', token)
    .send({ clientOrderId: crypto.randomUUID(), ...body });
}

describe('trade routes', () => {
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

  describe('market orders', () => {
    test('the default app shares the singleton feed used by the ticker bridge', async () => {
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);

      setQuote('ETHUSDT', 3000);
      try {
        const res = await postTrade(defaultApp, token, '/api/trade/buy', {
          symbol: 'ETHUSDT',
          quantity: 1
        });

        expect(res.status).toBe(200);
        expect(res.body.executedPrice).toBe(3000);
        expect(res.body.balance).toBe(7000);
      } finally {
        reset();
      }
    });

    test('ignores a client price of 0 and executes at the server quote', async () => {
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);

      const res = await postTrade(app, token, '/api/trade/buy', {
        symbol: 'BTCUSDT',
        quantity: 0.1,
        price: 0
      });

      expect(res.status).toBe(200);
      expect(res.body.executedPrice).toBe(50000);
      expect(res.body.balance).toBe(5000);

      const after = await snapshotUser(user._id);
      expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]);
      expect(after.trades).toEqual([
        { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, price: 50000 }
      ]);
    });

    test('ignores a client price of 100000 on sells', async () => {
      const user = await createTestUser({
        balance: 10000,
        portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]
      });
      const token = authToken(user);

      const res = await postTrade(app, token, '/api/trade/sell', {
        symbol: 'BTCUSDT',
        quantity: 0.1,
        price: 100000
      });

      expect(res.status).toBe(200);
      expect(res.body.executedPrice).toBe(50000);
      expect(res.body.balance).toBe(15000);

      const after = await snapshotUser(user._id);
      expect(after.portfolio).toEqual([]);
      expect(after.trades).toEqual([
        { symbol: 'BTCUSDT', type: 'SELL', quantity: 0.1, price: 50000 }
      ]);
    });

    test('returns 503 for a missing quote without mutating the account', async () => {
      const emptyApp = createApp({ feed: createMarketFeed() });
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await postTrade(emptyApp, token, '/api/trade/buy', {
        symbol: 'BTCUSDT',
        quantity: 0.1
      });

      expect(res.status).toBe(503);
      expect(await snapshotUser(user._id)).toEqual(before);
    });

    test('returns 503 for a stale quote without mutating the account', async () => {
      const clock = { now: 1_700_000_000_000 };
      const staleFeed = createMarketFeed({ now: () => clock.now });
      const staleApp = createApp({ feed: staleFeed });
      staleFeed.setQuote('BTCUSDT', 50000);
      clock.now += 15001;

      const user = await createTestUser({
        balance: 10000,
        portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]
      });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await postTrade(staleApp, token, '/api/trade/sell', {
        symbol: 'BTCUSDT',
        quantity: 0.1
      });

      expect(res.status).toBe(503);
      expect(await snapshotUser(user._id)).toEqual(before);
    });

    test('rejects invalid quantities without mutating the account', async () => {
      for (const quantity of [0, -1, '0.1', null]) {
        const user = await createTestUser({ balance: 10000 });
        const token = authToken(user);
        const before = await snapshotUser(user._id);

        const res = await postTrade(app, token, '/api/trade/buy', {
          symbol: 'BTCUSDT',
          quantity
        });

        expect(res.status).toBe(400);
        expect(await snapshotUser(user._id)).toEqual(before);
      }
    });

    test('rejects unsupported symbols without mutating the account', async () => {
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await postTrade(app, token, '/api/trade/buy', {
        symbol: 'DOGEUSDT',
        quantity: 1
      });

      expect(res.status).toBe(400);
      expect(await snapshotUser(user._id)).toEqual(before);
    });

    test('rejects insufficient balance without mutating the account', async () => {
      const user = await createTestUser({ balance: 1000 });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await postTrade(app, token, '/api/trade/buy', {
        symbol: 'BTCUSDT',
        quantity: 0.1
      });

      expect(res.status).toBe(400);
      expect(await snapshotUser(user._id)).toEqual(before);
    });

    test('rejects selling more than owned without mutating the account', async () => {
      const user = await createTestUser({
        balance: 10000,
        portfolio: [{ symbol: 'BTCUSDT', quantity: 0.05, avgPrice: 50000 }]
      });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await postTrade(app, token, '/api/trade/sell', {
        symbol: 'BTCUSDT',
        quantity: 0.1
      });

      expect(res.status).toBe(400);
      expect(await snapshotUser(user._id)).toEqual(before);
    });
  });

  describe('limit orders', () => {
    test('rejects invalid limit orders without mutating the account', async () => {
      const invalidOrders = [
        { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, limitPrice: -1000 },
        { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, limitPrice: 0 },
        { symbol: 'BTCUSDT', type: 'BUY', quantity: -1, limitPrice: 40000 },
        { symbol: 'BTCUSDT', type: 'BUY', quantity: 0, limitPrice: 40000 },
        { symbol: 'DOGEUSDT', type: 'BUY', quantity: 0.1, limitPrice: 1 },
        { symbol: 'BTCUSDT', type: 'HOLD', quantity: 0.1, limitPrice: 40000 },
        { symbol: 'BTCUSDT', type: 'buy', quantity: 0.1, limitPrice: 40000 },
        { symbol: 'BTCUSDT', type: 'BUY', quantity: 1, limitPrice: 50000 },
        { symbol: 'BTCUSDT', type: 'SELL', quantity: 0.1, limitPrice: 40000 }
      ];

      for (const body of invalidOrders) {
        const user = await createTestUser({ balance: 10000 });
        const token = authToken(user);
        const before = await snapshotUser(user._id);

        const res = await postTrade(app, token, '/api/trade/limit', body);

        expect(res.status).toBe(400);
        expect(await snapshotUser(user._id)).toEqual(before);
      }
    });

    test('rejects an unknown side instead of treating it as SELL', async () => {
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await postTrade(app, token, '/api/trade/limit', {
        symbol: 'BTCUSDT',
        type: 'HOLD',
        quantity: 0.1,
        limitPrice: 40000
      });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/BUY or SELL/);
      expect(await snapshotUser(user._id)).toEqual(before);
    });

    test('escrows a valid BUY limit order and refunds it on cancel', async () => {
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);

      const res = await postTrade(app, token, '/api/trade/limit', {
        symbol: 'BTCUSDT',
        type: 'BUY',
        quantity: 0.1,
        limitPrice: 40000
      });

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(6000);

      const reserved = await snapshotUser(user._id);
      expect(reserved.lockedBalance).toBe(4000);

      const orderId = res.body.pendingOrders[0]._id;
      const cancelRes = await request(app)
        .delete(`/api/trade/cancel/${orderId}`)
        .set('x-auth-token', token);

      expect(cancelRes.status).toBe(200);

      const after = await snapshotUser(user._id);
      expect(after.balance).toBe(10000);
      expect(after.lockedBalance).toBe(0);
      expect(after.pendingOrders).toEqual([]);
    });

    test('escrows a valid SELL limit order and refunds the asset on cancel', async () => {
      const user = await createTestUser({
        balance: 10000,
        portfolio: [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]
      });
      const token = authToken(user);

      const res = await postTrade(app, token, '/api/trade/limit', {
        symbol: 'BTCUSDT',
        type: 'SELL',
        quantity: 0.1,
        limitPrice: 60000
      });

      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(10000);

      const escrowed = await snapshotUser(user._id);
      expect(escrowed.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]);
      expect(escrowed.lockedQuantities).toEqual({ BTCUSDT: 0.1 });

      const orderId = res.body.pendingOrders[0]._id;
      const cancelRes = await request(app)
        .delete(`/api/trade/cancel/${orderId}`)
        .set('x-auth-token', token);

      expect(cancelRes.status).toBe(200);

      const after = await snapshotUser(user._id);
      expect(after.balance).toBe(10000);
      expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]);
      expect(after.lockedQuantities).toEqual({});
      expect(after.pendingOrders).toEqual([]);
    });
  });
});
