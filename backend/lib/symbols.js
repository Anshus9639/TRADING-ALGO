// Exchange symbols are uppercase alphanumeric identifiers. This is a format
// check only: whether a symbol is currently tradeable is decided by the
// catalogue registry, never by a user-supplied string.
const SYMBOL_PATTERN = /^[A-Z0-9]{5,20}$/;

const PINNED_SYMBOLS = Object.freeze(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']);

function normalizeSymbol(value) {
  if (typeof value !== 'string') return null;
  const symbol = value.trim().toUpperCase();
  return SYMBOL_PATTERN.test(symbol) ? symbol : null;
}

function isSymbolFormat(value) {
  return normalizeSymbol(value) !== null;
}

module.exports = {
  SYMBOL_PATTERN,
  PINNED_SYMBOLS,
  normalizeSymbol,
  isSymbolFormat
};
