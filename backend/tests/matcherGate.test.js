const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../app');
const { createMarketFeed } = require('../services/marketFeed');
const { createRuntimeStatus } = require('../services/runtimeStatus');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  authToken,
  snapshotUser
} = require('./helpers');

function operationalRuntime() {
  const runtime = createRuntimeStatus();
  runtime.setStartupComplete(true);
  runtime.setMongoConnected(true);
  runtime.setTransactionsVerified(true);
  runtime.setIndexesVerified(true);
  runtime.setLegacyGateClear(true);
  runtime.markMatcherActive();
  return runtime;
}

function postLimit(app, token, overrides = {}) {
  return request(app)
    .post('/api/trade/limit')
    .set('x-auth-token', token)
    .send({
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: crypto.randomUUID(),
      ...overrides
    });
}

describe('limit orders gated on matcher readiness', () => {
  let feed;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
    feed = createMarketFeed();
    feed.setQuote('BTCUSDT', 50000);
  });

  test('a blocked matcher rejects new LIMIT orders with MATCHER_NOT_READY and no mutation', async () => {
    const runtime = createRuntimeStatus();
    runtime.setMongoConnected(true);
    runtime.setTransactionsVerified(true);
    const app = createApp({ feed, runtimeStatus: runtime });
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const res = await postLimit(app, authToken(user));

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      code: 'MATCHER_NOT_READY'
    });
    expect(res.body.message).toMatch(/matching engine is not operational/i);

    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments()).toBe(0);
  });

  test('a legacy gate loss blocks new LIMIT orders but not market or cancel', async () => {
    const runtime = operationalRuntime();
    const app = createApp({ feed, runtimeStatus: runtime });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    runtime.setLegacyGateClear(false);
    const before = await snapshotUser(user._id);

    const blocked = await postLimit(app, token);
    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe('MATCHER_NOT_READY');
    expect(await snapshotUser(user._id)).toEqual(before);

    const market = await request(app)
      .post('/api/trade/buy')
      .set('x-auth-token', token)
      .send({ symbol: 'BTCUSDT', quantity: 0.1, clientOrderId: crypto.randomUUID() });

    expect(market.status).toBe(200);
    expect(market.body.balance).toBe(5000);
  });

  test('a failed matcher cycle is rejected until a later cycle succeeds', async () => {
    const runtime = operationalRuntime();
    const app = createApp({ feed, runtimeStatus: runtime });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    runtime.markMatcherFailed('MATCHER_CYCLE_FAILED', 'boom');
    const failed = await postLimit(app, token);
    expect(failed.status).toBe(503);
    expect(failed.body.code).toBe('MATCHER_NOT_READY');
    expect(await Order.countDocuments()).toBe(0);

    runtime.markMatcherActive();
    const recovered = await postLimit(app, token);
    expect(recovered.status).toBe(200);
    expect(recovered.body.lockedBalance).toBe(4000);
    expect(await Order.countDocuments()).toBe(1);
  });

  test('an operational matcher accepts LIMIT orders normally', async () => {
    const runtime = operationalRuntime();
    const app = createApp({ feed, runtimeStatus: runtime });
    const user = await createTestUser({ balance: 10000 });

    const res = await postLimit(app, authToken(user));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.balance).toBe(6000);
    expect(res.body.lockedBalance).toBe(4000);
    expect(res.body.pendingOrders).toHaveLength(1);
  });

  test('cancellation and refund still work while the matcher is unavailable', async () => {
    const runtime = createRuntimeStatus();
    runtime.setMongoConnected(true);
    runtime.setTransactionsVerified(true);
    const app = createApp({ feed, runtimeStatus: runtime });
    const user = await createTestUser({ balance: 6000, lockedBalance: 4000 });
    const order = await Order.create({
      userId: user._id,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: 40000,
      status: 'OPEN',
      clientOrderId: crypto.randomUUID()
    });

    const res = await request(app)
      .delete(`/api/trade/cancel/${order._id}`)
      .set('x-auth-token', authToken(user));

    expect(res.status).toBe(200);
    const after = await snapshotUser(user._id);
    expect(after.balance).toBe(10000);
    expect(after.lockedBalance).toBe(0);
    expect((await Order.findById(order._id).lean()).status).toBe('CANCELLED');
  });

  test('an idempotent replay of an already-placed limit is not rejected by the gate', async () => {
    const runtime = operationalRuntime();
    const app = createApp({ feed, runtimeStatus: runtime });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const clientOrderId = crypto.randomUUID();

    const first = await postLimit(app, token, { clientOrderId });
    expect(first.status).toBe(200);
    expect(first.body.balance).toBe(6000);

    runtime.markMatcherFailed('MATCHER_CYCLE_FAILED', 'boom');
    const replay = await postLimit(app, token, { clientOrderId });

    expect(replay.status).toBe(200);
    expect(replay.body.idempotent).toBe(true);
    expect(replay.body.balance).toBe(6000);
    expect(replay.body.lockedBalance).toBe(4000);
    expect(await Order.countDocuments()).toBe(1);
  });

  test('the server only restores ACTIVE readiness after a completed matcher cycle', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = source.indexOf('setInterval(async () => {');
    const end = source.indexOf('}, 3000);');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const interval = source.slice(start, end);

    // A cycle skipped because one is already running, or because the matcher
    // is FAILED, must never be treated as a successful recovery.
    expect(interval).toMatch(/if \(!stats\.skipped\) \{\s*runtimeStatus\.markMatcherActive\(\);/);
    expect(interval).not.toMatch(/runtimeStatus\.markMatcherActive\(\);\s*\}\s*catch/);
    expect(interval.match(/runtimeStatus\.markMatcherActive\(\)/g)).toHaveLength(1);
  });
});
