const ORDER_STATUSES = Object.freeze([
  'OPEN',
  'FILLING',
  'FILLED',
  'CANCELLED',
  'EXPIRED',
  'REJECTED',
  'FAILED'
]);

// Allowed transitions. Terminal states have no outgoing edges.
const TRANSITIONS = Object.freeze({
  OPEN: Object.freeze(['FILLING', 'CANCELLED', 'EXPIRED', 'REJECTED', 'FAILED']),
  FILLING: Object.freeze(['FILLED', 'OPEN', 'FAILED']),
  FILLED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  REJECTED: Object.freeze([]),
  FAILED: Object.freeze([])
});

const RETRYABLE_FAILURES = Object.freeze(['CLAIM_EXPIRED', 'QUOTE_UNAVAILABLE', 'TRANSIENT']);

function isTerminal(status) {
  return TRANSITIONS[status] !== undefined && TRANSITIONS[status].length === 0;
}

function canTransition(from, to) {
  const allowed = TRANSITIONS[from];
  return Array.isArray(allowed) && allowed.includes(to);
}

function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid order state transition: ${from} -> ${to}`);
  }
  return to;
}

module.exports = {
  ORDER_STATUSES,
  TRANSITIONS,
  RETRYABLE_FAILURES,
  isTerminal,
  canTransition,
  assertTransition
};
