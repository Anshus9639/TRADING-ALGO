const { PINNED_SYMBOLS, normalizeSymbol } = require('../lib/symbols');

const DEFAULT_SYMBOLS = PINNED_SYMBOLS;
const DEFAULT_MAX_AGE_MS = 15000;

function isUsablePrice(price) {
  return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

function createMarketFeed({
  symbols = DEFAULT_SYMBOLS,
  now = Date.now,
  defaultMaxAgeMs = DEFAULT_MAX_AGE_MS
} = {}) {
  const supported = new Set(symbols.map(s => normalizeSymbol(s)).filter(Boolean));
  const quotes = new Map();

  function setSymbols(symbols) {
    if (!Array.isArray(symbols)) return Array.from(supported);
    const next = new Set();
    for (const item of symbols) {
      const normalized = normalizeSymbol(item);
      if (normalized) next.add(normalized);
    }
    if (next.size === 0) return Array.from(supported);

    supported.clear();
    for (const symbol of next) supported.add(symbol);
    // A quote for a pair that is no longer in the universe must not be reused
    // if the pair returns later; force a fresh observation instead.
    for (const symbol of Array.from(quotes.keys())) {
      if (!supported.has(symbol)) quotes.delete(symbol);
    }
    return Array.from(supported);
  }

  function hasSymbol(symbol) {
    const normalized = normalizeSymbol(symbol);
    return Boolean(normalized && supported.has(normalized));
  }

  function setQuote(symbol, price) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || !supported.has(normalized) || !isUsablePrice(price)) return false;
    quotes.set(normalized, { price, ts: now() });
    return true;
  }

  function getQuote(symbol, maxAgeMs = defaultMaxAgeMs) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized || !supported.has(normalized)) {
      return { status: 'missing', symbol: normalized };
    }

    const quote = quotes.get(normalized);
    if (!quote) return { status: 'missing', symbol: normalized };

    const limit = Number.isFinite(maxAgeMs) && maxAgeMs >= 0 ? maxAgeMs : defaultMaxAgeMs;
    const ageMs = now() - quote.ts;

    // Non-finite or negative ages cannot be proven fresh — negative ages mean
    // the clock moved backwards — so both are treated as stale.
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > limit) {
      return { status: 'stale', symbol: normalized, ageMs };
    }

    return {
      status: 'ok',
      symbol: normalized,
      price: quote.price,
      ts: quote.ts,
      ageMs
    };
  }

  function reset() {
    quotes.clear();
  }

  return {
    setQuote,
    getQuote,
    setSymbols,
    hasSymbol,
    reset,
    supportedSymbols: () => Array.from(supported)
  };
}

const defaultFeed = createMarketFeed();

module.exports = {
  createMarketFeed,
  normalizeSymbol,
  marketFeed: defaultFeed,
  setQuote: defaultFeed.setQuote,
  getQuote: defaultFeed.getQuote,
  setSymbols: defaultFeed.setSymbols,
  hasSymbol: defaultFeed.hasSymbol,
  reset: defaultFeed.reset,
  supportedSymbols: defaultFeed.supportedSymbols,
  DEFAULT_SYMBOLS,
  DEFAULT_MAX_AGE_MS
};
