import { isClientOrderId } from './orderId.mjs';

const STORAGE_PREFIX = 'nexustrade:pending-orders:';
// Each pending submission is its own storage key. A whole-map snapshot would
// let a second tab overwrite entries it never saw and let a stale instance
// write a deleted entry back, so updates are per key and deletes leave a
// tombstone that suppresses old-format snapshots.
const STORAGE_VERSION = 2;
const LEGACY_STORAGE_VERSION = 1;
const ENTRY_MARKER = ':entry:';
const TOMBSTONE_MARKER = ':deleted:';
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

// A key may only be retired by an answer the server produces after it looked
// the key up. Rate limiting, auth middleware and request validation all reply
// before that lookup, so a 401 or other early 4xx says nothing about an
// earlier attempt whose response was lost: the key must survive so the retry
// replays the original request instead of creating a duplicate.
const DEFINITIVE_RETIRE_CODES = new Set(['IDEMPOTENCY_CONFLICT']);

export function shouldRetirePendingKey(status, code) {
  return status === 409
    && typeof code === 'string'
    && DEFINITIVE_RETIRE_CODES.has(code);
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

function isAcceptableRequestKey(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_REQUEST_KEY_LENGTH;
}

function isFresh(savedAt, timestamp, maxAgeMs) {
  return savedAt <= timestamp + CLOCK_SKEW_MS && timestamp - savedAt <= maxAgeMs;
}

function readStoredRecord(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) return null;
    if (!isClientOrderId(parsed.clientOrderId)) return null;
    const savedAt = Number(parsed.savedAt);
    if (!Number.isFinite(savedAt)) return null;
    return { clientOrderId: parsed.clientOrderId, savedAt };
  } catch {
    return null;
  }
}

function readStoredTombstone(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) return null;
    const deletedAt = Number(parsed.deletedAt);
    return Number.isFinite(deletedAt) ? deletedAt : null;
  } catch {
    return null;
  }
}

// Full-map snapshots are only read for compatibility with entries written by
// older frontend bundles; this module never writes one again.
function readLegacyEntries(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== LEGACY_STORAGE_VERSION) return null;
    if (!parsed.entries || typeof parsed.entries !== 'object') return null;
    return parsed.entries;
  } catch {
    return null;
  }
}

function listStorageKeys(storage, base) {
  if (!storage || typeof storage.length !== 'number' || typeof storage.key !== 'function') {
    return null;
  }
  const keys = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (typeof key === 'string' && key.startsWith(base)) keys.push(key);
  }
  return keys;
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
  const entryPrefix = storageKey ? `${storageKey}${ENTRY_MARKER}` : null;
  const tombstonePrefix = storageKey ? `${storageKey}${TOMBSTONE_MARKER}` : null;
  const entries = new Map();
  const tombstones = new Map();

  function entryKey(requestKey) {
    return `${entryPrefix}${requestKey}`;
  }

  function tombstoneKey(requestKey) {
    return `${tombstonePrefix}${requestKey}`;
  }

  function persistEntry(requestKey, record) {
    if (!storageKey || !storage) return;
    try {
      storage.setItem(entryKey(requestKey), JSON.stringify({
        version: STORAGE_VERSION,
        clientOrderId: record.clientOrderId,
        savedAt: record.savedAt
      }));
    } catch {
      // Quota or privacy-mode failures leave the in-memory map authoritative.
    }
  }

  // Reconciles the in-memory view with storage. It only adds or updates keys
  // from persisted records and only removes keys that carry a tombstone, so a
  // record that failed to persist (quota, private mode) is never dropped from
  // memory and accidentally replaced by a fresh id.
  function loadFromStorage() {
    if (!storageKey || !storage) return;
    try {
      const timestamp = now();
      const keys = listStorageKeys(storage, storageKey);

      if (keys) {
        for (const key of keys) {
          if (!key.startsWith(tombstonePrefix)) continue;
          const requestKey = key.slice(tombstonePrefix.length);
          if (!isAcceptableRequestKey(requestKey)) continue;
          const deletedAt = readStoredTombstone(storage.getItem(key));
          if (deletedAt === null || deletedAt > timestamp + CLOCK_SKEW_MS) continue;
          tombstones.set(requestKey, deletedAt);
        }

        for (const key of keys) {
          if (!key.startsWith(entryPrefix)) continue;
          const requestKey = key.slice(entryPrefix.length);
          if (!isAcceptableRequestKey(requestKey)) continue;
          const record = readStoredRecord(storage.getItem(key));
          // Future timestamps beyond normal clock skew and stale entries are
          // discarded rather than trusted indefinitely.
          if (!record || !isFresh(record.savedAt, timestamp, maxAgeMs)) {
            entries.delete(requestKey);
            try { storage.removeItem(key); } catch { /* ignore */ }
            continue;
          }
          entries.set(requestKey, record);
        }
      }

      const legacy = readLegacyEntries(storage.getItem(storageKey));
      if (legacy) {
        for (const [requestKey, record] of Object.entries(legacy)) {
          if (!isAcceptableRequestKey(requestKey) || !record) continue;
          if (!isClientOrderId(record.clientOrderId)) continue;
          const savedAt = Number(record.savedAt);
          if (!Number.isFinite(savedAt) || !isFresh(savedAt, timestamp, maxAgeMs)) continue;
          if (entries.has(requestKey)) continue;
          const imported = { clientOrderId: record.clientOrderId, savedAt };
          entries.set(requestKey, imported);
          persistEntry(requestKey, imported);
        }
      }

      for (const [requestKey, record] of entries) {
        const deletedAt = tombstones.get(requestKey);
        if (deletedAt !== undefined && deletedAt >= record.savedAt) {
          entries.delete(requestKey);
          try { storage.removeItem(entryKey(requestKey)); } catch { /* ignore */ }
        }
      }

      for (const [requestKey, deletedAt] of tombstones) {
        if (timestamp - deletedAt > maxAgeMs) {
          tombstones.delete(requestKey);
          try { storage.removeItem(tombstoneKey(requestKey)); } catch { /* ignore */ }
        }
      }
    } catch {
      // Corrupt or unavailable storage must not block trading.
    }
  }

  loadFromStorage();

  function deleteEntry(requestKey) {
    const removed = entries.delete(requestKey);
    if (!storageKey || !storage) return removed;
    try { storage.removeItem(entryKey(requestKey)); } catch { /* ignore */ }
    try {
      storage.setItem(tombstoneKey(requestKey), JSON.stringify({
        version: STORAGE_VERSION,
        deletedAt: now()
      }));
    } catch {
      // Without a tombstone the entry key removal still prevents reuse.
    }
    return removed;
  }

  return {
    storageKey,
    size() {
      return entries.size;
    },
    // Re-reads storage so a remounted instance sees keys retired (or created)
    // by an earlier instance before it decides whether to reuse an id.
    refresh() {
      loadFromStorage();
      return this;
    },
    get(requestKey) {
      return entries.get(requestKey)?.clientOrderId;
    },
    set(requestKey, clientOrderId) {
      if (!isAcceptableRequestKey(requestKey)) {
        throw new Error('Invalid pending submission key.');
      }
      if (!isClientOrderId(clientOrderId)) {
        throw new Error('Invalid client order id.');
      }
      const existing = entries.get(requestKey);
      const record = {
        clientOrderId,
        savedAt: existing && existing.clientOrderId === clientOrderId ? existing.savedAt : now()
      };
      entries.set(requestKey, record);
      persistEntry(requestKey, record);

      // A new submission supersedes an earlier deletion of the same request.
      // The tombstone is cleared even when this instance never loaded it and
      // even when both timestamps fall in the same millisecond.
      tombstones.delete(requestKey);
      if (storageKey && storage) {
        try { storage.removeItem(tombstoneKey(requestKey)); } catch { /* ignore */ }
      }
    },
    // Retires a key only when the stored record still belongs to the request
    // that completed. A remount or another tab may already hold a newer,
    // genuinely unresolved submission under the same request key.
    deleteIf(requestKey, clientOrderId) {
      if (storageKey && storage) {
        try {
          const stored = readStoredRecord(storage.getItem(entryKey(requestKey)));
          if (stored) {
            return stored.clientOrderId === clientOrderId && deleteEntry(requestKey);
          }
          // Nothing persisted: the key was already retired, unless this
          // instance is holding an entry that failed to persist.
          const buffered = entries.get(requestKey);
          return Boolean(buffered)
            && buffered.clientOrderId === clientOrderId
            && deleteEntry(requestKey);
        } catch {
          // Fall through to the in-memory record when storage is unreadable.
        }
      }
      const record = entries.get(requestKey);
      return Boolean(record) && record.clientOrderId === clientOrderId && deleteEntry(requestKey);
    },
    delete(requestKey) {
      return deleteEntry(requestKey);
    }
  };
}
