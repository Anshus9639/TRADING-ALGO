const { hasUsableMarketRules } = require('../lib/exchangeFilters');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { PINNED_SYMBOLS } = require('../lib/symbols');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { createMatcher } = require('../services/matcher');
const { symbolUniverse } = require('../services/symbolUniverse');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  snapshotUser
} = require('./helpers');

const RULES = Object.freeze({
  tickSize: 0.5,
  stepSize: 0.001,
  minQty: 0.001,
  minNotional: 10
});

// Mirrors what the fallback catalogue publishes when the exchange is
// unreachable: a known pair with no verifiable filters.
const FALLBACK_ENTRY = Object.freeze({
  symbol: 'BTCUSDT',
  status: 'UNKNOWN',
  tickSize: null,
  stepSize: null,
  minQty: null,
  minNotional: null
});

const MARKET_RULES_UNAVAILABLE = 'MARKET_RULES_UNAVAILABLE';

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
});

afterEach(() => {
  symbolUniverse.reset();
});

describe('usable market rules', () => {
  test('requires every filter the order validator depends on', () => {
    expect(hasUsableMarketRules(RULES)).toBe(true);
    expect(hasUsableMarketRules({ ...RULES, tickSize: null })).toBe(false);
    expect(hasUsableMarketRules({ ...RULES, stepSize: 0 })).toBe(false);
    expect(hasUsableMarketRules({ ...RULES, minQty: -1 })).toBe(false);
    expect(hasUsableMarketRules({ ...RULES, minNotional: undefined })).toBe(false);
    expect(hasUsableMarketRules(FALLBACK_ENTRY)).toBe(false);
    expect(hasUsableMarketRules(null)).toBe(false);
  });
});

describe('fail-closed order creation', () => {
  let now;
  let feed;

  beforeEach(() => {
    now = 1_700_000_000_000;
    feed = createMarketFeed({ now: () => now });
    feed.setQuote('BTCUSDT', 50000);
  });

  function serviceWith(rules) {
    return createTradeService({ feed, getMarketRules: () => rules });
  }

  test('a manual MARKET order is refused when the catalogue has no entry', async () => {
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await serviceWith(null).executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'rules-missing-market'
    });

    expect(result.status).toBe(503);
    expect(result.body.code).toBe(MARKET_RULES_UNAVAILABLE);
    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
  });

  test('a manual LIMIT order is refused when the catalogue only has fallback data', async () => {
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await serviceWith(FALLBACK_ENTRY).placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'rules-missing-limit'
    });

    expect(result.status).toBe(503);
    expect(result.body.code).toBe(MARKET_RULES_UNAVAILABLE);
    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(0);
  });

  test('an accepted market order replays after its exchange rules disappear', async () => {
    const user = await createTestUser({ balance: 10000 });
    const params = {
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'rules-replay-market'
    };

    const accepted = await serviceWith(RULES).executeMarketOrder(params);
    expect(accepted.status).toBe(200);

    const before = await snapshotUser(user._id);
    const replayed = await serviceWith(null).executeMarketOrder(params);

    expect(replayed.status).toBe(200);
    expect(replayed.body.idempotent).toBe(true);
    expect(replayed.body.executedPrice).toBe(50000);
    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('an accepted limit order replays without reserving escrow twice', async () => {
    const user = await createTestUser({ balance: 10000 });
    const params = {
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      limitPrice: 40000,
      clientOrderId: 'rules-replay-limit'
    };

    const accepted = await serviceWith(RULES).placeLimitOrder(params);
    expect(accepted.status).toBe(200);

    const before = await snapshotUser(user._id);
    expect(before.lockedBalance).toBe(4000);

    const replayed = await serviceWith(null).placeLimitOrder(params);

    expect(replayed.status).toBe(200);
    expect(replayed.body.idempotent).toBe(true);
    expect(await snapshotUser(user._id)).toEqual(before);
    expect(await Order.countDocuments({ userId: user._id })).toBe(1);
  });

  test('a history-only pair still replays when it leaves the catalogue', async () => {
    const symbols = [...PINNED_SYMBOLS, 'DOGEUSDT'];
    const dynamicFeed = createMarketFeed({ symbols });
    dynamicFeed.setQuote('DOGEUSDT', 0.5);
    symbolUniverse.setActive(symbols);

    const user = await createTestUser({ balance: 10000 });
    const params = {
      userId: user._id,
      side: 'BUY',
      symbol: 'DOGEUSDT',
      quantity: 100,
      clientOrderId: 'rules-delisted-replay'
    };

    const accepted = await createTradeService({ feed: dynamicFeed })
      .executeMarketOrder(params);
    expect(accepted.status).toBe(200);

    symbolUniverse.setActive(PINNED_SYMBOLS);
    const before = await snapshotUser(user._id);
    const replayed = await createTradeService({ feed: dynamicFeed, getMarketRules: () => null })
      .executeMarketOrder(params);

    expect(replayed.status).toBe(200);
    expect(replayed.body.idempotent).toBe(true);
    expect(await snapshotUser(user._id)).toEqual(before);
  });
});

describe('existing open orders during a rules outage', () => {
  let now;
  let feed;

  beforeEach(() => {
    now = 1_700_000_000_000;
    feed = createMarketFeed({ now: () => now });
    feed.setQuote('BTCUSDT', 50000);
  });

  async function placeOpenBuy(user, clientOrderId) {
    const placed = await createTradeService({ feed, getMarketRules: () => RULES })
      .placeLimitOrder({
        userId: user._id,
        side: 'BUY',
        symbol: 'BTCUSDT',
        quantity: 0.1,
        limitPrice: 40000,
        clientOrderId
      });
    expect(placed.status).toBe(200);
    return placed.body.pendingOrders[0]._id;
  }

  test('a resting order can still be cancelled and releases its escrow', async () => {
    const user = await createTestUser({ balance: 10000 });
    const orderId = await placeOpenBuy(user, 'rules-outage-cancel');

    const cancelled = await createTradeService({ feed, getMarketRules: () => null })
      .cancelOrder({ orderId, userId: user._id });

    expect(cancelled.status).toBe(200);
    const after = await snapshotUser(user._id);
    expect(after.lockedBalance).toBe(0);
    expect(after.balance).toBe(10000);
    expect(after.pendingOrders).toEqual([]);
  });

  test('the matcher still fills a resting order instead of orphaning it', async () => {
    const user = await createTestUser({ balance: 10000 });
    await placeOpenBuy(user, 'rules-outage-fill');

    feed.setQuote('BTCUSDT', 39000);
    const matcher = createMatcher({
      feed,
      tradeService: createTradeService({ feed, getMarketRules: () => null, now: () => now }),
      now: () => now,
      workerId: 'worker-rules-outage'
    });

    const stats = await matcher.runCycle();
    expect(stats.filled).toBe(1);
    expect(stats.failed).toBe(0);

    const after = await snapshotUser(user._id);
    expect(after.lockedBalance).toBe(0);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 39000 }]);
  });
});
