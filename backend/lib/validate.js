const {
  DECIMALS,
  MIN_QUANTITY,
  MAX_QUANTITY,
  MAX_PRICE,
  MAX_NOTIONAL,
  roundTo,
  decimalPlaces
} = require('./numbers');
const { PINNED_SYMBOLS, normalizeSymbol } = require('./symbols');
const { symbolUniverse } = require('../services/symbolUniverse');

// Retained for compatibility with older imports. Trading validity is decided
// by the catalogue-backed universe, not by this pinned display list.
const SUPPORTED_SYMBOLS = PINNED_SYMBOLS;
const SUPPORTED_SIDES = Object.freeze(['BUY', 'SELL']);
// Manual orders must carry a client-generated UUID. AI execution uses the
// server-issued proposal id as its key, so this check is applied at the HTTP
// boundary rather than inside the shared trade service.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(error) {
  return { ok: false, error };
}

function valid(value) {
  return { ok: true, value };
}

// Format-only normalization for paths that must replay an existing order
// before deciding whether the pair is currently tradeable.
function validateSymbolFormat(input) {
  if (typeof input !== 'string') return invalid('Symbol must be a string.');
  const symbol = normalizeSymbol(input);
  if (!symbol) return invalid('Symbol must be an uppercase alphanumeric pair.');
  return valid(symbol);
}

function validateSymbol(input) {
  const formatCheck = validateSymbolFormat(input);
  if (!formatCheck.ok) return formatCheck;
  const symbol = formatCheck.value;
  if (!symbolUniverse.isActive(symbol)) {
    return invalid(`Unsupported symbol. Allowed: ${symbolUniverse.listActive().join(', ')}.`);
  }
  return valid(symbol);
}

function validateSide(input) {
  if (!SUPPORTED_SIDES.includes(input)) return invalid('Side must be BUY or SELL.');
  return valid(input);
}

function validateQuantity(input) {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    return invalid('Quantity must be a positive JSON number.');
  }
  if (input < MIN_QUANTITY) {
    return invalid(`Quantity must be at least ${MIN_QUANTITY}.`);
  }
  if (input > MAX_QUANTITY) {
    return invalid(`Quantity exceeds the maximum of ${MAX_QUANTITY}.`);
  }
  if (decimalPlaces(input) > DECIMALS) {
    return invalid(`Quantity supports at most ${DECIMALS} decimal places.`);
  }
  return valid(input);
}

function validateLimitPrice(input) {
  if (typeof input !== 'number' || !Number.isFinite(input) || input <= 0) {
    return invalid('Limit price must be a positive JSON number.');
  }
  if (input > MAX_PRICE) {
    return invalid(`Limit price exceeds the maximum of ${MAX_PRICE}.`);
  }
  if (decimalPlaces(input) > DECIMALS) {
    return invalid(`Limit price supports at most ${DECIMALS} decimal places.`);
  }
  return valid(input);
}

function validateClientOrderId(input) {
  if (typeof input !== 'string') {
    return invalid('clientOrderId is required and must be a UUID string.');
  }
  const trimmed = input.trim();
  if (!UUID_PATTERN.test(trimmed)) {
    return invalid('clientOrderId must be a valid UUID.');
  }
  return valid(trimmed);
}

function validateNotional(quantity, price) {
  const notional = roundTo(quantity * price);
  if (!Number.isFinite(notional) || notional <= 0) {
    return invalid('Order value must be a positive amount.');
  }
  if (notional > MAX_NOTIONAL) {
    return invalid(`Order value exceeds the maximum of ${MAX_NOTIONAL} USDT.`);
  }
  return valid(notional);
}

module.exports = {
  SUPPORTED_SYMBOLS,
  SUPPORTED_SIDES,
  validateSymbol,
  validateSymbolFormat,
  validateSide,
  validateQuantity,
  validateLimitPrice,
  validateClientOrderId,
  validateNotional
};
