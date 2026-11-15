// Server-side market price cache. This is the ONLY authoritative source of
// prices for order execution. Prices submitted by clients are never trusted.

const DEFAULT_MAX_AGE_MS = Number(process.env.PRICE_MAX_AGE_MS) || 15000;

const cache = new Map(); // symbol -> { price, ts }

function setPrice(symbol, price, now = Date.now()) {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return false;
  cache.set(symbol, { price, ts: now });
  return true;
}

// Returns the latest price, or null if there is none or it is stale.
function getPrice(symbol, { maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const entry = cache.get(symbol);
  if (!entry) return null;
  if (now - entry.ts > maxAgeMs) return null;
  return entry.price;
}

function clearPrices() {
  cache.clear();
}

module.exports = { setPrice, getPrice, clearPrices, DEFAULT_MAX_AGE_MS };
