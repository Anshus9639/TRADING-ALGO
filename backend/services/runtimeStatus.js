// Single source of truth for whether the matching engine may accept new LIMIT
// orders and whether the process is ready to receive traffic. Every flag is
// updated by the startup sequence or by live component events; nothing in the
// readiness path creates indexes or mutates data.
const MATCHER_STATES = Object.freeze({
  STARTING: 'STARTING',
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
  FAILED: 'FAILED'
});

function createRuntimeStatus({ now = Date.now } = {}) {
  const state = {
    startedAt: new Date(now()).toISOString(),
    startupComplete: false,
    mongoConnected: false,
    transactionsVerified: false,
    indexesVerified: false,
    legacyGateClear: false,
    matcher: MATCHER_STATES.STARTING,
    matcherCode: null,
    matcherDetail: null,
    matcherCycles: 0,
    lastMatcherError: null
  };

  function blockActiveMatcher(code, detail) {
    if (state.matcher === MATCHER_STATES.ACTIVE) {
      state.matcher = MATCHER_STATES.BLOCKED;
      state.matcherCode = code;
      state.matcherDetail = detail || null;
    }
  }

  function snapshot() {
    return { ...state };
  }

  return {
    setStartupComplete(value = true) {
      state.startupComplete = Boolean(value);
    },

    setMongoConnected(value) {
      state.mongoConnected = Boolean(value);
      if (!value) {
        state.matcher = MATCHER_STATES.FAILED;
        state.matcherCode = 'MONGO_DISCONNECTED';
        state.matcherDetail = null;
      }
    },

    setTransactionsVerified(value) {
      state.transactionsVerified = Boolean(value);
      if (!value) blockActiveMatcher('TRANSACTIONS_UNAVAILABLE');
    },

    setIndexesVerified(value) {
      state.indexesVerified = Boolean(value);
      if (!value) blockActiveMatcher('INDEXES_UNVERIFIED');
    },

    setLegacyGateClear(value) {
      state.legacyGateClear = Boolean(value);
      if (!value) blockActiveMatcher('LEGACY_GATE_BLOCKED');
    },

    markMatcherActive() {
      state.matcher = MATCHER_STATES.ACTIVE;
      state.matcherCode = null;
      state.matcherDetail = null;
      state.lastMatcherError = null;
      state.matcherCycles += 1;
    },

    markMatcherBlocked(code, detail = null) {
      state.matcher = MATCHER_STATES.BLOCKED;
      state.matcherCode = code;
      state.matcherDetail = detail;
    },

    markMatcherFailed(code, detail = null) {
      state.matcher = MATCHER_STATES.FAILED;
      state.matcherCode = code;
      state.matcherDetail = detail;
      state.lastMatcherError = detail;
    },

    isMatcherOperational() {
      return state.matcher === MATCHER_STATES.ACTIVE
        && state.startupComplete
        && state.mongoConnected
        && state.transactionsVerified
        && state.indexesVerified
        && state.legacyGateClear;
    },

    readiness() {
      const checks = {
        startup: { ok: state.startupComplete, code: 'STARTUP_INCOMPLETE' },
        mongo: { ok: state.mongoConnected, code: 'MONGO_DISCONNECTED' },
        transactions: { ok: state.transactionsVerified, code: 'TRANSACTIONS_UNAVAILABLE' },
        indexes: { ok: state.indexesVerified, code: 'INDEXES_UNVERIFIED' },
        legacyGate: { ok: state.legacyGateClear, code: 'LEGACY_GATE_BLOCKED' },
        matcher: {
          ok: state.matcher === MATCHER_STATES.ACTIVE,
          code: state.matcher === MATCHER_STATES.FAILED ? 'MATCHER_FAILED' : 'MATCHER_BLOCKED'
        }
      };

      const codes = Object.values(checks)
        .filter(check => !check.ok)
        .map(check => check.code);

      return {
        ok: codes.length === 0,
        status: codes.length === 0 ? 'ready' : 'not_ready',
        codes,
        components: Object.fromEntries(
          Object.entries(checks).map(([name, check]) => [name, check.ok])
        ),
        matcher: state.matcher,
        matcherCode: state.matcherCode,
        checkedAt: new Date(now()).toISOString()
      };
    },

    snapshot
  };
}

module.exports = {
  MATCHER_STATES,
  createRuntimeStatus
};
