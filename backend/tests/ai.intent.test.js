const {
  validateModelIntent,
  resolveIntent,
  revalidateStoredIntent
} = require('../services/ai/intent');

function market(overrides = {}) {
  return {
    side: 'BUY',
    symbol: 'BTCUSDT',
    orderType: 'MARKET',
    quantity: 0.1,
    limitPrice: null,
    notional: null,
    allAvailable: null,
    clarification: null,
    ...overrides
  };
}

function quote(price = 50000) {
  return { status: 'ok', symbol: 'BTCUSDT', price, ts: 1700000000000 };
}

function context(overrides = {}) {
  return {
    balance: 10000,
    holdings: { BTCUSDT: 0.2, ETHUSDT: 1 },
    quoteFor: () => quote(),
    usdInrRate: 83,
    maxPriceDriftPct: 1.5,
    ...overrides
  };
}

describe('AI intent validation', () => {
  test('accepts a valid BUY and normalizes the symbol', () => {
    const result = validateModelIntent(market({ symbol: 'btcusdt' }));

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      side: 'BUY',
      symbol: 'BTCUSDT',
      orderType: 'MARKET',
      quantity: 0.1
    });
  });

  test('accepts a valid SELL', () => {
    const result = validateModelIntent(market({ side: 'sell', symbol: 'ETHUSDT' }));

    expect(result.ok).toBe(true);
    expect(result.value.side).toBe('SELL');
    expect(result.value.symbol).toBe('ETHUSDT');
  });

  test('rejects HOLD, UNKNOWN, null, and missing sides', () => {
    for (const side of ['HOLD', 'UNKNOWN', null, undefined]) {
      const result = validateModelIntent(market({ side }));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_INTENT');
    }
  });

  test('rejects unsupported symbols', () => {
    const result = validateModelIntent(market({ symbol: 'DOGEUSDT' }));

    expect(result.ok).toBe(false);
    expect(result.code).toBe('INVALID_INTENT');
    expect(result.message).toMatch(/Unsupported symbol/);
  });

  test('rejects negative, zero, null, malformed, and non-finite quantities', () => {
    const invalidQuantities = [-1, 0, '0.1', NaN, Infinity, {}];

    for (const quantity of invalidQuantities) {
      const result = validateModelIntent(market({ quantity }));
      expect(result.ok).toBe(false);
      expect(result.code).toBe('INVALID_INTENT');
    }

    const nullQuantity = validateModelIntent(market({ quantity: null }));
    expect(nullQuantity.ok).toBe(false);
    expect(nullQuantity.code).toBe('CLARIFICATION_REQUIRED');
  });

  test('rejects invalid order types', () => {
    for (const orderType of ['STOP', 'LIMIT-ORDER', null]) {
      const result = validateModelIntent(market({ orderType }));
      expect(result.ok).toBe(false);
    }
  });

  test('requires a valid limit price for LIMIT orders and none for MARKET orders', () => {
    expect(validateModelIntent(market({ orderType: 'LIMIT', limitPrice: null })).code)
      .toBe('CLARIFICATION_REQUIRED');

    for (const limitPrice of [0, -5, '40000', NaN, Infinity]) {
      const result = validateModelIntent(market({ orderType: 'LIMIT', limitPrice }));
      expect(result.ok).toBe(false);
    }

    const marketWithPrice = validateModelIntent(market({ limitPrice: 40000 }));
    expect(marketWithPrice.ok).toBe(false);

    const validLimit = validateModelIntent(
      market({ orderType: 'LIMIT', limitPrice: 40000, symbol: 'btcusdt' })
    );
    expect(validLimit.ok).toBe(true);
    expect(validLimit.value.limitPrice).toBe(40000);
  });

  test('rejects unexpected properties such as prices, urls, and user ids', () => {
    for (const extra of [
      { price: 1 },
      { executedPrice: 1 },
      { apiUrl: 'https://example.com' },
      { userId: 'someone-else' }
    ]) {
      const result = validateModelIntent(market(extra));
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/unexpected properties/);
    }
  });

  test('validates notional objects strictly', () => {
    const valid = validateModelIntent(
      market({ quantity: null, notional: { amount: 100, currency: 'usd' } })
    );
    expect(valid.ok).toBe(true);
    expect(valid.value.notional).toEqual({ amount: 100, currency: 'USD' });

    expect(validateModelIntent(market({ quantity: null, notional: { amount: -100, currency: 'USD' } })).ok)
      .toBe(false);
    expect(validateModelIntent(market({ quantity: null, notional: { amount: 100 } })).code)
      .toBe('CLARIFICATION_REQUIRED');
    expect(validateModelIntent(
      market({ quantity: null, notional: { amount: 100, currency: 'USD', extra: true } })
    ).ok).toBe(false);
  });

  test('rejects allAvailable for BUY and when combined with another size', () => {
    expect(validateModelIntent(market({ allAvailable: true })).ok).toBe(false);
    expect(validateModelIntent(market({ side: 'SELL', allAvailable: true, quantity: 1 })).ok).toBe(false);
  });

  test('returns clarification instead of guessing an ambiguous instruction', () => {
    const result = validateModelIntent(
      market({ quantity: null, notional: null, allAvailable: null })
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('CLARIFICATION_REQUIRED');
    expect(result.clarification).toMatch(/How much/);
  });

  test('passes through an explicit clarification', () => {
    const result = validateModelIntent(
      market({ side: null, symbol: null, orderType: null, quantity: null, clarification: 'Which asset?' })
    );

    expect(result.ok).toBe(false);
    expect(result.code).toBe('CLARIFICATION_REQUIRED');
    expect(result.clarification).toBe('Which asset?');
  });
});

describe('AI intent resolution against server data', () => {
  test('market orders use the server quote for sizing and preview', () => {
    const modelIntent = validateModelIntent(market()).value;
    const resolved = resolveIntent({ modelIntent, context: context() });

    expect(resolved.ok).toBe(true);
    expect(resolved.value.intent.referencePrice).toBe(50000);
    expect(resolved.value.preview.quotePrice).toBe(50000);
    expect(resolved.value.preview.estimatedValue).toBe(5000);
  });

  test('USD notional is converted server-side into a quantity', () => {
    const modelIntent = validateModelIntent(
      market({ quantity: null, notional: { amount: 100, currency: 'USD' } })
    ).value;
    const resolved = resolveIntent({ modelIntent, context: context() });

    expect(resolved.ok).toBe(true);
    expect(resolved.value.intent.quantity).toBe(0.002);
    expect(resolved.value.preview.estimatedValue).toBe(100);
    expect(resolved.value.preview.warnings.join(' ')).toMatch(/1:1 with USDT/);
  });

  test('INR requires an explicit rate and is never silently treated as USDT', () => {
    const modelIntent = validateModelIntent(
      market({ quantity: null, notional: { amount: 8300, currency: 'INR' } })
    ).value;

    const withoutRate = resolveIntent({
      modelIntent,
      context: context({ usdInrRate: null })
    });
    expect(withoutRate.ok).toBe(false);
    expect(withoutRate.code).toBe('CLARIFICATION_REQUIRED');

    const withRate = resolveIntent({ modelIntent, context: context({ usdInrRate: 83 }) });
    expect(withRate.ok).toBe(true);
    expect(withRate.value.intent.quantity).toBe(0.002);
    expect(withRate.value.preview.warnings.join(' ')).toMatch(/INR/);
  });

  test('SELL ALL resolves against available holdings only', () => {
    const modelIntent = validateModelIntent(
      market({ side: 'SELL', quantity: null, allAvailable: true })
    ).value;
    const resolved = resolveIntent({ modelIntent, context: context() });

    expect(resolved.ok).toBe(true);
    expect(resolved.value.intent.quantity).toBe(0.2);
    expect(resolved.value.preview.availableQuantity).toBe(0.2);
  });

  test('SELL ALL with no available holdings is rejected', () => {
    const modelIntent = validateModelIntent(
      market({ side: 'SELL', quantity: null, allAvailable: true })
    ).value;
    const resolved = resolveIntent({
      modelIntent,
      context: context({ holdings: {} })
    });

    expect(resolved.ok).toBe(false);
    expect(resolved.code).toBe('INSUFFICIENT_ASSET');
  });

  test('insufficient balance and holdings are surfaced as warnings', () => {
    const buy = resolveIntent({
      modelIntent: validateModelIntent(market()).value,
      context: context({ balance: 100 })
    });
    expect(buy.ok).toBe(true);
    expect(buy.value.preview.warnings.join(' ')).toMatch(/Insufficient USDT balance/);

    const sell = resolveIntent({
      modelIntent: validateModelIntent(market({ side: 'SELL', quantity: 1 })).value,
      context: context({ holdings: { BTCUSDT: 0.2 } })
    });
    expect(sell.ok).toBe(true);
    expect(sell.value.preview.warnings.join(' ')).toMatch(/Insufficient BTCUSDT/);
  });

  test('missing or stale market quotes block proposal construction', () => {
    const modelIntent = validateModelIntent(market()).value;

    const missing = resolveIntent({
      modelIntent,
      context: context({ quoteFor: () => ({ status: 'missing' }) })
    });
    expect(missing.ok).toBe(false);
    expect(missing.code).toBe('PRICE_UNAVAILABLE');

    const stale = resolveIntent({
      modelIntent,
      context: context({ quoteFor: () => ({ status: 'stale' }) })
    });
    expect(stale.ok).toBe(false);
    expect(stale.code).toBe('PRICE_UNAVAILABLE');
  });
});

describe('stored intent revalidation', () => {
  test('accepts the server-built intent and rejects injected properties', () => {
    const stored = {
      side: 'BUY',
      symbol: 'BTCUSDT',
      orderType: 'MARKET',
      quantity: 0.1,
      limitPrice: null,
      referencePrice: 50000
    };

    expect(revalidateStoredIntent(stored).ok).toBe(true);
    expect(revalidateStoredIntent({ ...stored, price: 1 }).ok).toBe(false);
    expect(revalidateStoredIntent({ ...stored, quantity: -1 }).ok).toBe(false);
    expect(revalidateStoredIntent({ ...stored, side: 'HOLD' }).ok).toBe(false);
    expect(revalidateStoredIntent({ ...stored, orderType: 'LIMIT' }).ok).toBe(false);
  });
});
