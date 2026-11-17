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

function timestampSeed(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return value === undefined || value === null ? '' : String(value);
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
    timestampSeed(record.timestamp)
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
    timestampSeed(record.timestamp)
  ]);
}

// Resolve the identity every consumer must use: the embedded _id when present,
// otherwise the deterministic generated id.
function resolveLegacyOrderId(userId, order) {
  if (order && order._id) return String(order._id);
  return String(legacyOrderId(userId, order));
}

function resolveLegacyTradeId(userId, trade) {
  if (trade && trade._id) return String(trade._id);
  return String(legacyTradeId(userId, trade));
}

module.exports = {
  deterministicId,
  legacyOrderId,
  legacyTradeId,
  resolveLegacyOrderId,
  resolveLegacyTradeId
};
