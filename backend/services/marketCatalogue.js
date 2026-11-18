const axios = require('axios');
const { PINNED_SYMBOLS, normalizeSymbol } = require('../lib/symbols');
const { symbolUniverse } = require('./symbolUniverse');

const EXCHANGE_INFO_URL = 'https://api.binance.us/api/v3/exchangeInfo';
const TICKER_24H_URL = 'https://api.binance.us/api/v3/ticker/24hr';

const DEFAULT_UNIVERSE_SIZE = 40;
const MIN_UNIVERSE_SIZE = 4;
const MAX_UNIVERSE_SIZE = 50;
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8000;
const MIN_LIVE_SYMBOLS = 4;
const QUOTE_ASSET = 'USDT';

// Stablecoin and fiat bases produce noise rather than useful trading markets.
const EXCLUDED_BASE_ASSETS = new Set([
  'USDC', 'BUSD', 'TUSD', 'USDP', 'DAI', 'FDUSD', 'USDD', 'PAX', 'GUSD',
  'FRAX', 'LUSD', 'EUR', 'GBP', 'TRY', 'BRL', 'AUD', 'JPY', 'ZAR', 'RUB',
  'UAH', 'NGN', 'IDR', 'PLN', 'RON', 'ARS', 'BIDR', 'BVND'
]);

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function readFilter(filters, filterType) {
  if (!Array.isArray(filters)) return null;
  return filters.find(filter => filter && filter.filterType === filterType) || null;
}

function isEligibleSymbol(info, ticker) {
  if (!info || typeof info !== 'object' || !ticker) return false;
  // Exchange status gates new orders only: non-TRADING pairs never enter the
  // active set. Orders accepted earlier still replay through the historical
  // universe, so a later status change must not be re-applied to them here.
  if (info.status !== 'TRADING') return false;
  if (info.quoteAsset !== QUOTE_ASSET) return false;
  if (info.isSpotTradingAllowed === false) return false;
  if (Array.isArray(info.permissions) && info.permissions.includes('LEVERAGED')) return false;
  if (EXCLUDED_BASE_ASSETS.has(String(info.baseAsset))) return false;
  if (!normalizeSymbol(info.symbol)) return false;

  return Number.isFinite(ticker.lastPrice)
    && ticker.lastPrice > 0
    && Number.isFinite(ticker.quoteVolume)
    && ticker.quoteVolume > 0;
}

function buildMarket(info, ticker) {
  const priceFilter = readFilter(info.filters, 'PRICE_FILTER');
  const lotSize = readFilter(info.filters, 'LOT_SIZE');
  const notional = readFilter(info.filters, 'NOTIONAL') || readFilter(info.filters, 'MIN_NOTIONAL');

  return {
    symbol: normalizeSymbol(info.symbol),
    baseAsset: String(info.baseAsset || '').toUpperCase(),
    quoteAsset: QUOTE_ASSET,
    lastPrice: ticker.lastPrice,
    priceChangePercent: Number.isFinite(ticker.priceChangePercent) ? ticker.priceChangePercent : null,
    quoteVolume: ticker.quoteVolume,
    status: 'TRADING',
    pinned: PINNED_SYMBOLS.includes(info.symbol),
    tickSize: priceFilter ? finiteNumber(priceFilter.tickSize) : null,
    stepSize: lotSize ? finiteNumber(lotSize.stepSize) : null,
    minQty: lotSize ? finiteNumber(lotSize.minQty) : null,
    minNotional: notional ? finiteNumber(notional.minNotional) : null
  };
}

// Pure selection step so catalogue tests never need the network.
function selectMarkets(exchangeSymbols, tickers, { limit = DEFAULT_UNIVERSE_SIZE } = {}) {
  const size = Math.min(MAX_UNIVERSE_SIZE, Math.max(MIN_UNIVERSE_SIZE, Math.round(limit)));
  if (!Array.isArray(exchangeSymbols) || !Array.isArray(tickers)) return [];

  const tickerBySymbol = new Map();
  for (const row of tickers) {
    const symbol = normalizeSymbol(row && row.symbol);
    if (!symbol) continue;
    tickerBySymbol.set(symbol, {
      lastPrice: finiteNumber(row.lastPrice),
      priceChangePercent: finiteNumber(row.priceChangePercent),
      quoteVolume: finiteNumber(row.quoteVolume)
    });
  }

  const eligible = [];
  const seen = new Set();
  for (const info of exchangeSymbols) {
    const symbol = normalizeSymbol(info && info.symbol);
    if (!symbol || seen.has(symbol)) continue;
    const ticker = tickerBySymbol.get(symbol);
    if (!isEligibleSymbol(info, ticker)) continue;
    seen.add(symbol);
    eligible.push(buildMarket(info, ticker));
  }

  const bySymbol = new Map(eligible.map(market => [market.symbol, market]));
  const pinned = PINNED_SYMBOLS
    .map(symbol => bySymbol.get(symbol))
    .filter(Boolean);
  const pinnedSet = new Set(pinned.map(market => market.symbol));
  const remaining = eligible
    .filter(market => !pinnedSet.has(market.symbol))
    .sort((left, right) => right.quoteVolume - left.quoteVolume || left.symbol.localeCompare(right.symbol));

  return [...pinned, ...remaining].slice(0, size);
}

function fallbackCatalogue(activeSymbols, now) {
  return {
    source: 'fallback',
    stale: true,
    updatedAt: new Date(now()).toISOString(),
    symbols: activeSymbols.map(symbol => ({
      symbol,
      baseAsset: symbol.endsWith(QUOTE_ASSET) ? symbol.slice(0, -QUOTE_ASSET.length) : symbol,
      quoteAsset: QUOTE_ASSET,
      lastPrice: null,
      priceChangePercent: null,
      quoteVolume: null,
      status: 'UNKNOWN',
      pinned: PINNED_SYMBOLS.includes(symbol),
      tickSize: null,
      stepSize: null,
      minQty: null,
      minNotional: null
    }))
  };
}

function createMarketCatalogue({
  universe = symbolUniverse,
  http = axios,
  now = Date.now,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  limit = DEFAULT_UNIVERSE_SIZE,
  onUpdate = null,
  logger = console
} = {}) {
  const safeTtl = Number.isFinite(ttlMs) && ttlMs >= 1000 ? ttlMs : DEFAULT_CACHE_TTL_MS;
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 500 ? timeoutMs : DEFAULT_TIMEOUT_MS;

  let data = fallbackCatalogue(universe.listActive(), now);
  let lastGood = null;
  let expiresAt = 0;
  let inFlight = null;
  let timer = null;
  let lastErrorCode = null;

  async function fetchJson(url) {
    const response = await http.get(url, { timeout: safeTimeout });
    return response && response.data;
  }

  async function refreshLive() {
    const [exchangeInfo, tickers] = await Promise.all([
      fetchJson(EXCHANGE_INFO_URL),
      fetchJson(TICKER_24H_URL)
    ]);

    if (!exchangeInfo || !Array.isArray(exchangeInfo.symbols)) {
      throw new Error('MALFORMED_EXCHANGE_INFO');
    }
    if (!Array.isArray(tickers)) {
      throw new Error('MALFORMED_TICKERS');
    }

    const symbols = selectMarkets(exchangeInfo.symbols, tickers, { limit });
    if (symbols.length < MIN_LIVE_SYMBOLS) {
      throw new Error('INSUFFICIENT_LIVE_MARKETS');
    }

    universe.setActive(symbols.map(market => market.symbol));
    const next = {
      source: 'live',
      stale: false,
      updatedAt: new Date(now()).toISOString(),
      symbols
    };

    data = next;
    lastGood = next;
    lastErrorCode = null;
    expiresAt = now() + safeTtl;

    if (typeof onUpdate === 'function') {
      try {
        onUpdate(next);
      } catch (err) {
        logger.error('Market catalogue update handler failed:', err.message);
      }
    }

    return next;
  }

  async function getCatalogue({ force = false } = {}) {
    if (!force && now() < expiresAt) return data;
    if (inFlight) return inFlight;

    inFlight = refreshLive()
      .catch(err => {
        lastErrorCode = err && err.code ? String(err.code) : 'CATALOGUE_REFRESH_FAILED';
        logger.error('Market catalogue refresh failed:', lastErrorCode);

        if (lastGood) {
          // Keep the last complete live catalogue. It is marked stale, but the
          // prices and trading set remain the most recent authoritative view.
          data = { ...lastGood, stale: true, source: 'cache' };
        } else {
          data = fallbackCatalogue(universe.listActive(), now);
        }
        expiresAt = now() + Math.min(safeTtl, 60000);
        return data;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  }

  function start({ intervalMs = safeTtl } = {}) {
    if (timer) return;
    getCatalogue().catch(() => {});
    const period = Number.isFinite(intervalMs) && intervalMs >= 30000 ? intervalMs : safeTtl;
    timer = setInterval(() => {
      getCatalogue({ force: true }).catch(() => {});
    }, period);
    if (typeof timer.unref === 'function') timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function getSymbol(symbol) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return null;
    return data.symbols.find(market => market.symbol === normalized) || null;
  }

  function snapshot() {
    return data;
  }

  function diagnostics() {
    return {
      source: data.source,
      stale: data.stale,
      count: data.symbols.length,
      updatedAt: data.updatedAt,
      lastErrorCode
    };
  }

  return {
    getCatalogue,
    getSymbol,
    snapshot,
    diagnostics,
    start,
    stop
  };
}

module.exports = {
  createMarketCatalogue,
  selectMarkets,
  fallbackCatalogue,
  EXCHANGE_INFO_URL,
  TICKER_24H_URL,
  DEFAULT_UNIVERSE_SIZE,
  MIN_UNIVERSE_SIZE,
  MAX_UNIVERSE_SIZE,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_TIMEOUT_MS
};
