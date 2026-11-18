export const PINNED_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);
export const CHART_INTERVALS = Object.freeze(['1m', '5m', '15m', '1h', '4h', '1d']);
export const MAX_WATCHLIST_SYMBOLS = 25;

const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;

export function normalizeSymbol(value) {
  if (typeof value !== 'string') return null;
  const symbol = value.trim().toUpperCase();
  return SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

export function normalizeSymbolList(value, max = MAX_WATCHLIST_SYMBOLS) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const symbols = [];
  for (const entry of value) {
    const symbol = normalizeSymbol(entry);
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push(symbol);
    if (symbols.length >= max) break;
  }
  return symbols;
}

export function toggleWatchlist(list, symbol, max = MAX_WATCHLIST_SYMBOLS) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return { symbols: list, rejected: 'INVALID_SYMBOL' };
  if (list.includes(normalized)) {
    return { symbols: list.filter(entry => entry !== normalized), rejected: null };
  }
  if (list.length >= max) return { symbols: list, rejected: 'LIMIT_REACHED' };
  return { symbols: [...list, normalized], rejected: null };
}

export function isFinitePrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

// Live socket quotes win; a catalogue snapshot is an acceptable fallback but is
// marked stale so the UI never presents it as a real-time tick. Nothing here
// fabricates a price when both sources are missing.
export function resolveQuote(market, quotes) {
  const live = market && quotes ? quotes[market.symbol] : null;
  if (live && isFinitePrice(live.price)) {
    return {
      price: live.price,
      changePercent: Number.isFinite(live.changePercent) ? live.changePercent : null,
      quoteVolume: Number.isFinite(live.quoteVolume) ? live.quoteVolume : null,
      live: true
    };
  }
  if (market && isFinitePrice(market.lastPrice)) {
    return {
      price: market.lastPrice,
      changePercent: Number.isFinite(market.priceChangePercent) ? market.priceChangePercent : null,
      quoteVolume: Number.isFinite(market.quoteVolume) ? market.quoteVolume : null,
      live: false
    };
  }
  return null;
}

export function formatPrice(value) {
  if (!isFinitePrice(value)) return '—';
  let maximumFractionDigits;
  if (value >= 1000) maximumFractionDigits = 2;
  else if (value >= 1) maximumFractionDigits = 4;
  else if (value >= 0.01) maximumFractionDigits = 4;
  else if (value >= 0.0001) maximumFractionDigits = 6;
  else maximumFractionDigits = 8;

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: value >= 1000 ? 2 : 0,
    maximumFractionDigits
  }).format(value);
}

export function formatPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatVolume(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(2)}K`;
  return value.toFixed(0);
}

export function formatUsd(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(value);
}

export function filterMarkets(markets, query) {
  if (!Array.isArray(markets)) return [];
  const term = typeof query === 'string' ? query.trim().toUpperCase() : '';
  if (!term) return markets;
  return markets.filter(market => (
    market.symbol.includes(term) || String(market.baseAsset || '').includes(term)
  ));
}

// Mirrors the backend's fail-closed rule: complete exchange filters must be
// known before a pair can be traded. A fallback or partial catalogue entry
// means the rules could not be verified, not that global limits apply.
export function marketTradingBlocked(market) {
  if (!market) return true;
  return ['tickSize', 'stepSize', 'minQty', 'minNotional']
    .some(field => !isFinitePrice(market[field]));
}

// Display stand-in for a failed catalogue request: only the pinned pairs the
// backend can always serve, with every price left unknown.
export function fallbackMarkets() {
  return PINNED_SYMBOLS.map(symbol => ({
    symbol,
    baseAsset: symbol.slice(0, -4),
    quoteAsset: 'USDT',
    lastPrice: null,
    priceChangePercent: null,
    quoteVolume: null,
    status: 'UNKNOWN',
    pinned: true
  }));
}

export function mergeWatchlistMarkets(markets, watchlist) {
  const bySymbol = new Map((markets || []).map(market => [market.symbol, market]));
  return normalizeSymbolList(watchlist || [])
    .map(symbol => bySymbol.get(symbol))
    .filter(Boolean);
}
