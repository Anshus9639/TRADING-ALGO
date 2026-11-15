process.env.JWT_SECRET = 'test-secret';

const request = require('supertest');
const express = require('express');
const jwt = require('jsonwebtoken');

// The real User model needs MongoDB. Here it is replaced with an in-memory
// fake so the REAL route code (validation, pricing, escrow maths) is tested.
let mockUser;
jest.mock('../models/User', () => ({
  findById: jest.fn(async () => mockUser),
}));

const prices = require('../lib/prices');
const tradeRouter = require('../routes/trade');

const app = express();
app.use(express.json());
app.use('/api/trade', tradeRouter);

const token = jwt.sign({ user: { id: 'u1' } }, process.env.JWT_SECRET);
const post = (path, body) =>
  request(app).post(`/api/trade${path}`).set('x-auth-token', token).send(body);

function freshUser(overrides = {}) {
  return {
    balance: 10000,
    portfolio: [],
    pendingOrders: [],
    trades: [],
    save: jest.fn(async () => {}),
    ...overrides,
  };
}

beforeEach(() => {
  mockUser = freshUser();
  prices.clearPrices();
  prices.setPrice('BTCUSDT', 65000);
});

describe('input validation (all order routes)', () => {
  const badQuantities = [-1, 0, 'abc', '', null, true, [], {}, Infinity, 1e12];

  test.each(badQuantities)('market buy rejects quantity %p', async (q) => {
    const res = await post('/buy', { symbol: 'BTCUSDT', quantity: q });
    expect(res.status).toBe(400);
    expect(mockUser.balance).toBe(10000);
    expect(mockUser.save).not.toHaveBeenCalled();
  });

  test.each(badQuantities)('market sell rejects quantity %p', async (q) => {
    mockUser.portfolio = [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 1 }];
    const res = await post('/sell', { symbol: 'BTCUSDT', quantity: q });
    expect(res.status).toBe(400);
    expect(mockUser.portfolio[0].quantity).toBe(1);
    expect(mockUser.save).not.toHaveBeenCalled();
  });

  test('rejects unknown symbol', async () => {
    const res = await post('/buy', { symbol: 'DOGEUSDT', quantity: 1 });
    expect(res.status).toBe(400);
  });

  test('rejects missing symbol', async () => {
    const res = await post('/buy', { quantity: 1 });
    expect(res.status).toBe(400);
  });
});

describe('limit orders: money must not be created', () => {
  test('limit BUY with negative quantity is rejected and balance unchanged', async () => {
    const res = await post('/limit', {
      symbol: 'BTCUSDT', type: 'BUY', quantity: -1000, limitPrice: 100,
    });
    expect(res.status).toBe(400);
    expect(mockUser.balance).toBe(10000);
    expect(mockUser.pendingOrders).toHaveLength(0);
    expect(mockUser.save).not.toHaveBeenCalled();
  });

  test('limit SELL with negative quantity is rejected and portfolio unchanged', async () => {
    mockUser.portfolio = [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 1 }];
    const res = await post('/limit', {
      symbol: 'BTCUSDT', type: 'SELL', quantity: -5, limitPrice: 100,
    });
    expect(res.status).toBe(400);
    expect(mockUser.portfolio[0].quantity).toBe(1);
    expect(mockUser.pendingOrders).toHaveLength(0);
  });

  test.each([0, -1, 'x', null, Infinity])('limit rejects limitPrice %p', async (p) => {
    const res = await post('/limit', {
      symbol: 'BTCUSDT', type: 'BUY', quantity: 1, limitPrice: p,
    });
    expect(res.status).toBe(400);
    expect(mockUser.balance).toBe(10000);
  });

  test('limit rejects invalid type and unknown symbol', async () => {
    let res = await post('/limit', { symbol: 'BTCUSDT', type: 'HOLD', quantity: 1, limitPrice: 100 });
    expect(res.status).toBe(400);
    res = await post('/limit', { symbol: 'FAKEUSDT', type: 'BUY', quantity: 1, limitPrice: 100 });
    expect(res.status).toBe(400);
    expect(mockUser.balance).toBe(10000);
  });

  test('valid limit BUY escrows exactly quantity * limitPrice', async () => {
    const res = await post('/limit', {
      symbol: 'btcusdt', type: 'BUY', quantity: 0.1, limitPrice: 60000,
    });
    expect(res.status).toBe(200);
    expect(mockUser.balance).toBeCloseTo(10000 - 0.1 * 60000, 6);
    expect(mockUser.pendingOrders).toHaveLength(1);
    expect(mockUser.pendingOrders[0]).toMatchObject({
      symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, limitPrice: 60000,
    });
  });

  test('limit BUY with insufficient balance is rejected', async () => {
    const res = await post('/limit', {
      symbol: 'BTCUSDT', type: 'BUY', quantity: 1, limitPrice: 60000,
    });
    expect(res.status).toBe(400);
    expect(mockUser.balance).toBe(10000);
  });
});

describe('market orders use the server price, never the client price', () => {
  test('buy ignores a client-supplied price', async () => {
    const res = await post('/buy', { symbol: 'BTCUSDT', quantity: 0.1, price: 0.0001 });
    expect(res.status).toBe(200);
    expect(mockUser.balance).toBeCloseTo(10000 - 0.1 * 65000, 6);
    expect(mockUser.trades[0].price).toBe(65000);
    expect(mockUser.portfolio[0].avgPrice).toBe(65000);
  });

  test('sell ignores a client-supplied price', async () => {
    mockUser.portfolio = [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 50000 }];
    const res = await post('/sell', { symbol: 'BTCUSDT', quantity: 0.5, price: 999999999 });
    expect(res.status).toBe(200);
    expect(mockUser.balance).toBeCloseTo(10000 + 0.5 * 65000, 6);
    expect(mockUser.trades[0].price).toBe(65000);
  });

  test('buy is rejected with 503 when no server price exists', async () => {
    prices.clearPrices();
    const res = await post('/buy', { symbol: 'BTCUSDT', quantity: 0.1, price: 1 });
    expect(res.status).toBe(503);
    expect(mockUser.balance).toBe(10000);
    expect(mockUser.save).not.toHaveBeenCalled();
  });

  test('buy is rejected with 503 when the server price is stale', async () => {
    prices.clearPrices();
    prices.setPrice('BTCUSDT', 65000, Date.now() - 60000);
    const res = await post('/buy', { symbol: 'BTCUSDT', quantity: 0.1 });
    expect(res.status).toBe(503);
  });

  test('insufficient balance is still rejected', async () => {
    const res = await post('/buy', { symbol: 'BTCUSDT', quantity: 1 });
    expect(res.status).toBe(400);
    expect(mockUser.balance).toBe(10000);
  });

  test('selling more than owned is rejected', async () => {
    mockUser.portfolio = [{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 1 }];
    const res = await post('/sell', { symbol: 'BTCUSDT', quantity: 1 });
    expect(res.status).toBe(400);
  });
});

describe('lib/prices', () => {
  test('rejects non-positive and non-finite prices', () => {
    expect(prices.setPrice('X', 0)).toBe(false);
    expect(prices.setPrice('X', -1)).toBe(false);
    expect(prices.setPrice('X', NaN)).toBe(false);
    expect(prices.setPrice('X', Infinity)).toBe(false);
    expect(prices.getPrice('X')).toBeNull();
  });

  test('returns null once the price is older than maxAgeMs', () => {
    prices.setPrice('Y', 10, 1000);
    expect(prices.getPrice('Y', { maxAgeMs: 500, now: 1400 })).toBe(10);
    expect(prices.getPrice('Y', { maxAgeMs: 500, now: 1600 })).toBeNull();
  });
});
