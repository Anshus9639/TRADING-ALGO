const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { createApp } = require('../app');
const { createMarketFeed } = require('../services/marketFeed');
const {
  startTestDb,
  stopTestDb,
  createTestUser
} = require('./helpers');

const PASSWORD = 'correct-horse-battery-staple';

async function createLoginUser(overrides = {}) {
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  return createTestUser({ password: passwordHash, ...overrides });
}

describe('authentication and session restoration', () => {
  let app;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(() => {
    app = createApp({ feed: createMarketFeed() });
  });

  test('login signs a verifiable token and returns empty pendingOrders', async () => {
    const user = await createLoginUser({ balance: 10000 });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
    expect(login.body.user.balance).toBe(10000);
    expect(login.body.user.portfolio).toEqual([]);
    expect(login.body.user.trades).toEqual([]);
    expect(login.body.user.pendingOrders).toEqual([]);

    const me = await request(app)
      .get('/api/auth/me')
      .set('x-auth-token', login.body.token);

    expect(me.status).toBe(200);
    expect(me.body.pendingOrders).toEqual([]);
  });

  test('pending limit orders survive login and session refresh', async () => {
    const user = await createLoginUser({ balance: 10000 });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const token = login.body.token;

    const limitRes = await request(app)
      .post('/api/trade/limit')
      .set('x-auth-token', token)
      .send({
        symbol: 'BTCUSDT',
        type: 'BUY',
        quantity: 0.1,
        limitPrice: 40000,
        clientOrderId: 'b3a1c9f0-6f5e-4f4e-9c2a-3d8b7e1a2c4d'
      });

    expect(limitRes.status).toBe(200);

    const me = await request(app)
      .get('/api/auth/me')
      .set('x-auth-token', token);

    expect(me.status).toBe(200);
    expect(me.body.balance).toBe(6000);
    expect(me.body.pendingOrders).toHaveLength(1);
    expect(me.body.pendingOrders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.1,
      limitPrice: 40000
    });
    expect(me.body.pendingOrders[0]._id).toBeTruthy();
    expect(me.body.pendingOrders[0].timestamp).toBeTruthy();

    const relogin = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    expect(relogin.status).toBe(200);
    expect(relogin.body.user.pendingOrders).toHaveLength(1);
    expect(relogin.body.user.pendingOrders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.1,
      limitPrice: 40000
    });
  });

  test('rejects tampered tokens and tokens signed with the old fallback secret', async () => {
    const user = await createLoginUser({ balance: 10000 });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const tampered = `${login.body.token}x`;
    const tamperedRes = await request(app)
      .get('/api/auth/me')
      .set('x-auth-token', tampered);

    expect(tamperedRes.status).toBe(401);

    const legacyToken = jwt.sign(
      { user: { id: user._id } },
      'NexusTrade_Secret_Key',
      { expiresIn: '1h' }
    );
    const legacyRes = await request(app)
      .get('/api/auth/me')
      .set('x-auth-token', legacyToken);

    expect(legacyRes.status).toBe(401);
  });

  test('copilot returns a controlled 503 when Gemini is not configured', async () => {
    const user = await createLoginUser({ balance: 10000 });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const res = await request(app)
        .post('/api/copilot/parse')
        .set('x-auth-token', login.body.token)
        .send({ prompt: 'Buy 0.1 BTC' });

      expect(res.status).toBe(503);
      expect(res.body.message).toMatch(/not configured/);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('returns a controlled error when the JWT secret is unavailable', async () => {
    const user = await createLoginUser({ balance: 10000 });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const originalSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;

    try {
      const res = await request(app)
        .get('/api/auth/me')
        .set('x-auth-token', login.body.token);

      expect(res.status).toBe(500);
      expect(res.body.msg).toMatch(/not configured/);
    } finally {
      process.env.JWT_SECRET = originalSecret;
    }
  });
});
