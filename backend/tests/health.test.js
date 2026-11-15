const request = require('supertest');
const { createApp } = require('../app');
const { createRuntimeStatus, MATCHER_STATES } = require('../services/runtimeStatus');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { startTestDb, stopTestDb } = require('./helpers');

function fullyReady() {
  const status = createRuntimeStatus();
  status.setStartupComplete(true);
  status.setMongoConnected(true);
  status.setTransactionsVerified(true);
  status.setIndexesVerified(true);
  status.setLegacyGateClear(true);
  status.markMatcherActive();
  return status;
}

describe('runtime readiness status', () => {
  test('a fresh process is not ready and reports every missing component', () => {
    const status = createRuntimeStatus();
    const report = status.readiness();

    expect(report.ok).toBe(false);
    expect(report.status).toBe('not_ready');
    expect(report.components).toEqual({
      startup: false,
      mongo: false,
      transactions: false,
      indexes: false,
      legacyGate: false,
      matcher: false
    });
    expect(report.codes).toEqual(expect.arrayContaining([
      'STARTUP_INCOMPLETE',
      'MONGO_DISCONNECTED',
      'TRANSACTIONS_UNAVAILABLE',
      'INDEXES_UNVERIFIED',
      'LEGACY_GATE_BLOCKED',
      'MATCHER_BLOCKED'
    ]));
    expect(status.isMatcherOperational()).toBe(false);
  });

  test('all prerequisites plus an active matcher is ready', () => {
    const status = fullyReady();
    const report = status.readiness();

    expect(report.ok).toBe(true);
    expect(report.status).toBe('ready');
    expect(report.codes).toEqual([]);
    expect(report.matcher).toBe(MATCHER_STATES.ACTIVE);
    expect(status.isMatcherOperational()).toBe(true);
  });

  test('losing a component immediately invalidates readiness and stops new limits', () => {
    const status = fullyReady();

    status.setLegacyGateClear(false);
    const report = status.readiness();

    expect(report.ok).toBe(false);
    expect(report.codes).toEqual(['LEGACY_GATE_BLOCKED', 'MATCHER_BLOCKED']);
    expect(report.components.legacyGate).toBe(false);
    expect(status.isMatcherOperational()).toBe(false);
    expect(status.snapshot().matcher).toBe(MATCHER_STATES.BLOCKED);

    status.setLegacyGateClear(true);
    status.markMatcherActive();
    expect(status.readiness().ok).toBe(true);
  });

  test('a matcher cycle failure clears readiness and a later success restores it', () => {
    const status = fullyReady();

    status.markMatcherFailed('MATCHER_CYCLE_FAILED', 'boom');
    expect(status.isMatcherOperational()).toBe(false);
    expect(status.readiness().codes).toEqual(['MATCHER_FAILED']);
    expect(status.readiness().matcherCode).toBe('MATCHER_CYCLE_FAILED');

    status.markMatcherActive();
    expect(status.isMatcherOperational()).toBe(true);
    expect(status.readiness().ok).toBe(true);
    expect(status.readiness().matcherCode).toBeNull();
  });

  test('a Mongo disconnect marks the matcher failed until it is restored', () => {
    const status = fullyReady();

    status.setMongoConnected(false);
    expect(status.snapshot().matcher).toBe(MATCHER_STATES.FAILED);
    expect(status.snapshot().matcherCode).toBe('MONGO_DISCONNECTED');
    expect(status.readiness().codes).toEqual(expect.arrayContaining([
      'MONGO_DISCONNECTED',
      'MATCHER_FAILED'
    ]));

    status.setMongoConnected(true);
    status.markMatcherActive();
    expect(status.readiness().ok).toBe(true);
  });
});

describe('health endpoints', () => {
  test('liveness stays 200 for every process state', async () => {
    const app = createApp({ runtimeStatus: createRuntimeStatus() });

    const res = await request(app).get('/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  test('the root liveness route is preserved', async () => {
    const app = createApp();

    const res = await request(app).get('/');

    expect(res.status).toBe(200);
    expect(res.text).toBe('API LIVE');
  });

  test('readiness without a configured status is 503 and never touches data', async () => {
    const app = createApp();

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: 'not_ready',
      codes: ['STARTUP_INCOMPLETE'],
      components: {
        startup: false,
        mongo: false,
        transactions: false,
        indexes: false,
        legacyGate: false,
        matcher: false
      }
    });
  });

  test('readiness reports 503 while starting and 200 once every component is ready', async () => {
    const runtimeStatus = createRuntimeStatus();
    const app = createApp({ runtimeStatus });

    const starting = await request(app).get('/health/ready');
    expect(starting.status).toBe(503);
    expect(starting.body.status).toBe('not_ready');

    runtimeStatus.setStartupComplete(true);
    runtimeStatus.setMongoConnected(true);
    runtimeStatus.setTransactionsVerified(true);
    runtimeStatus.setIndexesVerified(true);
    runtimeStatus.setLegacyGateClear(true);
    runtimeStatus.markMatcherActive();

    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      status: 'ready',
      codes: [],
      matcher: MATCHER_STATES.ACTIVE,
      matcherCode: null,
      components: {
        startup: true,
        mongo: true,
        transactions: true,
        indexes: true,
        legacyGate: true,
        matcher: true
      }
    });
    expect(typeof ready.body.checkedAt).toBe('string');
  });

  test('readiness degrades dynamically when the matcher fails and recovers', async () => {
    const runtimeStatus = fullyReady();
    const app = createApp({ runtimeStatus });

    runtimeStatus.markMatcherFailed('MATCHER_CYCLE_FAILED', 'boom');
    const failed = await request(app).get('/health/ready');
    expect(failed.status).toBe(503);
    expect(failed.body.codes).toEqual(['MATCHER_FAILED']);
    expect(failed.body.matcherCode).toBe('MATCHER_CYCLE_FAILED');

    runtimeStatus.markMatcherActive();
    const recovered = await request(app).get('/health/ready');
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe('ready');
  });

  test('readiness reports only safe component codes, never internal details', async () => {
    const runtimeStatus = fullyReady();
    runtimeStatus.setMongoConnected(false);
    const app = createApp({ runtimeStatus });

    const res = await request(app).get('/health/ready');

    expect(res.status).toBe(503);
    expect(res.body.codes).toEqual(expect.arrayContaining(['MONGO_DISCONNECTED']));
    expect(JSON.stringify(res.body)).not.toMatch(/mongodb:\/\//i);
    expect(JSON.stringify(res.body)).not.toMatch(/password|secret|token/i);
  });
});

describe('readiness is read-only', () => {
  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  test('serving health endpoints never creates, drops, or changes data', async () => {
    const runtimeStatus = fullyReady();
    const app = createApp({ runtimeStatus });

    const indexesBefore = await Promise.all([
      User.collection.indexes(),
      Order.collection.indexes(),
      Trade.collection.indexes()
    ]);
    const countsBefore = await Promise.all([
      User.countDocuments(),
      Order.countDocuments(),
      Trade.countDocuments()
    ]);

    expect((await request(app).get('/health/live')).status).toBe(200);
    expect((await request(app).get('/health/ready')).status).toBe(200);
    runtimeStatus.markMatcherFailed('MATCHER_CYCLE_FAILED', 'boom');
    expect((await request(app).get('/health/ready')).status).toBe(503);

    const indexesAfter = await Promise.all([
      User.collection.indexes(),
      Order.collection.indexes(),
      Trade.collection.indexes()
    ]);
    const countsAfter = await Promise.all([
      User.countDocuments(),
      Order.countDocuments(),
      Trade.countDocuments()
    ]);

    expect(indexesAfter).toEqual(indexesBefore);
    expect(countsAfter).toEqual(countsBefore);
  });
});
