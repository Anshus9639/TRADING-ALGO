const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { loadConsistentAccountView } = require('../services/accountView');
const { startTestDb, stopTestDb } = require('./helpers');

describe('consistent account view reads', () => {
  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
  });

  function account(overrides = {}) {
    return {
      _id: new mongoose.Types.ObjectId(),
      username: 'trader',
      email: 'trader@example.com',
      balance: 1000,
      lockedBalance: 0,
      portfolio: [],
      pendingOrders: [],
      trades: [],
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides
    };
  }

  test('re-reads and rebuilds the view when the account changed while reading', async () => {
    const first = account({ balance: 1000 });
    const second = account({
      _id: first._id,
      balance: 900,
      updatedAt: new Date('2026-01-01T00:00:01.000Z')
    });
    const snapshots = [second, second];
    let reads = 0;
    const UserModel = {
      findById() {
        const snapshot = snapshots.shift() || second;
        reads += 1;
        return { lean: async () => snapshot };
      }
    };

    const view = await loadConsistentAccountView(first, { UserModel });

    expect(view.balance).toBe(900);
    expect(reads).toBe(2);
  });

  test('accepts the first view when the account did not change', async () => {
    const user = account();
    let reads = 0;
    const UserModel = {
      findById() {
        reads += 1;
        return { lean: async () => user };
      }
    };

    const view = await loadConsistentAccountView(user, { UserModel });

    expect(view.balance).toBe(1000);
    expect(reads).toBe(1);
  });

  test('bounds retries under sustained writes and returns the newest snapshot', async () => {
    const user = account({ balance: 0 });
    const balances = [1, 2, 3];
    let reads = 0;
    const UserModel = {
      findById() {
        const balance = balances.shift() || 3;
        reads += 1;
        return {
          lean: async () => account({
            _id: user._id,
            balance,
            updatedAt: new Date(Date.parse('2026-01-01T00:00:00.000Z') + reads * 1000)
          })
        };
      }
    };

    const view = await loadConsistentAccountView(user, { UserModel, attempts: 3 });

    expect(reads).toBe(3);
    expect(view.balance).toBe(3);
  });
});
