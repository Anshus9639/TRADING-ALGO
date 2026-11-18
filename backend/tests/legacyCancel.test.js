const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { loadAccountView } = require('../services/accountView');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { resolveLegacyOrderId } = require('../lib/legacyIdentity');
const { startTestDb, stopTestDb, createTestUser } = require('./helpers');

describe('legacy order identity across account reads and cancels', () => {
  let service;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
    service = createTradeService({ feed: createMarketFeed() });
  });

  test('an id-less embedded order shown by the account view can be cancelled', async () => {
    const user = await createTestUser({
      balance: 6000,
      portfolio: [{ symbol: 'ETHUSDT', quantity: 1, avgPrice: 2000 }]
    });
    // Raw push keeps the record genuinely id-less, so Mongoose invents a new
    // synthetic _id every time it hydrates the account.
    const embedded = {
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.1,
      limitPrice: 40000,
      timestamp: new Date('2025-03-01T00:00:00Z')
    };
    await User.collection.updateOne({ _id: user._id }, { $push: { pendingOrders: embedded } });

    const view = await loadAccountView(await User.findById(user._id));
    expect(view.pendingOrders).toHaveLength(1);

    const expectedId = resolveLegacyOrderId(user._id, embedded);
    expect(view.pendingOrders[0]).toMatchObject({ _id: expectedId, legacy: true });

    const cancelled = await service.cancelOrder({
      orderId: view.pendingOrders[0]._id,
      userId: user._id
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ success: true, legacy: true });

    const after = await User.findById(user._id).lean();
    expect(after.pendingOrders).toHaveLength(0);
    // The placement had reserved 0.1 * 40000; cancelling refunds it once.
    expect(after.balance).toBe(10000);
    expect(after.lockedBalance).toBe(0);
  });

  test('a LIMIT order being filled is an accepted retry, not a new reservation', async () => {
    const clientOrderId = 'filling-retry-key';
    const user = await createTestUser({ balance: 6000, lockedBalance: 4000 });
    await Order.create({
      userId: user._id,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: 40000,
      status: 'FILLING',
      clientOrderId,
      claimedBy: 'matcher-test',
      claimedAt: new Date(),
      leaseExpiresAt: new Date(Date.now() + 60000)
    });

    const retry = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId
    });

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: true, idempotent: true });
    expect(retry.body.message).toMatch(/being filled/);

    const after = await User.findById(user._id).lean();
    expect(after.balance).toBe(6000);
    expect(after.lockedBalance).toBe(4000);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });
});
