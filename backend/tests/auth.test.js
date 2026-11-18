const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { createApp } = require('../app');
const User = require('../models/User');
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

  test('session restoration never loads the password hash', async () => {
    const user = await createLoginUser({ username: 'projection-user' });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: PASSWORD });

    const me = await request(app)
      .get('/api/auth/me')
      .set('x-auth-token', login.body.token);

    expect(me.status).toBe(200);
    expect(me.body).not.toHaveProperty('password');
    expect(me.body.username).toBe('projection-user');
    expect(me.body.email).toBe(user.email);

    // The legacy identity hash receives user._id from this document. Loading an
    // allowlist projection keeps the hash and its analysis out of the flow
    // instead of relying on a password-omitting `select`.
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'auth.js'), 'utf8');
    expect(source).not.toMatch(/\.select\(/);
    expect(source).toMatch(/findById\(req\.user\.id, ACCOUNT_VIEW_FIELDS\)/);
    const declaration = source.match(/const ACCOUNT_VIEW_FIELDS = '([^']*)'/);
    expect(declaration).not.toBeNull();
    expect(declaration[1]).not.toMatch(/password/i);
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

  test('rejects NoSQL operator objects on login and signup', async () => {
    const user = await createLoginUser({ balance: 10000 });
    const before = await User.countDocuments({});
    const payloads = [{ $ne: null }, { $gt: '' }, ['a@b.test'], 42, null, ''];

    for (const email of payloads) {
      const login = await request(app)
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });

      expect(login.status).toBe(400);
      expect(login.body.token).toBeUndefined();

      const signup = await request(app)
        .post('/api/auth/signup')
        .send({ username: 'injection', email, password: PASSWORD });

      expect(signup.status).toBe(400);
    }

    const objectPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: { $ne: null } });

    expect(objectPassword.status).toBe(400);
    expect(objectPassword.body.token).toBeUndefined();
    expect(await User.countDocuments({})).toBe(before);
  });

  test('rejects malformed and oversized credentials', async () => {
    const malformedEmails = ['not-an-email', 'two@at@example.test', '@example.test', `${'a'.repeat(250)}@example.test`];
    for (const email of malformedEmails) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email, password: PASSWORD });
      expect(res.status).toBe(400);
    }

    // A dotted domain is still required when an account is created.
    const dotlessSignup = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'dotless', email: 'legacy@localhost', password: PASSWORD });
    expect(dotlessSignup.status).toBe(400);

    const oversizedPassword = await request(app)
      .post('/api/auth/signup')
      .send({ username: 'too-long', email: 'too-long@example.test', password: 'x'.repeat(73) });
    expect(oversizedPassword.status).toBe(400);
  });

  test('an existing account with a local-only email domain can still log in', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 4);
    const legacyEmail = `legacy-${Date.now()}@localhost`;
    // Bypass signup validation: such accounts were created before the rule.
    await User.create({
      username: 'legacy-local',
      email: legacyEmail,
      password: passwordHash,
      balance: 10000
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: legacyEmail, password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const me = await request(app)
      .get('/api/auth/me')
      .set('x-auth-token', login.body.token);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(legacyEmail);

    // Login still refuses non-string selectors and malformed addresses.
    const operator = await request(app)
      .post('/api/auth/login')
      .send({ email: { $ne: null }, password: PASSWORD });
    expect(operator.status).toBe(400);
  });

  test('enforces the signup password limit in UTF-8 bytes', async () => {
    const accepted = [
      { username: 'bytes-72-ascii', email: 'bytes-72-ascii@example.test', password: 'a'.repeat(72) },
      { username: 'bytes-72-utf8', email: 'bytes-72-utf8@example.test', password: 'é'.repeat(36) }
    ];
    for (const payload of accepted) {
      const res = await request(app).post('/api/auth/signup').send(payload);
      expect(res.status).toBe(200);
      expect(await User.findOne({ email: payload.email })).toBeTruthy();
    }

    const rejected = [
      { username: 'bytes-73-ascii', email: 'bytes-73-ascii@example.test', password: 'a'.repeat(73) },
      { username: 'bytes-73-utf8', email: 'bytes-73-utf8@example.test', password: `${'é'.repeat(36)}A` }
    ];
    for (const payload of rejected) {
      expect(Buffer.byteLength(payload.password, 'utf8')).toBe(73);
      const res = await request(app).post('/api/auth/signup').send(payload);
      expect(res.status).toBe(400);
      expect(await User.findOne({ email: payload.email })).toBeNull();
    }
  });

  test('logs in legacy accounts whose password exceeds 72 characters', async () => {
    const legacyPassword = `${'x'.repeat(100)}-legacy`;
    const passwordHash = await bcrypt.hash(legacyPassword, 4);
    const user = await createTestUser({ username: 'legacy-user', password: passwordHash });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: legacyPassword });

    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const invalidPasswords = [undefined, '', { $ne: null }, [], 42];
    for (const password of invalidPasswords) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password });
      expect(res.status).toBe(400);
      expect(res.body.token).toBeUndefined();
    }

    const wrongLongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'y'.repeat(80) });
    expect(wrongLongPassword.status).toBe(400);
    expect(wrongLongPassword.body.token).toBeUndefined();
  });

  test('normalizes email for signup and login', async () => {
    const signup = await request(app)
      .post('/api/auth/signup')
      .send({
        username: '  normalized-user  ',
        email: '  Normalized.User@Example.Test  ',
        password: PASSWORD
      });

    expect(signup.status).toBe(200);

    const stored = await User.findOne({ email: 'normalized.user@example.test' });
    expect(stored).toBeTruthy();
    expect(stored.username).toBe('normalized-user');

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: '  NORMALIZED.USER@EXAMPLE.TEST  ', password: PASSWORD });

    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();

    const duplicate = await request(app)
      .post('/api/auth/signup')
      .send({
        username: 'duplicate',
        email: 'normalized.user@example.test',
        password: PASSWORD
      });
    expect(duplicate.status).toBe(400);
  });
});
