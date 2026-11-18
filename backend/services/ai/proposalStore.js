const crypto = require('crypto');

const DEFAULT_TTL_MS = 120000;
const PROPOSAL_ID_PATTERN = /^[a-f0-9]{48}$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Proposals intentionally live in process memory only. They are lost on restart
// and are not shared between instances; multi-instance scaling will require a
// shared store (for example Redis) with the same single-use semantics.
function createProposalStore({
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  generateId = () => crypto.randomBytes(24).toString('hex')
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError('Proposal TTL must be a positive number of milliseconds.');
  }
  if (typeof generateId !== 'function') {
    throw new TypeError('Proposal id generator must be a function.');
  }

  const proposals = new Map();

  function sweep() {
    const timestamp = now();
    for (const [id, record] of proposals) {
      if (record.expiresAt <= timestamp) proposals.delete(id);
    }
  }

  function create({ userId, intent, preview, quote = null } = {}) {
    if (!userId) throw new TypeError('A proposal requires an owning user.');
    if (!intent || !preview) throw new TypeError('A proposal requires an intent and preview.');

    sweep();
    const createdAt = now();
    const id = generateId();
    const record = {
      id,
      userId: String(userId),
      intent: clone(intent),
      preview: clone(preview),
      quote: quote ? clone(quote) : null,
      createdAt,
      expiresAt: createdAt + ttlMs,
      consumedAt: null,
      revokedAt: null
    };
    proposals.set(id, record);

    return {
      id: record.id,
      intent: clone(record.intent),
      preview: clone(record.preview),
      expiresAt: record.expiresAt
    };
  }

  // The check-and-consume below runs synchronously before any await, so two
  // concurrent requests cannot both claim the same proposal.
  function consume({ proposalId, userId } = {}) {
    if (typeof proposalId !== 'string' || !PROPOSAL_ID_PATTERN.test(proposalId)) {
      return { ok: false, code: 'INVALID_PROPOSAL' };
    }

    const record = proposals.get(proposalId);
    if (!record) return { ok: false, code: 'PROPOSAL_NOT_FOUND' };

    // Ownership failures intentionally look like an invalid proposal so the
    // endpoint does not reveal that another user's proposal exists.
    if (String(record.userId) !== String(userId)) {
      return { ok: false, code: 'INVALID_PROPOSAL' };
    }

    if (record.consumedAt !== null) return { ok: false, code: 'PROPOSAL_ALREADY_USED' };

    if (record.revokedAt !== null) return { ok: false, code: 'PROPOSAL_REVOKED' };

    if (now() >= record.expiresAt) {
      proposals.delete(proposalId);
      return { ok: false, code: 'PROPOSAL_EXPIRED' };
    }

    record.consumedAt = now();
    return {
      ok: true,
      proposal: {
        id: record.id,
        userId: record.userId,
        intent: clone(record.intent),
        preview: clone(record.preview),
        quote: record.quote ? clone(record.quote) : null,
        expiresAt: record.expiresAt
      }
    };
  }

  function size() {
    return proposals.size;
  }

  // Read-only lookup for execution-status consumers. It never consumes,
  // revokes or deletes anything, so it is safe to call while settling.
  function inspect({ proposalId, userId } = {}) {
    if (typeof proposalId !== 'string' || !PROPOSAL_ID_PATTERN.test(proposalId)) {
      return { ok: false, code: 'INVALID_PROPOSAL' };
    }

    const record = proposals.get(proposalId);
    if (!record) return { ok: false, code: 'PROPOSAL_NOT_FOUND' };

    if (String(record.userId) !== String(userId)) {
      return { ok: false, code: 'INVALID_PROPOSAL' };
    }

    const state = record.consumedAt !== null
      ? 'USED'
      : record.revokedAt !== null
        ? 'REVOKED'
        : now() >= record.expiresAt
          ? 'EXPIRED'
          : 'READY';

    return {
      ok: true,
      state,
      proposal: {
        id: record.id,
        expiresAt: record.expiresAt,
        consumedAt: record.consumedAt,
        revokedAt: record.revokedAt
      }
    };
  }

  // Server-side discard. Revocation is owner-only, idempotent, and never
  // executes or reserves anything.
  function revoke({ proposalId, userId } = {}) {
    if (typeof proposalId !== 'string' || !PROPOSAL_ID_PATTERN.test(proposalId)) {
      return { ok: false, code: 'INVALID_PROPOSAL' };
    }

    const record = proposals.get(proposalId);
    if (!record) return { ok: false, code: 'PROPOSAL_NOT_FOUND' };

    if (String(record.userId) !== String(userId)) {
      return { ok: false, code: 'INVALID_PROPOSAL' };
    }

    if (record.consumedAt !== null) return { ok: false, code: 'PROPOSAL_ALREADY_USED' };

    if (now() >= record.expiresAt) {
      proposals.delete(proposalId);
      return { ok: false, code: 'PROPOSAL_EXPIRED' };
    }

    const alreadyRevoked = record.revokedAt !== null;
    record.revokedAt = record.revokedAt || now();

    return {
      ok: true,
      alreadyRevoked,
      expiresAt: record.expiresAt
    };
  }

  return { create, consume, revoke, inspect, sweep, size, ttlMs };
}

module.exports = {
  DEFAULT_TTL_MS,
  PROPOSAL_ID_PATTERN,
  createProposalStore
};
