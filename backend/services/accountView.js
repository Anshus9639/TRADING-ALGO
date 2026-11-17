const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  legacyOrderId,
  legacyTradeId,
  resolveLegacyOrderId,
  resolveLegacyTradeId
} = require('../lib/legacyIdentity');

function toPlainPosition(position) {
  const quantity = position.quantity || 0;
  const hasAvg = typeof position.avgPrice === 'number'
    && Number.isFinite(position.avgPrice)
    && position.avgPrice > 0;
  const known = position.costBasisStatus !== 'UNKNOWN' && (hasAvg || quantity === 0);

  const mapped = {
    _id: position._id,
    symbol: position.symbol,
    quantity,
    lockedQuantity: position.lockedQuantity || 0,
    avgPrice: known ? (hasAvg ? position.avgPrice : 0) : null
  };
  if (!known) mapped.costBasisStatus = 'UNKNOWN';
  return mapped;
}

function duplicateIdsFromList(ids) {
  const counts = new Map();
  for (const id of ids) {
    if (!id) continue;
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id));
}

function mapTrade(trade) {
  return {
    _id: trade._id,
    orderId: trade.orderId || null,
    symbol: trade.symbol,
    type: trade.side,
    quantity: trade.quantity,
    price: trade.executionPrice,
    timestamp: trade.timestamp || trade.createdAt,
    realizedPnl: trade.realizedPnl === undefined ? null : trade.realizedPnl,
    clientOrderId: trade.clientOrderId || null
  };
}

// Legacy embedded array shape (pre-Batch-D documents).
function mapLegacyTrade(trade) {
  return {
    _id: trade._id,
    orderId: null,
    symbol: trade.symbol,
    type: trade.type,
    quantity: trade.quantity,
    price: trade.price,
    timestamp: trade.timestamp,
    realizedPnl: null,
    clientOrderId: null,
    legacy: true
  };
}

function mapOrder(order) {
  return {
    _id: order._id,
    symbol: order.symbol,
    type: order.side,
    quantity: order.quantity,
    limitPrice: order.limitPrice,
    timestamp: order.createdAt,
    clientOrderId: order.clientOrderId,
    status: order.status
  };
}

function mapLegacyOrder(order) {
  return {
    _id: order._id,
    symbol: order.symbol,
    type: order.type,
    quantity: order.quantity,
    limitPrice: order.limitPrice,
    timestamp: order.timestamp,
    clientOrderId: null,
    status: 'OPEN',
    legacy: true
  };
}

function compareByTimeThenId(a, b) {
  const left = new Date(a.timestamp || 0).getTime();
  const right = new Date(b.timestamp || 0).getTime();
  if (left !== right) return left - right;
  return String(a._id).localeCompare(String(b._id));
}

async function loadOpenOrders(userId, { session } = {}) {
  let query = Order.find({ userId, status: 'OPEN' }).sort({ createdAt: 1, _id: 1 });
  if (session) query = query.session(session);
  return query.lean();
}

// Dual-read compatibility: canonical collections are authoritative for new
// activity, while untouched embedded legacy arrays remain visible until the
// gated migration is explicitly run. Embedded records that were already
// migrated (same _id) are skipped so they do not appear twice.
async function loadPendingOrders(user) {
  const orders = await loadOpenOrders(user._id);
  const legacy = user.pendingOrders || [];
  if (legacy.length === 0) return orders.map(mapOrder);

  const canonicalIds = new Set(
    (await Order.find({ userId: user._id }).select('_id').lean()).map(order => String(order._id))
  );
  // Resolve the same identity the migration uses, so an id-less record that
  // was migrated is not returned a second time.
  const legacyIds = legacy.map(order => (order ? resolveLegacyOrderId(user._id, order) : null));
  // Mongoose invents an in-memory _id for embedded subdocuments stored without
  // one, so the content-derived id is checked as well: the migration stores it
  // as the canonical _id.
  const derivedIds = legacy.map(order => (order ? String(legacyOrderId(user._id, order)) : null));
  // Duplicate identities cannot be matched to a single canonical twin. Show
  // every affected record with an explicit ambiguity flag instead of silently
  // dropping the copies whose id happens to exist canonically.
  const duplicateIds = duplicateIdsFromList(legacyIds);

  const canonical = orders.map(order => {
    const mapped = mapOrder(order);
    if (duplicateIds.has(String(order._id))) mapped.ambiguous = true;
    return mapped;
  });

  const pending = [];
  legacy.forEach((order, index) => {
    if (!order) return;
    const id = legacyIds[index];
    const migrated = canonicalIds.has(id) || canonicalIds.has(derivedIds[index]);
    if (!duplicateIds.has(id) && migrated) return;
    const mapped = mapLegacyOrder(order);
    if (duplicateIds.has(id)) mapped.ambiguous = true;
    pending.push(mapped);
  });

  return [...canonical, ...pending].sort(compareByTimeThenId);
}

async function loadTrades(user) {
  const trades = await Trade.find({ userId: user._id }).sort({ timestamp: 1, _id: 1 }).lean();
  const canonicalIds = new Set(trades.map(trade => String(trade._id)));
  const legacyRaw = user.trades || [];
  const legacyIds = legacyRaw.map(trade => (trade ? resolveLegacyTradeId(user._id, trade) : null));
  const derivedIds = legacyRaw.map(trade => (trade ? String(legacyTradeId(user._id, trade)) : null));
  const duplicateIds = duplicateIdsFromList(legacyIds);

  const canonical = trades.map(trade => {
    const mapped = mapTrade(trade);
    if (duplicateIds.has(String(trade._id))) mapped.ambiguous = true;
    return mapped;
  });

  const legacy = [];
  legacyRaw.forEach((trade, index) => {
    if (!trade) return;
    const id = legacyIds[index];
    const migrated = canonicalIds.has(id) || canonicalIds.has(derivedIds[index]);
    if (!duplicateIds.has(id) && migrated) return;
    const mapped = mapLegacyTrade(trade);
    if (duplicateIds.has(id)) mapped.ambiguous = true;
    legacy.push(mapped);
  });

  return [...canonical, ...legacy].sort(compareByTimeThenId);
}

async function loadAccountView(user) {
  if (!user) return null;
  const pendingOrderIds = [...duplicateIdsFromList(
    (user.pendingOrders || []).map(order => (order ? resolveLegacyOrderId(user._id, order) : null))
  )];
  const tradeIds = [...duplicateIdsFromList(
    (user.trades || []).map(trade => (trade ? resolveLegacyTradeId(user._id, trade) : null))
  )];
  const [portfolio, trades, pendingOrders] = await Promise.all([
    Promise.resolve((user.portfolio || []).map(toPlainPosition)),
    loadTrades(user),
    loadPendingOrders(user)
  ]);

  return {
    id: user._id,
    username: user.username,
    email: user.email,
    balance: user.balance,
    lockedBalance: user.lockedBalance || 0,
    portfolio,
    trades,
    pendingOrders,
    legacyAmbiguity: { pendingOrderIds, tradeIds }
  };
}

function serializePortfolio(user) {
  return (user.portfolio || []).map(toPlainPosition);
}

module.exports = {
  mapTrade,
  mapLegacyTrade,
  mapOrder,
  mapLegacyOrder,
  loadOpenOrders,
  loadPendingOrders,
  loadTrades,
  loadAccountView,
  serializePortfolio
};
