const {
  alignsToStep,
  floorToStep,
  checkMarketRules,
  hasUsableMarketRules
} = require('../lib/exchangeFilters');
const { resolveIntent } = require('../services/ai/intent');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
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

beforeAll(async () => {
  await startTestDb();
}, 120000);

afterAll(async () => {
  await stopTestDb();
});

describe('exchange filter helpers', () => {
  test('detects whole multiples without binary drift false negatives', () => {
    expect(alignsToStep(0.3, 0.1)).toBe(true);
    expect(alignsToStep(64000.12, 0.01)).toBe(true);
    expect(alignsToStep(775, 1)).toBe(true);
    expect(alignsToStep(0.001, 0.001)).toBe(true);

    expect(alignsToStep(0.0015, 0.001)).toBe(false);
    expect(alignsToStep(64000.12345678, 0.01)).toBe(false);
    expect(alignsToStep(775.5, 1)).toBe(false);
    expect(alignsToStep(0, 0.001)).toBe(false);
  });

  test('floors derived quantities onto the step grid and never rounds up', () => {
    expect(floorToStep(0.00166667, 0.001)).toBe(0.001);
    expect(floorToStep(775.79519006, 1)).toBe(775);
    expect(floorToStep(0.3, 0.1)).toBe(0.3);
    expect(floorToStep(0.001, 0.001)).toBe(0.001);
    expect(floorToStep(0.001, undefined)).toBe(0.001);
  });

  test('skips filter checks when the catalogue has no rules', () => {
    expect(checkMarketRules({ quantity: 0.0015, price: 50000.25, rules: null })).toEqual({ ok: true });
    expect(checkMarketRules({ quantity: 0.0015, rules: {} })).toEqual({ ok: true });
  });

  test('rejects misaligned quantities, sub-minimum lots and off-tick prices', () => {
    expect(checkMarketRules({ quantity: 0.0015, rules: RULES }).ok).toBe(false);
    expect(checkMarketRules({ quantity: 0.0005, rules: RULES }).ok).toBe(false);
    expect(checkMarketRules({ quantity: 0.001, price: 50000.25, rules: RULES }).ok).toBe(false);
    expect(checkMarketRules({ quantity: 0.001, price: 50000.5, rules: RULES }).ok).toBe(true);
  });

  test('checks minimum notional against the resulting order value', () => {
    expect(checkMarketRules({ quantity: 0.001, price: 100, rules: RULES }).ok).toBe(false);
    expect(checkMarketRules({ quantity: 0.001, price: 10000, rules: RULES }).ok).toBe(true);
  });

  test('does not require a market observation to sit on the tick grid', () => {
    expect(checkMarketRules({
      quantity: 0.001,
      price: 50000.25,
      rules: RULES,
      enforceTick: false
    })).toEqual({ ok: true });
  });

  test('rejects ratios too large to verify instead of skipping step alignment', () => {
    // value / step = 1e18, far beyond the range where a nearest-integer
    // comparison can be trusted.
    expect(alignsToStep(1_000_000, 1e-12)).toBe(false);
    expect(checkMarketRules({
      quantity: 1_000_000,
      rules: { ...RULES, stepSize: 1e-12 }
    }).ok).toBe(false);

    // A server-derived size cannot slip past the same gate after flooring.
    const floored = floorToStep(1_000_000, 1e-12);
    expect(checkMarketRules({
      quantity: floored,
      rules: { ...RULES, stepSize: 1e-12 }
    }).ok).toBe(false);
  });

  test('rejects non-finite values and treats unusable steps as no constraint', () => {
    expect(alignsToStep(Number.NaN, 0.1)).toBe(false);
    expect(alignsToStep(Number.POSITIVE_INFINITY, 0.1)).toBe(false);
    expect(alignsToStep(0, 0.001)).toBe(false);

    // A non-positive or non-finite step is rejected upstream by
    // hasUsableMarketRules; the helper itself must never divide by zero.
    expect(alignsToStep(1, 0)).toBe(true);
    expect(alignsToStep(1, -1)).toBe(true);
    expect(alignsToStep(1, Number.NaN)).toBe(true);
    expect(alignsToStep(1, Number.POSITIVE_INFINITY)).toBe(true);

    expect(hasUsableMarketRules({ ...RULES, stepSize: 0 })).toBe(false);
    expect(hasUsableMarketRules({ ...RULES, stepSize: -1 })).toBe(false);
    expect(hasUsableMarketRules({ ...RULES, stepSize: Number.NaN })).toBe(false);
    expect(hasUsableMarketRules({ ...RULES, stepSize: Number.POSITIVE_INFINITY })).toBe(false);
  });

  test('rejects non-finite quantities and prices even when the tick is not enforced', () => {
    expect(checkMarketRules({ quantity: Number.NaN, rules: RULES }).ok).toBe(false);
    expect(checkMarketRules({ quantity: Number.POSITIVE_INFINITY, rules: RULES }).ok).toBe(false);
    expect(checkMarketRules({
      quantity: 0.001,
      price: Number.NaN,
      rules: RULES,
      enforceTick: false
    }).ok).toBe(false);
    expect(checkMarketRules({
      quantity: 0.001,
      price: Number.POSITIVE_INFINITY,
      rules: RULES,
      enforceTick: false
    }).ok).toBe(false);
  });
});

describe('AI intent resolution with exchange filters', () => {
  const context = {
    balance: 10000,
    holdings: {},
    quoteFor: () => ({ status: 'ok', price: 64000, ts: 1 }),
    marketRulesFor: () => RULES,
    usdInrRate: null,
    maxPriceDriftPct: 1.5
  };

  test('floors a notional-derived quantity onto the step grid', () => {
    const resolved = resolveIntent({
      modelIntent: {
        side: 'BUY',
        symbol: 'BTCUSDT',
        orderType: 'MARKET',
        quantity: null,
        notional: { amount: 100, currency: 'USDT' },
        allAvailable: false,
        limitPrice: null
      },
      context
    });

    expect(resolved.ok).toBe(true);
    expect(resolved.value.intent.quantity).toBe(0.001);
    expect(resolved.value.preview.warnings.join(' ')).toContain('floored');
  });

  test('rejects, rather than rewrites, an explicitly requested off-step quantity', () => {
    const resolved = resolveIntent({
      modelIntent: {
        side: 'BUY',
        symbol: 'BTCUSDT',
        orderType: 'MARKET',
        quantity: 0.0015,
        notional: null,
        allAvailable: false,
        limitPrice: null
      },
      context
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.message).toContain('multiple of 0.001');
  });

  test('rejects a limit price that is not on the tick grid', () => {
    const resolved = resolveIntent({
      modelIntent: {
        side: 'BUY',
        symbol: 'BTCUSDT',
        orderType: 'LIMIT',
        quantity: 0.01,
        notional: null,
        allAvailable: false,
        limitPrice: 64000.25
      },
      context
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.message).toContain('multiple of 0.5');
  });

  test('rejects an order below the market minimum notional', () => {
    const resolved = resolveIntent({
      modelIntent: {
        side: 'BUY',
        symbol: 'BTCUSDT',
        orderType: 'LIMIT',
        quantity: 0.001,
        notional: null,
        allAvailable: false,
        limitPrice: 100
      },
      context
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.message).toContain('market minimum of 10 USDT');
  });
});

describe('trade service enforcement of exchange filters', () => {
  let feed;
  let service;
  let now;
  let orderSeq = 0;

  beforeEach(() => {
    now = 1_700_000_000_000;
    orderSeq = 0;
    feed = createMarketFeed({ now: () => now });
    service = createTradeService({ feed, getMarketRules: () => RULES });
    feed.setQuote('BTCUSDT', 50000);
  });

  function nextId() {
    orderSeq += 1;
    return `precision-test-${orderSeq}`;
  }

  test('accepts an aligned market order and rejects a misaligned one without mutation', async () => {
    const user = await createTestUser({ balance: 10000 });

    const accepted = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: nextId()
    });
    expect(accepted.status).toBe(200);

    const before = await snapshotUser(user._id);
    const rejected = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.0015,
      clientOrderId: nextId()
    });

    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('INVALID_ORDER_PRECISION');
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('rejects a limit price off the tick grid without reserving escrow', async () => {
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.01,
      limitPrice: 50000.25,
      clientOrderId: nextId()
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_ORDER_PRECISION');
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('rejects a limit order below the market minimum notional', async () => {
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await service.placeLimitOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.001,
      limitPrice: 100,
      clientOrderId: nextId()
    });

    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_ORDER_PRECISION');
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('an idempotent replay still succeeds after the market rules tighten', async () => {
    const user = await createTestUser({ balance: 10000 });
    const clientOrderId = nextId();
    const params = {
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.0015,
      limitPrice: 50000,
      clientOrderId
    };

    // Placed before any catalogue rules exist, then replayed by a service that
    // requires them. The prior-order replay must win over the stricter check.
    const permissive = createTradeService({ feed });
    const placed = await permissive.placeLimitOrder(params);
    expect(placed.status).toBe(200);

    const replayed = await service.placeLimitOrder(params);
    expect(replayed.status).toBe(200);
    expect(replayed.body.idempotent).toBe(true);
  });
});

describe('market order settlement quote freshness', () => {
  test('a quote that expires between acceptance and settlement blocks the trade', async () => {
    let calls = 0;
    const feed = {
      getQuote() {
        calls += 1;
        return calls === 1
          ? { status: 'ok', price: 50000, ts: Date.now() }
          : { status: 'stale' };
      }
    };
    const service = createTradeService({ feed });
    const user = await createTestUser({ balance: 10000 });
    const before = await snapshotUser(user._id);

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 0.1,
      clientOrderId: 'settlement-quote-1'
    });

    expect(result.status).toBe(503);
    expect(result.body.message).toContain('expired before settlement');
    expect(await snapshotUser(user._id)).toEqual(before);
  });
});
