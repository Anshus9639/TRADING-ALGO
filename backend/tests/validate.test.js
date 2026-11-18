const {
  validateSymbol,
  validateSymbolFormat,
  validateSide,
  validateQuantity,
  validateLimitPrice,
  validateNotional
} = require('../lib/validate');
const { symbolUniverse } = require('../services/symbolUniverse');
const {
  roundTo,
  decimalPlaces,
  MIN_QUANTITY,
  MAX_QUANTITY,
  MAX_PRICE,
  MAX_NOTIONAL
} = require('../lib/numbers');

describe('validateSymbol', () => {
  test('normalizes whitespace and case', () => {
    expect(validateSymbol('  btcusdt ')).toEqual({ ok: true, value: 'BTCUSDT' });
    expect(validateSymbol('ethusdt')).toEqual({ ok: true, value: 'ETHUSDT' });
  });

  test('accepts every supported symbol', () => {
    for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']) {
      expect(validateSymbol(symbol)).toEqual({ ok: true, value: symbol });
    }
  });

  test('rejects unsupported and malformed symbols', () => {
    for (const symbol of ['DOGEUSDT', '', '   ', null, undefined, 123, {}]) {
      expect(validateSymbol(symbol).ok).toBe(false);
    }
  });

  test('follows the active universe instead of a fixed list', () => {
    symbolUniverse.setActive(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT']);
    try {
      expect(validateSymbol('dogeusdt')).toEqual({ ok: true, value: 'DOGEUSDT' });
      expect(validateSymbol('ADAUSDT').ok).toBe(false);
      expect(validateSymbol('ADAUSDT').error).toContain('DOGEUSDT');
    } finally {
      symbolUniverse.reset();
    }
  });

  test('format validation stays independent of the active universe', () => {
    symbolUniverse.setActive(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
    expect(validateSymbolFormat('DOGEUSDT')).toEqual({ ok: true, value: 'DOGEUSDT' });
    for (const symbol of ['', 'DOGE', 'DOGE/USDT', null, 42]) {
      expect(validateSymbolFormat(symbol).ok).toBe(false);
    }
  });
});

describe('validateSide', () => {
  test('accepts only exact BUY and SELL', () => {
    expect(validateSide('BUY')).toEqual({ ok: true, value: 'BUY' });
    expect(validateSide('SELL')).toEqual({ ok: true, value: 'SELL' });
  });

  test('rejects unknown sides instead of defaulting to SELL', () => {
    for (const side of ['buy', 'sell', 'HOLD', '', null, undefined, 1]) {
      expect(validateSide(side).ok).toBe(false);
    }
  });
});

describe('validateQuantity', () => {
  test('accepts positive quantities within limits and precision', () => {
    expect(validateQuantity(0.1)).toEqual({ ok: true, value: 0.1 });
    expect(validateQuantity(1)).toEqual({ ok: true, value: 1 });
    expect(validateQuantity(MIN_QUANTITY)).toEqual({ ok: true, value: MIN_QUANTITY });
    expect(validateQuantity(0.12345678)).toEqual({ ok: true, value: 0.12345678 });
    expect(validateQuantity(MAX_QUANTITY)).toEqual({ ok: true, value: MAX_QUANTITY });
  });

  test('rejects zero, negative, non-finite and non-number values', () => {
    for (const quantity of [0, -1, NaN, Infinity, -Infinity, '1', '0.1', null, undefined, {}, []]) {
      expect(validateQuantity(quantity).ok).toBe(false);
    }
  });

  test('rejects values below the minimum or above the maximum', () => {
    expect(validateQuantity(MIN_QUANTITY / 10).ok).toBe(false);
    expect(validateQuantity(MAX_QUANTITY + 1).ok).toBe(false);
  });

  test('rejects more than eight decimal places', () => {
    expect(validateQuantity(0.123456789).ok).toBe(false);
    expect(validateQuantity(1.000000001).ok).toBe(false);
  });
});

describe('validateLimitPrice', () => {
  test('accepts positive prices with at most eight decimals', () => {
    expect(validateLimitPrice(50000)).toEqual({ ok: true, value: 50000 });
    expect(validateLimitPrice(50000.12345678)).toEqual({ ok: true, value: 50000.12345678 });
    expect(validateLimitPrice(MAX_PRICE)).toEqual({ ok: true, value: MAX_PRICE });
  });

  test('rejects zero, negative, non-finite and malformed prices', () => {
    for (const price of [0, -1, NaN, Infinity, -Infinity, '50000', null, undefined, {}]) {
      expect(validateLimitPrice(price).ok).toBe(false);
    }
  });

  test('rejects excessive prices and more than eight decimals', () => {
    expect(validateLimitPrice(MAX_PRICE + 1).ok).toBe(false);
    expect(validateLimitPrice(50000.123456789).ok).toBe(false);
  });
});

describe('validateNotional', () => {
  test('calculates and rounds the order value', () => {
    expect(validateNotional(0.1, 50000)).toEqual({ ok: true, value: 5000 });
    expect(validateNotional(0.3, 0.1 + 0.2)).toEqual({ ok: true, value: 0.09 });
  });

  test('rejects non-positive, non-finite and excessive values', () => {
    expect(validateNotional(0, 50000).ok).toBe(false);
    expect(validateNotional(1, Infinity).ok).toBe(false);
    expect(validateNotional(MAX_QUANTITY, MAX_PRICE).ok).toBe(false);
    expect(validateNotional(MAX_NOTIONAL + 1, 1).ok).toBe(false);
  });
});

describe('numeric helpers', () => {
  test('roundTo applies eight-decimal rounding', () => {
    expect(roundTo(0.1 + 0.2)).toBe(0.3);
    expect(roundTo(1 / 3)).toBe(0.33333333);
    expect(roundTo(Number.NaN)).toBeNaN();
  });

  test('decimalPlaces handles plain and exponent forms', () => {
    expect(decimalPlaces(50000)).toBe(0);
    expect(decimalPlaces(0.1)).toBe(1);
    expect(decimalPlaces(0.00001)).toBe(5);
    expect(decimalPlaces(1e-8)).toBe(8);
    expect(decimalPlaces(1e-9)).toBe(9);
  });
});
