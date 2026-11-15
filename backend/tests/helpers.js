const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { defaultTransactionSupport } = require('../lib/transactions');

let replSet;

async function startTestDb() {
  // Transactions require a replica set. A single-node replica set exercises
  // the same session.withTransaction() path as production.
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' }
  });
  await mongoose.connect(replSet.getUri('nexustrade_test'));
  await Promise.all([User.syncIndexes(), Order.syncIndexes(), Trade.syncIndexes()]);
  defaultTransactionSupport.reset();
}

async function stopTestDb() {
  await mongoose.disconnect();
  if (replSet) await replSet.stop();
  replSet = null;
}

function testDbUri(name = 'nexustrade_test') {
  if (!replSet) throw new Error('Test database is not running.');
  return replSet.getUri(name);
}

async function createTestUser(overrides = {}) {
  return User.create({
    username: 'test-user',
    email: `test-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
    password: 'not-a-real-password-hash',
    balance: 10000,
    ...overrides
  });
}

function authToken(user) {
  return jwt.sign({ user: { id: user._id } }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

async function snapshotUser(userId) {
  const [user, orders, trades] = await Promise.all([
    User.findById(userId).lean(),
    Order.find({ userId, status: 'OPEN' }).sort({ createdAt: 1, _id: 1 }).lean(),
    Trade.find({ userId }).sort({ timestamp: 1, _id: 1 }).lean()
  ]);

  const positions = (user.portfolio || []).map(p => ({
    symbol: p.symbol,
    quantity: p.quantity,
    avgPrice: p.avgPrice
  }));

  return {
    balance: user.balance,
    lockedBalance: user.lockedBalance || 0,
    portfolio: positions,
    lockedQuantities: Object.fromEntries(
      (user.portfolio || [])
        .filter(p => (p.lockedQuantity || 0) > 0)
        .map(p => [p.symbol, p.lockedQuantity])
    ),
    pendingOrders: orders.map(o => ({
      symbol: o.symbol,
      type: o.side,
      quantity: o.quantity,
      limitPrice: o.limitPrice
    })),
    trades: trades.map(t => ({
      symbol: t.symbol,
      type: t.side,
      quantity: t.quantity,
      price: t.executionPrice
    }))
  };
}

module.exports = {
  startTestDb,
  stopTestDb,
  testDbUri,
  createTestUser,
  authToken,
  snapshotUser
};
