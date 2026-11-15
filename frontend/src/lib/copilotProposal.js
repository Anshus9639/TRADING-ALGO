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

export async function confirmProposal({
  http,
  state,
  token,
  now = Date.now(),
  lock = null
}) {
  if (!state) return { ok: false, reason: 'NO_PROPOSAL', state };
  if (lock && lock.active) return { ok: false, reason: 'BUSY', state };
  if (state.status !== PROPOSAL_STATUS.READY) return { ok: false, reason: 'BUSY', state };
  if (isExpired(state, now)) {
    return {
      ok: false,
      reason: 'EXPIRED',
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
      throw error;
    }

    return {
      ok: true,
      state: { ...state, status: PROPOSAL_STATUS.EXECUTED, error: null },
      result: data
    };
  } catch (error) {
    const data = error?.response?.data || {};
    const code = data.code || error?.code || 'TRADE_FAILED';
    const message = data.message || error?.message || 'Execution failed.';
    const status = code === 'PRICE_CHANGED'
      ? PROPOSAL_STATUS.PRICE_CHANGED
      : code === 'PROPOSAL_EXPIRED'
        ? PROPOSAL_STATUS.EXPIRED
        : PROPOSAL_STATUS.ERROR;

    return {
      ok: false,
      reason: code,
      state: { ...state, status, error: message }
    };
  } finally {
    if (lock) lock.active = false;
  }
}
