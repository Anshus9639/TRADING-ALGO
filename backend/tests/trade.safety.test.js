const request = require('supertest');
const { createApp } = require('../app');
const { createMarketFeed } = require('../services/marketFeed');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  authToken,
  snapshotUser
} = require('./helpers');

/**
 * A1 regression tests, updated in A3 to assert the secure contract.
 * Market execution price comes exclusively from the server-side market feed;
 * client-supplied prices are ignored.
 */
describe('Trade safety regressions (secure contract)', () => {
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

  test('VULN-1: market BUY at client price 0 then SELL at 100000 cannot create capital', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const before = await snapshotUser(user._id);

    const buyRes = await request(app)
      .post('/api/trade/buy')
      .set('x-auth-token', token)
      .send({
        symbol: 'BTCUSDT',
        quantity: 0.1,
        price: 0,
        clientOrderId: '5f2a4c7e-1b9d-4a3e-8c6f-0d2e4b6a8c1f'
      });

    const afterBuy = await snapshotUser(user._id);

    const sellRes = await request(app)
      .post('/api/trade/sell')
      .set('x-auth-token', token)
      .send({
        symbol: 'BTCUSDT',
        quantity: 0.1,
        price: 100000,
        clientOrderId: '9c8b7a6d-5e4f-4a3b-9c2d-1e0f3a5b7c9d'
      });

    const afterSell = await snapshotUser(user._id);

    console.log('[VULN-1] before        :', JSON.stringify(before));
    console.log('[VULN-1] buy  HTTP', buyRes.status, ':', JSON.stringify(afterBuy));
    console.log('[VULN-1] sell HTTP', sellRes.status, ':', JSON.stringify(afterSell));

    expect(buyRes.status).toBe(200);
    expect(buyRes.body.executedPrice).toBe(50000);
    expect(afterBuy.balance).toBe(5000);
    expect(afterBuy.portfolio).toEqual([
      { symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }
    ]);

    expect(sellRes.status).toBe(200);
    expect(sellRes.body.executedPrice).toBe(50000);
    expect(afterSell.balance).toBe(before.balance);
    expect(afterSell.portfolio).toEqual([]);
    expect(afterSell.trades).toEqual([
      { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, price: 50000 },
      { symbol: 'BTCUSDT', type: 'SELL', quantity: 0.1, price: 50000 }
    ]);
  });

  test('VULN-2: LIMIT BUY with negative limitPrice is rejected without mutation', async () => {
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const before = await snapshotUser(user._id);

    const res = await request(app)
      .post('/api/trade/limit')
      .set('x-auth-token', token)
      .send({
        symbol: 'BTCUSDT',
        type: 'BUY',
        quantity: 1,
        limitPrice: -1000,
        clientOrderId: '2d4f6a8c-0e1b-4c3d-8a5f-7b9d1e2f3a4c'
      });

    const after = await snapshotUser(user._id);

    console.log('[VULN-2] before        :', JSON.stringify(before));
    console.log('[VULN-2] limit HTTP', res.status, ':', JSON.stringify(after));

    expect(res.status).toBe(400);
    expect(after).toEqual(before);
  });
});
