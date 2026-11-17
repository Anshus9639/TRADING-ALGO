import { buildAuthHeaders } from './apiConfig.mjs';

export const PROPOSAL_STATUS = Object.freeze({
  READY: 'ready',
  EXECUTED: 'executed',
  EXPIRED: 'expired',
  PRICE_CHANGED: 'priceChanged',
  ERROR: 'error'
});

export function createProposalState(payload, now = Date.now()) {
  if (!payload || typeof payload.proposalId !== 'string' || payload.proposalId === '') {
    throw new Error('Invalid proposal payload.');
  }
  const expiresAt = Date.parse(payload.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error('Invalid proposal expiry.');

  return {
    proposalId: payload.proposalId,
    intent: payload.intent || null,
    preview: payload.preview || null,
    expiresAt,
    receivedAt: now,
    status: PROPOSAL_STATUS.READY,
    error: null
  };
}

export function isExpired(state, now = Date.now()) {
  return Boolean(state) && now >= state.expiresAt;
}

export function canConfirm(state, now = Date.now()) {
  return Boolean(state)
    && state.status === PROPOSAL_STATUS.READY
    && !isExpired(state, now);
}

// An unconfirmed execution keeps its proposal id. Reconciliation re-sends that
// id even after the local expiry time, because the backend checks for a prior
// execution result before it consumes or rejects the proposal.
export function canReconcile(state) {
  return Boolean(state)
    && state.status === PROPOSAL_STATUS.READY
    && state.uncertain === true;
}

// A new command must not replace a proposal whose execution outcome is unknown.
export function blocksNewCommand(state) {
  return Boolean(state && state.uncertain === true);
}

export function formatRemaining(state, now = Date.now()) {
  if (!state || !Number.isFinite(state.expiresAt)) return '0s';
  const totalSeconds = Math.max(0, Math.ceil((state.expiresAt - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0
    ? `${minutes}m ${String(seconds).padStart(2, '0')}s`
    : `${seconds}s`;
}

// Parsing only asks the backend for a proposal; it never sends a trade.
export async function requestProposal({ http, prompt, token, now = Date.now() }) {
  const response = await http.post('/api/copilot/parse', { prompt }, buildAuthHeaders(token));
  return createProposalState(response.data, now);
}

const NON_FATAL_REVOKE_CODES = new Set([
  'PROPOSAL_ALREADY_USED',
  'PROPOSAL_EXPIRED',
  'PROPOSAL_REVOKED',
  'PROPOSAL_NOT_FOUND',
  'INVALID_PROPOSAL'
]);

// Discarding revokes the server-side proposal so it can never be executed.
// It never submits a trade. Revocation failures caused by an already used,
// expired, or revoked proposal are safe to treat as discarded locally.
export async function discardProposal({ http, state, token }) {
  if (!state || typeof state.proposalId !== 'string' || state.proposalId === '') {
    return { ok: true, state: null };
  }

  try {
    await http.post(
      `/api/copilot/proposals/${encodeURIComponent(state.proposalId)}/revoke`,
      {},
      buildAuthHeaders(token)
    );
    return { ok: true, state: null };
  } catch (error) {
    const code = error?.response?.data?.code;
    if (NON_FATAL_REVOKE_CODES.has(code)) {
      return { ok: true, state: null };
    }
    return {
      ok: false,
      reason: code || 'REVOKE_FAILED',
      state: {
        ...state,
        error: error?.response?.data?.message || error?.message || 'Could not discard proposal.'
      }
    };
  }
}

export function createConfirmLock() {
  return { active: false };
}

// A response-less failure, a timeout, or a 5xx means the server may have
// executed the proposal even though the client never saw the result. Those
// outcomes must keep the proposal and its id so a retry replays the same
// idempotent execution instead of creating a different one.
export function isUncertainFailure(error) {
  if (error?.definite) return false;
  if (!error?.response) return true;
  const status = error.response.status;
  return status >= 500 || status === 408;
}

export async function confirmProposal({
  http,
  state,
  token,
  now = Date.now(),
  lock = null,
  allowExpiredReconcile = false
}) {
  if (!state) return { ok: false, reason: 'NO_PROPOSAL', state };
  if (lock && lock.active) return { ok: false, reason: 'BUSY', state };
  if (state.status !== PROPOSAL_STATUS.READY) return { ok: false, reason: 'BUSY', state };
  const reconcileExpired = allowExpiredReconcile === true && state.uncertain === true;
  if (isExpired(state, now) && !reconcileExpired) {
    return {
      ok: false,
      reason: 'EXPIRED',
      definitive: true,
      state: { ...state, status: PROPOSAL_STATUS.EXPIRED, error: 'Proposal expired.' }
    };
  }

  if (lock) lock.active = true;

  try {
    // Only the server-side proposal id is sent. Intent, side, symbol, price and
    // quantity are deliberately omitted so they cannot be tampered with.
    const response = await http.post(
      '/api/copilot/execute',
      { proposalId: state.proposalId },
      buildAuthHeaders(token)
    );
    const data = response.data || {};
    if (!data.success) {
      const error = new Error(data.message || 'Execution failed.');
      error.code = data.code;
      // The server answered, so this is a definitive rejection.
      error.definite = true;
      throw error;
    }

    return {
      ok: true,
      state: { ...state, status: PROPOSAL_STATUS.EXECUTED, uncertain: false, error: null },
      result: data
    };
  } catch (error) {
    const data = error?.response?.data || {};
    const code = data.code || error?.code || 'TRADE_FAILED';
    const message = data.message || error?.message || 'Execution failed.';

    if (isUncertainFailure(error)) {
      return {
        ok: false,
        uncertain: true,
        definitive: false,
        reason: 'EXECUTION_UNCONFIRMED',
        // Status stays READY so Confirm remains available and retries reuse
        // the same proposal id, which the backend treats as idempotent.
        state: {
          ...state,
          status: PROPOSAL_STATUS.READY,
          uncertain: true,
          error: 'Execution could not be confirmed. Retry with the same proposal.'
        }
      };
    }

    const status = code === 'PRICE_CHANGED'
      ? PROPOSAL_STATUS.PRICE_CHANGED
      : code === 'PROPOSAL_EXPIRED'
        ? PROPOSAL_STATUS.EXPIRED
        : PROPOSAL_STATUS.ERROR;

    return {
      ok: false,
      reason: code,
      definitive: true,
      state: { ...state, status, uncertain: false, error: message }
    };
  } finally {
    if (lock) lock.active = false;
  }
}

// Resolve an unconfirmed execution using the original proposal id, even after
// the local expiry time. If the order already committed, the backend returns
// the stored result; if nothing committed, the server's definitive rejection
// (for example PROPOSAL_EXPIRED) is reported instead of creating a new trade.
export async function reconcileProposal({ state, ...options }) {
  if (!canReconcile(state)) {
    return { ok: false, reason: 'NO_UNCERTAIN_EXECUTION', definitive: false, state };
  }
  return confirmProposal({ ...options, state, allowExpiredReconcile: true });
}
