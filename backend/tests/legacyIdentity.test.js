const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { loadAccountView } = require('../services/accountView');
const {
  legacyOrderId,
  legacyTradeId,
  resolveLegacyOrderId,
  resolveLegacyTradeId
} = require('../lib/legacyIdentity');
const { startTestDb, stopTestDb, createTestUser } = require('./helpers');

const timestamp = new Date('2025-06-01T00:00:00.000Z');

function orderContent(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    type: 'BUY',
    quantity: 0.1,
    limitPrice: 40000,
    timestamp,
    ...overrides
  };
}

function tradeContent(overrides = {}) {
  return {
    symbol: 'BTCUSDT',
    type: 'BUY',
    quantity: 0.1,
    price: 40000,
    timestamp,
    ...overrides
  };
}

describe('legacy identity canonicalization', () => {
  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
  });

  test('Date and ISO timestamp variants hash identically', () => {
    const userId = new mongoose.Types.ObjectId();
    const order = orderContent();
    const trade = tradeContent();
    const expectedOrderId = String(legacyOrderId(userId, order));
    const expectedTradeId = String(legacyTradeId(userId, trade));

    const variants = [
      timestamp,
      '2025-06-01T00:00:00.000Z',
      '2025-06-01T00:00:00Z',
      timestamp.getTime()
    ];

    for (const variant of variants) {
      expect(String(legacyOrderId(userId, { ...order, timestamp: variant }))).toBe(expectedOrderId);
      expect(String(legacyTradeId(userId, { ...trade, timestamp: variant }))).toBe(expectedTradeId);
      expect(resolveLegacyOrderId(userId, { ...order, timestamp: variant })).toBe(expectedOrderId);
      expect(resolveLegacyTradeId(userId, { ...trade, timestamp: variant })).toBe(expectedTradeId);
    }

    expect(String(legacyOrderId(userId, { ...order, timestamp: new Date('2025-06-02T00:00:00Z') })))
      .not.toBe(expectedOrderId);
  });

  test('a missing timestamp hashes the same raw and after hydration', async () => {
    const user = await createTestUser({ balance: 5000 });
    const rawOrder = orderContent({ timestamp: undefined });
    const rawTrade = tradeContent({ timestamp: undefined });
    delete rawOrder.timestamp;
    delete rawTrade.timestamp;

    await User.collection.updateOne(
      { _id: user._id },
      { $set: { pendingOrders: [rawOrder], trades: [rawTrade] } }
    );

    const hydrated = await User.findById(user._id);
    const hydratedOrder = hydrated.pendingOrders[0];
    const hydratedTrade = hydrated.trades[0];

    // Mongoose stamps defaults that were never persisted; both are ignored.
    expect(hydratedOrder.$isDefault('_id')).toBe(true);
    expect(hydratedOrder.$isDefault('timestamp')).toBe(true);
    expect(hydratedTrade.$isDefault('_id')).toBe(true);
    expect(hydratedTrade.$isDefault('timestamp')).toBe(true);

    const expectedOrderId = String(legacyOrderId(user._id, rawOrder));
    const expectedTradeId = String(legacyTradeId(user._id, rawTrade));
    expect(resolveLegacyOrderId(user._id, rawOrder)).toBe(expectedOrderId);
    expect(resolveLegacyOrderId(user._id, hydratedOrder)).toBe(expectedOrderId);
    expect(resolveLegacyTradeId(user._id, rawTrade)).toBe(expectedTradeId);
    expect(resolveLegacyTradeId(user._id, hydratedTrade)).toBe(expectedTradeId);
  });

  test('a persisted timestamp survives hydration as the same identity', async () => {
    const user = await createTestUser({ balance: 5000 });
    const rawOrder = orderContent();
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { pendingOrders: [rawOrder] } }
    );

    const hydratedOrder = (await User.findById(user._id)).pendingOrders[0];
    expect(hydratedOrder.$isDefault('_id')).toBe(true);
    expect(hydratedOrder.$isDefault('timestamp')).toBe(false);
    expect(resolveLegacyOrderId(user._id, hydratedOrder))
      .toBe(String(legacyOrderId(user._id, rawOrder)));
  });

  test('explicit ObjectId strings normalize to the migration hex form', () => {
    const userId = new mongoose.Types.ObjectId();
    const explicitId = new mongoose.Types.ObjectId();
    const order = orderContent({ _id: explicitId.toHexString().toUpperCase() });
    const trade = tradeContent({ _id: explicitId.toHexString().toUpperCase() });

    expect(resolveLegacyOrderId(userId, order)).toBe(explicitId.toHexString());
    expect(resolveLegacyTradeId(userId, trade)).toBe(explicitId.toHexString());

    // ObjectId instances and lowercase strings resolve to the same identity.
    const lower = { ...order, _id: explicitId.toHexString() };
    expect(resolveLegacyOrderId(userId, lower)).toBe(explicitId.toHexString());
    expect(resolveLegacyOrderId(userId, { ...order, _id: explicitId })).toBe(explicitId.toHexString());

    // Values the migration cannot convert fall back to the derived id.
    const invalid = { ...order, _id: 'not-an-object-id' };
    expect(resolveLegacyOrderId(userId, invalid)).toBe(String(legacyOrderId(userId, invalid)));
  });

  test('a persisted explicit id is never suppressed by a content-derived twin', async () => {
    const user = await createTestUser({ balance: 5000 });
    const content = orderContent();
    const derivedId = String(legacyOrderId(user._id, content));
    const explicitId = new mongoose.Types.ObjectId();

    // Canonical twin stored under the content-derived id, as a migration of an
    // id-less record would create it.
    await Order.create({
      _id: derivedId,
      userId: user._id,
      symbol: content.symbol,
      side: content.type,
      orderType: 'LIMIT',
      quantity: content.quantity,
      remainingQuantity: content.quantity,
      limitPrice: content.limitPrice,
      status: 'OPEN',
      clientOrderId: `legacy:${user._id}:${derivedId}`
    });
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { pendingOrders: [{ _id: explicitId, ...content }] } }
    );

    const view = await loadAccountView(await User.findById(user._id));

    expect(view.pendingOrders).toHaveLength(2);
    const legacyOrders = view.pendingOrders.filter(order => order.legacy);
    expect(legacyOrders).toHaveLength(1);
    expect(String(legacyOrders[0]._id)).toBe(String(explicitId));
    expect(legacyOrders[0].ambiguous).toBeUndefined();
    expect(view.legacyAmbiguity.pendingOrderIds).toEqual([]);
  });

  test('id-less duplicates stay visible and are flagged as ambiguous', async () => {
    const user = await createTestUser({ balance: 5000 });
    const rawOrder = orderContent();
    const rawTrade = tradeContent();
    const orderId = String(legacyOrderId(user._id, rawOrder));
    const tradeId = String(legacyTradeId(user._id, rawTrade));

    await User.collection.updateOne(
      { _id: user._id },
      {
        $set: {
          pendingOrders: [{ ...rawOrder }, { ...rawOrder }],
          trades: [{ ...rawTrade }, { ...rawTrade }]
        }
      }
    );

    const view = await loadAccountView(await User.findById(user._id));

    expect(view.pendingOrders).toHaveLength(2);
    expect(view.pendingOrders.every(order => order.ambiguous === true)).toBe(true);
    expect(view.legacyAmbiguity.pendingOrderIds).toContain(orderId);

    expect(view.trades).toHaveLength(2);
    expect(view.trades.every(trade => trade.ambiguous === true)).toBe(true);
    expect(view.legacyAmbiguity.tradeIds).toContain(tradeId);
  });

  test('distinct persisted ids with identical content are not duplicates', async () => {
    const user = await createTestUser({ balance: 5000 });
    const content = orderContent();
    const trade = tradeContent();
    const firstOrderId = new mongoose.Types.ObjectId();
    const secondOrderId = new mongoose.Types.ObjectId();
    const firstTradeId = new mongoose.Types.ObjectId();
    const secondTradeId = new mongoose.Types.ObjectId();

    await User.collection.updateOne(
      { _id: user._id },
      {
        $set: {
          pendingOrders: [
            { _id: firstOrderId, ...content },
            { _id: secondOrderId, ...content }
          ],
          trades: [
            { _id: firstTradeId, ...trade },
            { _id: secondTradeId, ...trade }
          ]
        }
      }
    );

    const view = await loadAccountView(await User.findById(user._id));

    expect(view.pendingOrders).toHaveLength(2);
    expect(view.pendingOrders.every(order => order.legacy === true && !order.ambiguous)).toBe(true);
    expect(view.trades).toHaveLength(2);
    expect(view.trades.every(item => item.legacy === true && !item.ambiguous)).toBe(true);
    expect(view.legacyAmbiguity).toEqual({ pendingOrderIds: [], tradeIds: [] });
  });
});
