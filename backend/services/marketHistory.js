const axios = require('axios');

const KLINE_URL = 'https://api.binance.us/api/v3/klines';
const KLINE_LIMIT = 500;
const DEFAULT_TTL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_CACHED_SERIES = 200;

// Bounded, short-lived candle cache. Concurrent viewers of the same symbol and
// interval share one upstream request instead of each polling Binance.
function createHistoryFetcher({
  http = axios,
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const cache = new Map();
  const safeTtl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS;

  async function fetchKlines({ symbol, interval }) {
    const key = `${symbol}:${interval}`;
    const cached = cache.get(key);
    if (cached && now() < cached.expiresAt) return cached.data;

    const query = new URLSearchParams({
      symbol,
      interval,
      limit: String(KLINE_LIMIT)
    });
    const response = await http.get(`${KLINE_URL}?${query}`, { timeout: timeoutMs });
    const data = response && response.data;
    if (!Array.isArray(data)) throw new Error('MALFORMED_KLINES');

    cache.set(key, { data, expiresAt: now() + safeTtl });
    while (cache.size > MAX_CACHED_SERIES) {
      cache.delete(cache.keys().next().value);
    }
    return data;
  }

  // Exposed so the response can advertise exactly the lifetime of the cache
  // that produced it instead of an unrelated, longer proxy lifetime.
  return { fetchKlines, ttlMs: safeTtl };
}

module.exports = {
  KLINE_URL,
  KLINE_LIMIT,
  createHistoryFetcher
};
