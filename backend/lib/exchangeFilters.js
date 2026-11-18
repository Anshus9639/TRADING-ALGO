const { roundTo } = require('./numbers');

// Alignment compares a ratio against its nearest integer, so the ratio must be
// small enough that double rounding cannot move it across a step boundary.
// Above this magnitude the comparison cannot be trusted, and unverifiable
// input is rejected rather than silently accepted as aligned.
const MAX_VERIFIABLE_RATIO = 1e15;

function positiveFilter(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function readRules(rules) {
  if (!rules || typeof rules !== 'object') return null;
  const market = {
    tickSize: positiveFilter(rules.tickSize),
    stepSize: positiveFilter(rules.stepSize),
    minQty: positiveFilter(rules.minQty),
    minNotional: positiveFilter(rules.minNotional)
  };
  return market.tickSize || market.stepSize || market.minQty || market.minNotional
    ? market
    : null;
}

// Exchange metadata is authoritative or absent, never partially trusted. A
// catalogue entry missing any of these filters cannot validate an order, so
// callers that have a catalogue must refuse new orders instead of falling back
// to the looser global limits.
function hasUsableMarketRules(rules) {
  if (!rules || typeof rules !== 'object') return false;
  return Boolean(
    positiveFilter(rules.tickSize)
    && positiveFilter(rules.stepSize)
    && positiveFilter(rules.minQty)
    && positiveFilter(rules.minNotional)
  );
}

// True when `value` is a whole multiple of `step` at storage precision.
function alignsToStep(value, step) {
  const normalizedStep = positiveFilter(step);
  if (!normalizedStep) return true;
  if (!Number.isFinite(value) || value <= 0) return false;

  const ratio = value / normalizedStep;
  if (!Number.isFinite(ratio)) return false;
  if (Math.abs(ratio) > MAX_VERIFIABLE_RATIO) return false;

  // Compare at eight decimals so binary drift in `ratio * step` does not make
  // an exact multiple look misaligned.
  return roundTo(Math.round(ratio) * normalizedStep) === roundTo(value);
}

// Floor a server-derived quantity onto the market step grid. Never rounds up,
// so a spend-derived size cannot exceed the amount the user asked for.
function floorToStep(value, step) {
  const normalizedStep = positiveFilter(step);
  if (!Number.isFinite(value) || value <= 0 || !normalizedStep) return value;

  const rounded = roundTo(value);
  if (alignsToStep(rounded, normalizedStep)) return rounded;

  const steps = Math.floor(rounded / normalizedStep);
  return roundTo(steps * normalizedStep);
}

// Market filters published by the exchange. They are enforced at order
// creation so a stored order is one the real market would accept; they never
// silently rewrite an explicit user quantity or price.
//
// `enforceTick` is false for MARKET orders: their settlement price is the
// market's observation, not a user-specified price, so only the lot rules and
// the resulting minimum value apply.
function checkMarketRules({ quantity, price = null, rules, enforceTick = true } = {}) {
  const market = readRules(rules);
  if (!market) return { ok: true };

  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { ok: false, error: 'Quantity must be a positive number.' };
  }
  if (market.stepSize && !alignsToStep(quantity, market.stepSize)) {
    return { ok: false, error: `Quantity must be a multiple of ${market.stepSize}.` };
  }
  if (market.minQty && quantity < market.minQty) {
    return { ok: false, error: `Quantity is below the market minimum of ${market.minQty}.` };
  }

  if (price === null) return { ok: true };

  if (!Number.isFinite(price) || price <= 0) {
    return { ok: false, error: 'Price must be a positive number.' };
  }
  if (enforceTick && market.tickSize && !alignsToStep(price, market.tickSize)) {
    return { ok: false, error: `Price must be a multiple of ${market.tickSize}.` };
  }
  if (market.minNotional && roundTo(quantity * price) < market.minNotional) {
    return {
      ok: false,
      error: `Order value is below the market minimum of ${market.minNotional} USDT.`
    };
  }

  return { ok: true };
}

module.exports = {
  alignsToStep,
  floorToStep,
  hasUsableMarketRules,
  checkMarketRules
};
