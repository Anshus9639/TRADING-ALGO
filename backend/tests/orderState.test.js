const mongoose = require('mongoose');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  ORDER_STATUSES,
  TRANSITIONS,
  RETRYABLE_FAILURES,
  isTerminal,
  canTransition,
  assertTransition
} = require('../lib/orderState');
const { startTestDb, stopTestDb } = require('./helpers');

describe('order state machine', () => {
  test('defines every lifecycle status and terminal state', () => {
    expect(ORDER_STATUSES).toEqual([
      'OPEN',
      'FILLING',
      'FILLED',
      'CANCELLED',
      'EXPIRED',
      'REJECTED',
      'FAILED'
    ]);

    for (const status of ['FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'FAILED']) {
      expect(isTerminal(status)).toBe(true);
      expect(TRANSITIONS[status]).toEqual([]);
    }
    expect(isTerminal('OPEN')).toBe(false);
    expect(isTerminal('FILLING')).toBe(false);
  });

  test('allows only documented transitions', () => {
    expect(canTransition('OPEN', 'FILLING')).toBe(true);
    expect(canTransition('OPEN', 'CANCELLED')).toBe(true);
    expect(canTransition('OPEN', 'EXPIRED')).toBe(true);
    expect(canTransition('OPEN', 'REJECTED')).toBe(true);
    expect(canTransition('OPEN', 'FAILED')).toBe(true);
    expect(canTransition('FILLING', 'FILLED')).toBe(true);
    expect(canTransition('FILLING', 'OPEN')).toBe(true);
    expect(canTransition('FILLING', 'FAILED')).toBe(true);

    expect(canTransition('FILLED', 'OPEN')).toBe(false);
    expect(canTransition('CANCELLED', 'FILLED')).toBe(false);
    expect(canTransition('OPEN', 'FILLED')).toBe(false);
    expect(canTransition('FILLING', 'CANCELLED')).toBe(false);

    expect(() => assertTransition('FILLED', 'OPEN')).toThrow(/Invalid order state transition/);
    expect(assertTransition('OPEN', 'CANCELLED')).toBe('CANCELLED');
  });

  test('documents retryable versus terminal failures', () => {
    expect(RETRYABLE_FAILURES).toEqual(['CLAIM_EXPIRED', 'QUOTE_UNAVAILABLE', 'TRANSIENT']);
    expect(RETRYABLE_FAILURES.includes('FILLED')).toBe(false);
  });
});

describe('canonical order and trade models', () => {
  const userId = new mongoose.Types.ObjectId();

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([Order.deleteMany({}), Trade.deleteMany({})]);
  });

  function validOrder(overrides = {}) {
    return {
      userId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'LIMIT',
      quantity: 0.1,
      remainingQuantity: 0.1,
      limitPrice: 40000,
      status: 'OPEN',
      clientOrderId: 'order-1',
      ...overrides
    };
  }

  test('LIMIT orders require a positive limit price and MARKET orders forbid it', () => {
    const missingLimit = new Order(validOrder({ limitPrice: null })).validateSync();
    expect(missingLimit.errors.limitPrice).toBeTruthy();

    const marketWithLimit = new Order(validOrder({
      orderType: 'MARKET',
      limitPrice: 40000
    })).validateSync();
    expect(marketWithLimit.errors.limitPrice).toBeTruthy();

    expect(new Order(validOrder()).validateSync()).toBeUndefined();
    expect(new Order(validOrder({ orderType: 'MARKET', limitPrice: null })).validateSync()).toBeUndefined();
  });

  test('rejects unknown statuses, sides, symbols, and non-positive quantities', () => {
    expect(new Order(validOrder({ status: 'PARTIAL' })).validateSync().errors.status).toBeTruthy();
    expect(new Order(validOrder({ side: 'HOLD' })).validateSync().errors.side).toBeTruthy();
    expect(new Order(validOrder({ symbol: 'DOGEUSDT' })).validateSync().errors.symbol).toBeTruthy();
    expect(new Order(validOrder({ quantity: 0 })).validateSync().errors.quantity).toBeTruthy();
    expect(new Order(validOrder({ remainingQuantity: -1 })).validateSync().errors.remainingQuantity).toBeTruthy();
  });

  test('enforces one order per user and clientOrderId', async () => {
    await Order.create(validOrder({ clientOrderId: 'duplicate-key' }));

    await expect(Order.create(validOrder({ clientOrderId: 'duplicate-key' })))
      .rejects.toMatchObject({ code: 11000 });

    await expect(Order.create(validOrder({
      clientOrderId: 'duplicate-key',
      userId: new mongoose.Types.ObjectId()
    }))).resolves.toBeTruthy();
  });

  test('trades are append-only and one trade per canonical order', async () => {
    const orderId = new mongoose.Types.ObjectId();
    const base = {
      userId,
      orderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0.1,
      executionPrice: 50000,
      notional: 5000,
      timestamp: new Date()
    };

    await Trade.create(base);
    await expect(Trade.create(base)).rejects.toMatchObject({ code: 11000 });

    // Legacy trades have no orderId, so the unique index must allow several.
    await Trade.create({ ...base, orderId: null });
    await Trade.create({ ...base, orderId: null });
  });

  test('rejects non-positive trade quantity and price', () => {
    const invalidQuantity = new Trade({
      userId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0,
      executionPrice: 50000,
      notional: 0
    }).validateSync();
    expect(invalidQuantity.errors.quantity).toBeTruthy();

    const invalidPrice = new Trade({
      userId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      quantity: 0.1,
      executionPrice: -1,
      notional: -0.1
    }).validateSync();
    expect(invalidPrice.errors.executionPrice).toBeTruthy();
  });
});
