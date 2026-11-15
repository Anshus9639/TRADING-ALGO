const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const {
  checkIdempotencyIndex,
  checkTradeOrderIdIndex,
  checkUserEmailIndex,
  checkDatabaseIndexes,
  isExpectedKey,
  isExpectedTradeKey,
  EXPECTED_KEY,
  EXPECTED_TRADE_KEY,
  EXPECTED_TRADE_PARTIAL_FILTER
} = require('../scripts/check-idempotency-index');
const { startTestDb, stopTestDb, testDbUri } = require('./helpers');

const BACKEND_ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(BACKEND_ROOT, 'scripts', 'check-idempotency-index.js');

function runCli(uri) {
  return spawnSync(process.execPath, [SCRIPT, '--json'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, MONGO_URI: uri },
    encoding: 'utf8'
  });
}

const TEMP_COLLECTIONS = [
  'preflight_no_index',
  'preflight_non_unique',
  'preflight_duplicates',
  'preflight_orders_invalid_ids',
  'preflight_trade_no_index',
  'preflight_trade_non_unique',
  'preflight_trade_wrong_partial',
  'preflight_trade_duplicates',
  'preflight_trade_ok',
  'preflight_user_no_index',
  'preflight_user_duplicates',
  'preflight_user_invalid'
];

function tempCollection(name) {
  return mongoose.connection.db.collection(name);
}

describe('idempotency index preflight', () => {
  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await Promise.all(TEMP_COLLECTIONS.map(async name => {
      try {
        await mongoose.connection.db.dropCollection(name);
      } catch {
        // Collection may not exist.
      }
    }));
    await stopTestDb();
  });

  test('the replica-set test database has the expected unique index', async () => {
    const indexes = await Order.collection.indexes();
    const match = indexes.find(index => isExpectedKey(index.key));

    expect(match).toBeDefined();
    expect(match.key).toEqual({ userId: 1, clientOrderId: 1 });
    expect(match.unique).toBe(true);
    expect(match.partialFilterExpression).toBeUndefined();
  });

  test('the preflight passes against the live orders collection', async () => {
    const report = await checkIdempotencyIndex({ collection: Order.collection });

    expect(report.ok).toBe(true);
    expect(report.reasons).toEqual([]);
    expect(report.expectedKey).toEqual(EXPECTED_KEY);
    expect(report.index).toMatchObject({
      key: { userId: 1, clientOrderId: 1 },
      unique: true,
      partial: false
    });
    expect(report.duplicateGroups).toEqual([]);
  });

  test('a missing index fails the preflight', async () => {
    const collection = tempCollection('preflight_no_index');
    await collection.insertOne({ userId: new mongoose.Types.ObjectId(), clientOrderId: 'x' });

    const report = await checkIdempotencyIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.index).toBeNull();
    expect(report.reasons).toContain('MISSING_INDEX');
  });

  test('a non-unique index fails the preflight', async () => {
    const collection = tempCollection('preflight_non_unique');
    await collection.createIndex({ userId: 1, clientOrderId: 1 });
    await collection.insertOne({ userId: new mongoose.Types.ObjectId(), clientOrderId: 'unique-a' });

    const report = await checkIdempotencyIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.index).toMatchObject({ unique: false });
    expect(report.reasons).toContain('INDEX_NOT_UNIQUE');
  });

  test('the CLI exits 0 against the indexed replica-set database', () => {
    const result = runCli(testDbUri());

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.index).toMatchObject({ unique: true, partial: false });
  });

  test('the CLI exits non-zero when the index is missing', () => {
    const result = runCli(testDbUri('nexustrade_preflight_empty'));

    expect(result.status).not.toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.reasons).toContain('MISSING_INDEX');
  });

  test('existing duplicate keys are reported', async () => {
    const collection = tempCollection('preflight_duplicates');
    const userId = new mongoose.Types.ObjectId();
    await collection.createIndex({ userId: 1, clientOrderId: 1 });
    await collection.insertMany([
      { userId, clientOrderId: 'duplicate-key' },
      { userId, clientOrderId: 'duplicate-key' }
    ]);

    const report = await checkIdempotencyIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.reasons).toContain('DUPLICATE_KEYS');
    expect(report.duplicateGroups).toEqual([
      { userId: String(userId), clientOrderId: 'duplicate-key', count: 2 }
    ]);
  });

  test('missing, null, or malformed clientOrderId values are reported', async () => {
    const collection = tempCollection('preflight_orders_invalid_ids');
    await collection.createIndex({ userId: 1, clientOrderId: 1 }, { unique: true });
    await collection.insertMany([
      { userId: new mongoose.Types.ObjectId() },
      { userId: new mongoose.Types.ObjectId(), clientOrderId: 'has a space' },
      { userId: new mongoose.Types.ObjectId(), clientOrderId: 'valid-key-1' }
    ]);

    const report = await checkIdempotencyIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(['INVALID_CLIENT_ORDER_ID']);
    expect(report.invalidClientOrderIds).toMatchObject({
      count: 2,
      missing: 1,
      malformed: 1
    });
    expect(report.invalidClientOrderIds.samples).toHaveLength(1);
  });

  test('the full preflight passes against the live replica-set collections', async () => {
    const report = await checkDatabaseIndexes({ db: mongoose.connection.db });

    expect(report.ok).toBe(true);
    expect(report.failedChecks).toEqual([]);
    expect(report.checks.orders.ok).toBe(true);
    expect(report.checks.trades.ok).toBe(true);
    expect(report.checks.users.ok).toBe(true);
    // Top-level fields stay compatible with the original orders-only output.
    expect(report.expectedKey).toEqual(EXPECTED_KEY);
    expect(report.index).toMatchObject({ unique: true, partial: false });
  });

  test('a missing trades orderId index fails the preflight', async () => {
    const collection = tempCollection('preflight_trade_no_index');
    await collection.insertOne({ orderId: new mongoose.Types.ObjectId() });

    const report = await checkTradeOrderIdIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.index).toBeNull();
    expect(report.reasons).toContain('MISSING_INDEX');
  });

  test('a non-unique, non-partial trades index fails the preflight', async () => {
    const collection = tempCollection('preflight_trade_non_unique');
    await collection.createIndex({ orderId: 1 });
    await collection.insertOne({ orderId: new mongoose.Types.ObjectId() });

    const report = await checkTradeOrderIdIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.expectedKey).toEqual(EXPECTED_TRADE_KEY);
    expect(report.index).toMatchObject({ unique: false, partial: false });
    expect(report.reasons).toEqual(expect.arrayContaining([
      'INDEX_NOT_UNIQUE',
      'INDEX_NOT_PARTIAL'
    ]));
  });

  test('a trades index with the wrong partial filter is rejected', async () => {
    const collection = tempCollection('preflight_trade_wrong_partial');
    await collection.createIndex(
      { orderId: 1 },
      { unique: true, partialFilterExpression: { orderId: { $exists: true } } }
    );
    await collection.insertOne({ orderId: new mongoose.Types.ObjectId() });

    const report = await checkTradeOrderIdIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.expectedPartialFilter).toEqual(EXPECTED_TRADE_PARTIAL_FILTER);
    expect(report.reasons).toEqual(['PARTIAL_FILTER_MISMATCH']);
  });

  test('duplicate trade orderIds are reported with their group counts', async () => {
    const collection = tempCollection('preflight_trade_duplicates');
    const orderId = new mongoose.Types.ObjectId();
    await collection.createIndex({ orderId: 1 });
    await collection.insertMany([{ orderId }, { orderId }]);

    const report = await checkTradeOrderIdIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.reasons).toContain('DUPLICATE_ORDER_IDS');
    expect(report.duplicateGroups).toEqual([{ orderId: String(orderId), count: 2 }]);
  });

  test('the expected unique partial trades index passes', async () => {
    const collection = tempCollection('preflight_trade_ok');
    await collection.createIndex(
      { orderId: 1 },
      { unique: true, partialFilterExpression: EXPECTED_TRADE_PARTIAL_FILTER }
    );
    await collection.insertOne({ orderId: new mongoose.Types.ObjectId() });

    const report = await checkTradeOrderIdIndex({ collection });

    expect(report.ok).toBe(true);
    expect(isExpectedTradeKey(report.index.key)).toBe(true);
    expect(report.index).toMatchObject({ unique: true, partial: true });
    expect(report.reasons).toEqual([]);
  });

  test('the user preflight fails when the email index is missing', async () => {
    const collection = tempCollection('preflight_user_no_index');
    await collection.insertOne({ email: 'user@example.test' });

    const report = await checkUserEmailIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.index).toBeNull();
    expect(report.reasons).toContain('MISSING_INDEX');
  });

  test('duplicate emails are detected using signup normalization', async () => {
    const collection = tempCollection('preflight_user_duplicates');
    await collection.createIndex({ email: 1 }, { unique: true });
    await collection.insertMany([
      { email: 'Dup@Example.com' },
      { email: 'dup@example.com' }
    ]);

    const report = await checkUserEmailIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(['DUPLICATE_EMAILS']);
    expect(report.duplicateGroups).toEqual([
      { normalizedEmail: 'dup@example.com', count: 2 }
    ]);
  });

  test('missing and empty user emails are reported', async () => {
    const collection = tempCollection('preflight_user_invalid');
    await collection.createIndex({ email: 1 }, { unique: true });
    await collection.insertMany([{ username: 'missing-email' }, { email: '' }]);

    const report = await checkUserEmailIndex({ collection });

    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(['INVALID_EMAIL']);
    expect(report.invalidEmails).toBe(2);
  });
});
