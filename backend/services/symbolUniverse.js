const { PINNED_SYMBOLS, normalizeSymbol } = require('../lib/symbols');

// Two sets are kept on purpose. "Active" gates new order placement, while
// "known" retains every symbol this process has ever seen so a catalogue
// refresh can never invalidate an idempotent retry or make the matcher
// force-refund an order for a temporarily missing pair.
function createSymbolUniverse({ symbols = PINNED_SYMBOLS } = {}) {
  const active = new Set();
  const historical = new Set();
  let snapshot = Object.freeze([]);

  function setActive(list) {
    if (!Array.isArray(list)) return snapshot;

    const next = [];
    const seen = new Set();
    for (const item of list) {
      const symbol = normalizeSymbol(item);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      next.push(symbol);
      historical.add(symbol);
    }

    // An empty catalogue is treated as a failed refresh: the previous active
    // set stays in place instead of silently disabling every market.
    if (next.length === 0) return snapshot;

    active.clear();
    for (const symbol of next) active.add(symbol);
    snapshot = Object.freeze(next);
    return snapshot;
  }

  function reset(next = PINNED_SYMBOLS) {
    active.clear();
    historical.clear();
    snapshot = Object.freeze([]);
    return setActive(next);
  }

  function isActive(value) {
    const symbol = normalizeSymbol(value);
    return Boolean(symbol && active.has(symbol));
  }

  function isKnown(value) {
    const symbol = normalizeSymbol(value);
    return Boolean(symbol && historical.has(symbol));
  }

  function listActive() {
    return snapshot;
  }

  function listKnown() {
    return Object.freeze(Array.from(historical));
  }

  setActive(symbols);

  return {
    setActive,
    reset,
    isActive,
    isKnown,
    listActive,
    listKnown
  };
}

const defaultUniverse = createSymbolUniverse();

module.exports = {
  createSymbolUniverse,
  symbolUniverse: defaultUniverse,
  setActiveSymbols: defaultUniverse.setActive,
  isActiveSymbol: defaultUniverse.isActive,
  isKnownSymbol: defaultUniverse.isKnown,
  listActiveSymbols: defaultUniverse.listActive
};
