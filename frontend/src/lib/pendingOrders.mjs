import { isClientOrderId } from './orderId.mjs';

const STORAGE_PREFIX = 'nexustrade:pending-orders:';
const STORAGE_VERSION = 1;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_REQUEST_KEY_LENGTH = 500;
const CLOCK_SKEW_MS = 60 * 1000;

function defaultStorage() {
  try {
    return typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function decodeBase64Url(segment) {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  if (typeof atob === 'function') {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(padded, 'base64').toString('utf8');
}

// The storage scope is derived from the token's subject claim only. The token
// itself is never stored, so the persisted map cannot leak credentials.
export function readTokenScope(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;

  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const subject = typeof payload?.user?.id === 'string'
      ? payload.user.id
      : typeof payload?.sub === 'string'
        ? payload.sub
        : null;
    if (!subject || subject.length > 128) return null;
    return subject;
  } catch {
    return null;
  }
}

// Unresolved idempotency keys survive a page refresh. Entries are scoped to the
// authenticated user, expire after a day, and hold only the request key and the
// generated client order id - never a token or account credential.
export function createPendingSubmissionMap({
  token,
  storage = defaultStorage(),
  now = () => Date.now(),
  maxAgeMs = MAX_AGE_MS
} = {}) {
  const scope = readTokenScope(token);
  const storageKey = scope ? `${STORAGE_PREFIX}${scope}` : null;
  const entries = new Map();

  if (storageKey && storage) {
    try {
      const raw = storage.getItem(storageKey);
      const parsed = raw ? JSON.parse(raw) : null;
      const records = parsed
        && parsed.version === STORAGE_VERSION
        && parsed.entries
        && typeof parsed.entries === 'object'
        ? parsed.entries
        : {};
      const timestamp = now();

      for (const [requestKey, record] of Object.entries(records)) {
        if (typeof requestKey !== 'string'
          || requestKey.length === 0
          || requestKey.length > MAX_REQUEST_KEY_LENGTH) continue;
        if (!record || !isClientOrderId(record.clientOrderId)) continue;
        const savedAt = Number(record.savedAt);
        if (!Number.isFinite(savedAt)) continue;
        // Future timestamps beyond normal clock skew and stale entries are
        // discarded rather than trusted indefinitely.
        if (savedAt > timestamp + CLOCK_SKEW_MS || timestamp - savedAt > maxAgeMs) continue;
        entries.set(requestKey, { clientOrderId: record.clientOrderId, savedAt });
      }
    } catch {
      // Corrupt or unavailable storage must not block trading.
    }
  }

  function flush() {
    if (!storageKey || !storage) return;
    const records = {};
    for (const [requestKey, record] of entries) {
      records[requestKey] = {
        clientOrderId: record.clientOrderId,
        savedAt: record.savedAt
      };
    }
    try {
      storage.setItem(storageKey, JSON.stringify({ version: STORAGE_VERSION, entries: records }));
    } catch {
      // Quota or privacy-mode failures leave the in-memory map authoritative.
    }
  }

  return {
    storageKey,
    size() {
      return entries.size;
    },
    get(requestKey) {
      return entries.get(requestKey)?.clientOrderId;
    },
    set(requestKey, clientOrderId) {
      if (typeof requestKey !== 'string' || requestKey.length === 0 || requestKey.length > MAX_REQUEST_KEY_LENGTH) {
        throw new Error('Invalid pending submission key.');
      }
      if (!isClientOrderId(clientOrderId)) {
        throw new Error('Invalid client order id.');
      }
      const existing = entries.get(requestKey);
      entries.set(requestKey, {
        clientOrderId,
        savedAt: existing && existing.clientOrderId === clientOrderId ? existing.savedAt : now()
      });
      flush();
    },
    delete(requestKey) {
      const removed = entries.delete(requestKey);
      if (removed) flush();
      return removed;
    }
  };
}
