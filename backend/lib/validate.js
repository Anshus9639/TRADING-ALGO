// Strict input validation for trading requests.
// Everything coming from the client (or from the AI copilot) is untrusted.

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'];
const MAX_QUANTITY = 1e6;
const MAX_PRICE = 1e9;

// Accept only real numbers or numeric strings. Booleans, null, arrays,
// objects, '', NaN and Infinity are all rejected.
function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseSymbol(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim().toUpperCase();
  return SYMBOLS.includes(s) ? s : null;
}

function parsePositive(value, max) {
  const n = toFiniteNumber(value);
  if (n === null || n <= 0 || n > max) return null;
  return n;
}

const parseQuantity = (v) => parsePositive(v, MAX_QUANTITY);
const parsePrice = (v) => parsePositive(v, MAX_PRICE);

function parseSide(value) {
  return value === 'BUY' || value === 'SELL' ? value : null;
}

module.exports = {
  SYMBOLS,
  MAX_QUANTITY,
  MAX_PRICE,
  toFiniteNumber,
  parseSymbol,
  parseQuantity,
  parsePrice,
  parseSide,
};
