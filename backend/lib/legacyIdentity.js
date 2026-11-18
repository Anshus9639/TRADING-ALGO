const crypto = require('crypto');
const mongoose = require('mongoose');

// Embedded legacy records created before Batch D may have no _id. Their
// identity must be reproducible in the migration, in the account readers and in
// the migration gate, otherwise a migrated record looks unmigrated and is shown
// twice. The seed contains only values already stored in the record, so no
// financial data is invented and no mapping needs to be persisted.
function deterministicId(parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return new mongoose.Types.ObjectId(digest.slice(0, 24));
}

// Mongoose applies schema defaults to embedded subdocuments while hydrating a
// user document. A default that was never persisted is not part of the stored
// record, so it must not affect the derived identity; otherwise the same
// record hashes differently raw (migration) and hydrated (account readers).
function usesDefault(record, path) {
  return Boolean(
    record
    && typeof record.$isDefault === 'function'
    && record.$isDefault(path)
  );
}

// Raw reads hand back Date objects while JSON backups can hold ISO strings
// with or without milliseconds. Every parsable representation is canonicalized
// so the same stored moment always seeds the same hash. Unparsable values are
// kept verbatim so malformed data stays stable.
function timestampSeed(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return '';
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
  }
  return value === undefined || value === null ? '' : String(value);
}

function storedTimestamp(record) {
  if (!record || usesDefault(record, 'timestamp')) return undefined;
  return record.timestamp;
}

// Mirrors the migration's ObjectId handling: a value only counts as an
// explicit identity when Mongoose can convert it. The result is the canonical
// lowercase hex form, so ids that differ only in hex case resolve identically.
function canonicalObjectId(value) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof mongoose.Types.ObjectId) return value.toHexString();
  const text = String(value);
  if (!mongoose.Types.ObjectId.isValid(text)) return null;
  try {
    return new mongoose.Types.ObjectId(text).toHexString();
  } catch (err) {
    return null;
  }
}

function explicitRecordId(record) {
  if (!record || usesDefault(record, '_id')) return null;
  return canonicalObjectId(record._id);
}

function legacyOrderId(userId, order) {
  const record = order || {};
  return deterministicId([
    'order',
    String(userId),
    record.symbol,
    record.type,
    record.quantity,
    record.limitPrice,
    timestampSeed(storedTimestamp(record))
  ]);
}

function legacyTradeId(userId, trade) {
  const record = trade || {};
  return deterministicId([
    'trade',
    String(userId),
    record.symbol,
    record.type,
    record.quantity,
    record.price,
    timestampSeed(storedTimestamp(record))
  ]);
}

// Resolve the identity every consumer must use: the embedded _id when it was
// actually persisted, otherwise the deterministic generated id.
function resolveLegacyOrderId(userId, order) {
  return explicitRecordId(order) || String(legacyOrderId(userId, order));
}

function resolveLegacyTradeId(userId, trade) {
  return explicitRecordId(trade) || String(legacyTradeId(userId, trade));
}

module.exports = {
  deterministicId,
  legacyOrderId,
  legacyTradeId,
  resolveLegacyOrderId,
  resolveLegacyTradeId
};
