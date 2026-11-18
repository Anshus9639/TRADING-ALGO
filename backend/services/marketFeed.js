const DEFAULT_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
const DEFAULT_MAX_AGE_MS = 15000;

function normalizeSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const normalized = symbol.trim().toUpperCase();
  return normalized || null;
}

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
  reset: defaultFeed.reset,
  supportedSymbols: defaultFeed.supportedSymbols,
  DEFAULT_SYMBOLS,
  DEFAULT_MAX_AGE_MS
};
