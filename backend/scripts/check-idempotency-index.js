#!/usr/bin/env node
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

const EXPECTED_COLLECTION = 'orders';
const EXPECTED_KEY = Object.freeze({ userId: 1, clientOrderId: 1 });
const EXPECTED_TRADE_COLLECTION = 'trades';
const EXPECTED_TRADE_KEY = Object.freeze({ orderId: 1 });
const EXPECTED_TRADE_PARTIAL_FILTER = Object.freeze({ orderId: { $type: 'objectId' } });
const EXPECTED_USER_COLLECTION = 'users';
const EXPECTED_USER_KEY = Object.freeze({ email: 1 });
const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;
const NAMESPACE_NOT_FOUND = 26;

function isExpectedKey(key) {
  if (!key || typeof key !== 'object') return false;
  const entries = Object.entries(key);
  return entries.length === 2
    && entries[0][0] === 'userId' && entries[0][1] === 1
    && entries[1][0] === 'clientOrderId' && entries[1][1] === 1;
}

function isExpectedTradeKey(key) {
  if (!key || typeof key !== 'object') return false;
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === 'orderId' && entries[0][1] === 1;
}

function isExpectedUserKey(key) {
  if (!key || typeof key !== 'object') return false;
  const entries = Object.entries(key);
  return entries.length === 1 && entries[0][0] === 'email' && entries[0][1] === 1;
}

function partialFilterMatches(index) {
  const filter = index && index.partialFilterExpression;
  if (!filter || typeof filter !== 'object') return false;
  const keys = Object.keys(filter);
  if (keys.length !== 1 || keys[0] !== 'orderId') return false;
  const value = filter.orderId;
  return Boolean(value)
    && typeof value === 'object'
    && value.$type === EXPECTED_TRADE_PARTIAL_FILTER.orderId.$type
    && Object.keys(value).length === 1;
}

// A collection may hold several indexes with the same key pattern (for example
// an older non-unique one next to the required unique index). Only an index
// that also carries every required property proves the guarantee; the first
// key-pattern match is used for reporting when none does.
function selectIndex(indexes, matchesKey, isComplete) {
  const candidates = indexes.filter(index => matchesKey(index.key));
  if (candidates.length === 0) return { match: null, complete: false };
  const complete = candidates.find(isComplete);
  return { match: complete || candidates[0], complete: Boolean(complete) };
}

async function readIndexes(collection) {
  try {
    return await collection.indexes();
  } catch (err) {
    if (err && (err.code === NAMESPACE_NOT_FOUND || err.codeName === 'NamespaceNotFound')) {
      return [];
    }
    throw err;
  }
}

async function findDuplicateKeys(collection) {
  return collection.aggregate([
    { $match: { clientOrderId: { $type: 'string' } } },
    {
      $group: {
        _id: { userId: '$userId', clientOrderId: '$clientOrderId' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]).toArray();
}

async function findInvalidClientOrderIds(collection) {
  const missingFilter = {
    $or: [
      { clientOrderId: { $exists: false } },
      { clientOrderId: null },
      { clientOrderId: { $not: { $type: 'string' } } }
    ]
  };
  const malformedFilter = {
    clientOrderId: { $type: 'string' },
    $expr: {
      $not: {
        $regexMatch: {
          // $type: 'string' also matches an array containing a string, but
          // $regexMatch only accepts a scalar. Arrays are coerced to '' so
          // they are reported as malformed instead of aborting the preflight.
          input: {
            $cond: [
              { $isArray: '$clientOrderId' },
              '',
              { $ifNull: ['$clientOrderId', ''] }
            ]
          },
          regex: CLIENT_ORDER_ID_PATTERN.source
        }
      }
    }
  };

  const [missingCount, malformedCount, samples] = await Promise.all([
    collection.countDocuments(missingFilter),
    collection.countDocuments(malformedFilter),
    collection.find(missingFilter)
      .project({ _id: 1, userId: 1 })
      .limit(10)
      .toArray()
  ]);

  return {
    count: missingCount + malformedCount,
    missing: missingCount,
    malformed: malformedCount,
    samples: samples.map(entry => ({
      orderId: String(entry._id),
      userId: entry.userId ? String(entry.userId) : null
    }))
  };
}

// Read-only verification of the idempotency guarantee. This function never
// creates or drops an index; an operator must resolve any reported problem.
async function checkIdempotencyIndex({ collection } = {}) {
  if (!collection) throw new TypeError('checkIdempotencyIndex requires a MongoDB collection.');

  const indexes = await readIndexes(collection);
  const { match } = selectIndex(
    indexes,
    isExpectedKey,
    index => index.unique === true && !index.partialFilterExpression
  );
  const [duplicates, invalidClientOrderIds] = await Promise.all([
    findDuplicateKeys(collection),
    findInvalidClientOrderIds(collection)
  ]);

  const reasons = [];
  if (!match) reasons.push('MISSING_INDEX');
  else {
    if (match.unique !== true) reasons.push('INDEX_NOT_UNIQUE');
    if (match.partialFilterExpression) reasons.push('INDEX_IS_PARTIAL');
  }
  if (duplicates.length > 0) reasons.push('DUPLICATE_KEYS');
  if (invalidClientOrderIds.count > 0) reasons.push('INVALID_CLIENT_ORDER_ID');

  return {
    ok: reasons.length === 0,
    collection: collection.collectionName,
    expectedKey: { ...EXPECTED_KEY },
    index: match
      ? {
          name: match.name,
          key: match.key,
          unique: match.unique === true,
          partial: Boolean(match.partialFilterExpression)
        }
      : null,
    indexCount: indexes.length,
    duplicateGroups: duplicates.map(entry => ({
      userId: String(entry._id.userId),
      clientOrderId: entry._id.clientOrderId,
      count: entry.count
    })),
    invalidClientOrderIds,
    reasons
  };
}

async function findDuplicateTradeOrderIds(collection) {
  return collection.aggregate([
    { $match: { orderId: { $type: 'objectId' } } },
    { $group: { _id: '$orderId', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]).toArray();
}

async function checkTradeOrderIdIndex({ collection } = {}) {
  if (!collection) throw new TypeError('checkTradeOrderIdIndex requires a MongoDB collection.');

  const indexes = await readIndexes(collection);
  const { match } = selectIndex(
    indexes,
    isExpectedTradeKey,
    index => index.unique === true && partialFilterMatches(index)
  );
  const [duplicates, invalidOrderIds] = await Promise.all([
    findDuplicateTradeOrderIds(collection),
    collection.countDocuments({
      orderId: { $exists: true, $ne: null, $not: { $type: 'objectId' } }
    })
  ]);

  const reasons = [];
  if (!match) reasons.push('MISSING_INDEX');
  else {
    if (match.unique !== true) reasons.push('INDEX_NOT_UNIQUE');
    if (!match.partialFilterExpression) reasons.push('INDEX_NOT_PARTIAL');
    else if (!partialFilterMatches(match)) reasons.push('PARTIAL_FILTER_MISMATCH');
  }
  if (duplicates.length > 0) reasons.push('DUPLICATE_ORDER_IDS');
  if (invalidOrderIds > 0) reasons.push('INVALID_ORDER_ID');

  return {
    ok: reasons.length === 0,
    collection: collection.collectionName,
    expectedKey: { ...EXPECTED_TRADE_KEY },
    expectedPartialFilter: JSON.parse(JSON.stringify(EXPECTED_TRADE_PARTIAL_FILTER)),
    index: match
      ? {
          name: match.name,
          key: match.key,
          unique: match.unique === true,
          partial: Boolean(match.partialFilterExpression),
          partialFilterExpression: match.partialFilterExpression || null
        }
      : null,
    indexCount: indexes.length,
    duplicateGroups: duplicates.map(entry => ({
      orderId: String(entry._id),
      count: entry.count
    })),
    invalidOrderIds,
    reasons
  };
}

async function findDuplicateEmails(collection) {
  return collection.aggregate([
    { $match: { email: { $type: 'string' } } },
    {
      $group: {
        _id: { $toLower: '$email' },
        count: { $sum: 1 }
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
    { $limit: 20 }
  ]).toArray();
}

async function checkUserEmailIndex({ collection } = {}) {
  if (!collection) throw new TypeError('checkUserEmailIndex requires a MongoDB collection.');

  const indexes = await readIndexes(collection);
  const { match } = selectIndex(
    indexes,
    isExpectedUserKey,
    index => index.unique === true && !index.partialFilterExpression
  );
  const [duplicates, missingEmails] = await Promise.all([
    findDuplicateEmails(collection),
    collection.countDocuments({
      $or: [
        { email: { $exists: false } },
        { email: null },
        { email: { $not: { $type: 'string' } } },
        { email: '' }
      ]
    })
  ]);

  const reasons = [];
  if (!match) reasons.push('MISSING_INDEX');
  else {
    if (match.unique !== true) reasons.push('INDEX_NOT_UNIQUE');
    if (match.partialFilterExpression) reasons.push('INDEX_IS_PARTIAL');
  }
  if (duplicates.length > 0) reasons.push('DUPLICATE_EMAILS');
  if (missingEmails > 0) reasons.push('INVALID_EMAIL');

  return {
    ok: reasons.length === 0,
    collection: collection.collectionName,
    expectedKey: { ...EXPECTED_USER_KEY },
    index: match
      ? {
          name: match.name,
          key: match.key,
          unique: match.unique === true,
          partial: Boolean(match.partialFilterExpression)
        }
      : null,
    indexCount: indexes.length,
    duplicateGroups: duplicates.map(entry => ({
      normalizedEmail: entry._id,
      count: entry.count
    })),
    invalidEmails: missingEmails,
    reasons
  };
}

// Full preflight across every collection whose constraints protect idempotency
// or account identity. Never mutates indexes or documents.
async function checkDatabaseIndexes({ db, collections = {} } = {}) {
  if (!db) throw new TypeError('checkDatabaseIndexes requires a MongoDB connection db handle.');

  const ordersCollection = collections.orders || db.collection(EXPECTED_COLLECTION);
  const tradesCollection = collections.trades || db.collection(EXPECTED_TRADE_COLLECTION);
  const usersCollection = collections.users || db.collection(EXPECTED_USER_COLLECTION);

  const [orders, trades, users] = await Promise.all([
    checkIdempotencyIndex({ collection: ordersCollection }),
    checkTradeOrderIdIndex({ collection: tradesCollection }),
    checkUserEmailIndex({ collection: usersCollection })
  ]);

  const failedChecks = [];
  for (const [name, report] of Object.entries({ orders, trades, users })) {
    for (const reason of report.reasons) failedChecks.push(`${name}:${reason}`);
  }

  return {
    ...orders,
    ok: orders.ok && trades.ok && users.ok,
    checks: { orders, trades, users },
    failedChecks
  };
}

function parseArgs(argv) {
  const args = { json: false, help: false };
  for (const arg of argv) {
    if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return [
    'Usage: node scripts/check-idempotency-index.js [--json]',
    '',
    'Read-only preflight for every index that protects idempotency and identity:',
    '  orders { userId: 1, clientOrderId: 1 } unique, non-partial',
    '  trades { orderId: 1 } unique, partial on objectId orderIds',
    '  users  { email: 1 } unique',
    '',
    'Also reports missing/invalid order keys, duplicate order keys, duplicate',
    'trade orderIds, and duplicate normalized emails.',
    '',
    'This script never creates or drops indexes. Exit code 1 means the database',
    'is not safe for idempotent order submission or account lookups.'
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return 0;
  }

  const uri = process.env.MONGO_URI;
  if (!uri) {
    throw new Error('MONGO_URI is required (set it in backend/.env or the environment).');
  }

  await mongoose.connect(uri);
  try {
    const report = await checkDatabaseIndexes({ db: mongoose.connection.db });

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`Index preflight: ${report.ok ? 'PASS' : 'FAIL'}`);
      for (const name of ['orders', 'trades', 'users']) {
        const check = report.checks[name];
        console.log(`  ${name}: ${check.ok ? 'PASS' : 'FAIL'} (${check.collection})`);
        if (check.index) {
          console.log(`    index ${check.index.name} unique=${check.index.unique} partial=${check.index.partial}`);
        } else {
          console.log('    index: missing');
        }
        if (!check.ok) console.log(`    reasons: ${check.reasons.join(', ')}`);
      }
      if (!report.ok) console.log(`Failed checks: ${report.failedChecks.join(', ')}`);
    }

    return report.ok ? 0 : 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(err => {
      console.error(`Index preflight aborted: ${err.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  EXPECTED_COLLECTION,
  EXPECTED_KEY,
  EXPECTED_TRADE_COLLECTION,
  EXPECTED_TRADE_KEY,
  EXPECTED_TRADE_PARTIAL_FILTER,
  EXPECTED_USER_COLLECTION,
  EXPECTED_USER_KEY,
  CLIENT_ORDER_ID_PATTERN,
  isExpectedKey,
  isExpectedTradeKey,
  isExpectedUserKey,
  partialFilterMatches,
  findDuplicateKeys,
  findInvalidClientOrderIds,
  checkIdempotencyIndex,
  findDuplicateTradeOrderIds,
  checkTradeOrderIdIndex,
  findDuplicateEmails,
  checkUserEmailIndex,
  checkDatabaseIndexes,
  parseArgs,
  usage,
  main
};
