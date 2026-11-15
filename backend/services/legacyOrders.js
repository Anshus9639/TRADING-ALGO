// Embedded legacy pending orders are invisible to the canonical matcher. The
// gated migration imports each embedded order into the Order collection while
// preserving its _id; embedded copies are then retained (and deduped on read)
// until the separate prune stage.
//
// An embedded order without a canonical twin is unmigrated: it can still be
// cancelled with its original refund semantics, but it can never fill. The
// deployment policy is therefore to keep the matcher disabled while any
// unmigrated, malformed, or ambiguous embedded order exists, so no account is
// left holding an order that looks open but is silently ineligible.
const {
  validateSymbol,
  validateSide,
  validateQuantity,
  validateLimitPrice,
  validateNotional
} = require('../lib/validate');

function orderValidationError(raw) {
  const symbol = validateSymbol(raw.symbol);
  if (!symbol.ok) return symbol.error;
  const side = validateSide(raw.type);
  if (!side.ok) return side.error;
  const quantity = validateQuantity(raw.quantity);
  if (!quantity.ok) return quantity.error;
  const limitPrice = validateLimitPrice(raw.limitPrice);
  if (!limitPrice.ok) return limitPrice.error;
  const notional = validateNotional(quantity.value, limitPrice.value);
  if (!notional.ok) return notional.error;
  return null;
}

function duplicateIdGroups(records) {
  const counts = new Map();
  for (const record of records) {
    if (!record || !record._id) continue;
    const id = String(record._id);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({ legacyOrderId: id, count }));
}

async function findLegacyOrderBlockers({ User, Order, limit = 100 } = {}) {
  if (!User || !Order) {
    throw new TypeError('findLegacyOrderBlockers requires User and Order models.');
  }

  const users = await User.find({ 'pendingOrders.0': { $exists: true } })
    .select('_id pendingOrders')
    .lean();

  const results = [];
  for (const user of users) {
    const pending = user.pendingOrders || [];
    if (pending.length === 0) continue;

    const ids = pending.map(order => order._id).filter(Boolean);
    const canonicalIds = new Set();
    if (ids.length > 0) {
      const canonical = await Order.find({ _id: { $in: ids } }).select('_id').lean();
      for (const order of canonical) canonicalIds.add(String(order._id));
    }

    const duplicateGroups = duplicateIdGroups(pending);
    const duplicateIds = new Set(duplicateGroups.map(group => group.legacyOrderId));
    const reasons = new Set();
    let count = 0;
    let missingOrderIds = 0;
    let invalidOrders = 0;
    let unmigratedOrders = 0;

    for (const order of pending) {
      if (!order || !order._id) {
        missingOrderIds += 1;
        reasons.add('MISSING_ORDER_ID');
        count += 1;
        continue;
      }

      const id = String(order._id);
      if (duplicateIds.has(id)) {
        reasons.add('DUPLICATE_ORDER_ID');
        count += 1;
        continue;
      }

      const validationError = orderValidationError(order);
      if (validationError) {
        invalidOrders += 1;
        reasons.add('INVALID_LEGACY_ORDER');
        count += 1;
        continue;
      }

      if (!canonicalIds.has(id)) {
        unmigratedOrders += 1;
        reasons.add('UNMIGRATED_ORDER');
        count += 1;
      }
    }

    if (count > 0) {
      results.push({
        userId: user._id,
        count,
        reasons: [...reasons],
        duplicateGroups,
        missingOrderIds,
        invalidOrders,
        unmigratedOrders
      });
      if (results.length >= limit) break;
    }
  }

  return results;
}

// Backwards-compatible summary used by existing callers/tests. A user is
// reported whenever any blocking condition exists.
async function findUnmigratedLegacyOrders(options = {}) {
  const blockers = await findLegacyOrderBlockers(options);
  return blockers.map(entry => ({ userId: entry.userId, count: entry.count }));
}

module.exports = {
  findLegacyOrderBlockers,
  findUnmigratedLegacyOrders,
  duplicateIdGroups
};
