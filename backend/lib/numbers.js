const DECIMALS = 8;
const MIN_QUANTITY = 0.00001;
const MAX_QUANTITY = 1_000_000;
const MAX_PRICE = 1_000_000_000;
const MAX_NOTIONAL = 1_000_000_000;
const DUST_THRESHOLD = 0.00001;

function roundTo(value, decimals = DECIMALS) {
  if (!Number.isFinite(value)) return NaN;
  return Number(value.toFixed(decimals));
}

function decimalPlaces(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return Infinity;

  const text = String(value).toLowerCase();
  if (text.includes('e')) {
    const [mantissa, exponent] = text.split('e');
    const fractionDigits = (mantissa.split('.')[1] || '').length;
    return Math.max(0, fractionDigits - Number(exponent));
  }

  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - 1 - dot;
}

module.exports = {
  DECIMALS,
  MIN_QUANTITY,
  MAX_QUANTITY,
  MAX_PRICE,
  MAX_NOTIONAL,
  DUST_THRESHOLD,
  roundTo,
  decimalPlaces
};
