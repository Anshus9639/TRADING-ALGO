const crypto = require('crypto');
const fs = require('fs');
const mongoose = require('mongoose');

const DefaultUser = require('../models/User');
const DefaultOrder = require('../models/Order');
const DefaultTrade = require('../models/Trade');
const {
  validateSymbol,
  validateSide,
  validateQuantity,
  validateLimitPrice,
  validateNotional
} = require('../lib/validate');
const { roundTo } = require('../lib/numbers');

/*
 * Legacy embedded data (pre-Batch-D) semantics:
 *   - pendingOrders BUY: balance was reduced by quantity * limitPrice at placement.
 *   - pendingOrders SELL: portfolio.quantity was reduced at placement.
 *   - trades: append-only history without canonical Order/Trade documents.
 *
 * This migration copies that data into the canonical collections without
 * touching the embedded arrays. It preserves embedded ids, reconstructs SELL
 * total holdings/lockedQuantity, and annotates lockedBalance for legacy BUY
 * reservations. Anything that cannot be reconstructed safely is reported and
 * left untouched instead of being guessed.
 */

const BACKUP_VERSION = 1;
const SEVERITY = Object.freeze({ ERROR: 'error', WARNING: 'warning' });
const EPSILON = 1e-9;

const DEFAULT_TX_OPTIONS = Object.freeze({
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
  readPreference: 'primary'
});

function defaultModels(overrides = {}) {
  return {
    User: overrides.User || DefaultUser,
    Order: overrides.Order || DefaultOrder,
    Trade: overrides.Trade || DefaultTrade
  };
}

function issue(code, severity, userId, target, detail) {
  return {
    code,
    severity,
    userId: userId ? String(userId) : null,
    target: target === undefined || target === null ? null : String(target),
    detail: detail || null
  };
}

function asFinite(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeAvgPrice(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function optionalObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const text = String(value);
  return mongoose.Types.ObjectId.isValid(text) ? new mongoose.Types.ObjectId(text) : null;
}

// Deterministic ids keep reruns idempotent even if an embedded subdocument
// somehow lacks an _id. The seed contains only values already present in the
// record, so no financial data is invented.
function deterministicId(parts) {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return new mongoose.Types.ObjectId(digest.slice(0, 24));
}

// Legacy orders predate clientOrderId and carry no idempotency key. Deriving it
// from the owning user and the embedded order id makes reruns stable and keeps
// the key unique across users even if two embedded order ids collide. Legacy
// keys are internal, so they intentionally bypass the manual-API UUID validator.
function legacyOrderKey(userId, legacyId) {
  return `legacy:${String(userId)}:${String(legacyId)}`;
}

function normalizeTimestamp(value, fallback) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (value !== undefined && value !== null) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date(fallback);
}

function validationError(result) {
  return result && result.ok === false ? result.error : null;
}

function validateLegacyOrder(raw) {
  const symbol = validateSymbol(raw.symbol);
  if (!symbol.ok) return { ok: false, error: validationError(symbol) };
  const side = validateSide(raw.type);
  if (!side.ok) return { ok: false, error: validationError(side) };
  const quantity = validateQuantity(raw.quantity);
  if (!quantity.ok) return { ok: false, error: validationError(quantity) };
  const limitPrice = validateLimitPrice(raw.limitPrice);
  if (!limitPrice.ok) return { ok: false, error: validationError(limitPrice) };
  const notional = validateNotional(quantity.value, limitPrice.value);
  if (!notional.ok) return { ok: false, error: validationError(notional) };

  return {
    ok: true,
    value: {
      symbol: symbol.value,
      side: side.value,
      quantity: quantity.value,
      limitPrice: limitPrice.value,
      reservedAmount: notional.value
    }
  };
}

function validateLegacyTrade(raw) {
  const symbol = validateSymbol(raw.symbol);
  if (!symbol.ok) return { ok: false, error: validationError(symbol) };
  const side = validateSide(raw.type);
  if (!side.ok) return { ok: false, error: validationError(side) };
  const quantity = validateQuantity(raw.quantity);
  if (!quantity.ok) return { ok: false, error: validationError(quantity) };
  const price = validateLimitPrice(raw.price);
  if (!price.ok) return { ok: false, error: validationError(price) };

  return {
    ok: true,
    value: {
      symbol: symbol.value,
      side: side.value,
      quantity: quantity.value,
      executionPrice: price.value,
      notional: roundTo(quantity.value * price.value)
    }
  };
}

function matchesMigratedOrder(canonical, value, userId, legacyId) {
  const expectedClientId = legacyOrderKey(userId, legacyId);
  return canonical.symbol === value.symbol
    && canonical.side === value.side
    && canonical.orderType === 'LIMIT'
    && canonical.quantity === value.quantity
    && canonical.limitPrice === value.limitPrice
    && canonical.clientOrderId === expectedClientId;
}

function matchesMigratedTrade(canonical, value, timestamp) {
  return canonical.symbol === value.symbol
    && canonical.side === value.side
    && canonical.quantity === value.quantity
    && canonical.executionPrice === value.executionPrice
    && new Date(canonical.timestamp).getTime() === timestamp.getTime();
}

function buildOrderDocument({ userId, id, value, timestamp }) {
  return {
    _id: id,
    userId,
    symbol: value.symbol,
    side: value.side,
    orderType: 'LIMIT',
    quantity: value.quantity,
    remainingQuantity: value.quantity,
    limitPrice: value.limitPrice,
    status: 'OPEN',
    clientOrderId: legacyOrderKey(userId, id),
    filledPrice: null,
    filledAt: null,
    cancelledAt: null,
    attempts: 0,
    lastError: null,
    claimedBy: null,
    claimedAt: null,
    leaseExpiresAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    __v: 0
  };
}

function buildTradeDocument({ userId, id, value, timestamp }) {
  return {
    _id: id,
    userId,
    orderId: null,
    symbol: value.symbol,
    side: value.side,
    quantity: value.quantity,
    executionPrice: value.executionPrice,
    notional: value.notional,
    // Legacy trades do not carry a reliable cost basis for PnL. Leaving this
    // null is deliberate: reconstructing it could invent financial history.
    realizedPnl: null,
    clientOrderId: null,
    timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    __v: 0
  };
}

function buildPositions(user, userId, issues) {
  const positions = [];
  const bySymbol = new Map();

  for (const raw of Array.isArray(user.portfolio) ? user.portfolio : []) {
    const symbol = typeof raw.symbol === 'string' ? raw.symbol.trim().toUpperCase() : '';
    if (!symbol) {
      issues.push(issue('INVALID_POSITION', SEVERITY.ERROR, userId, null, 'Portfolio entry without a symbol; user migration is blocked.'));
      return { positions: [], bySymbol, blocked: true };
    }
    if (bySymbol.has(symbol)) {
      issues.push(issue('DUPLICATE_POSITION_SYMBOL', SEVERITY.ERROR, userId, symbol, 'Duplicate portfolio symbol; user migration is blocked to avoid dropping holdings.'));
      return { positions: [], bySymbol, blocked: true };
    }

    const quantity = asFinite(raw.quantity, Number.NaN);
    const lockedQuantity = asFinite(raw.lockedQuantity, 0);
    const avgPrice = normalizeAvgPrice(raw.avgPrice);

    if (!Number.isFinite(quantity) || quantity < 0) {
      issues.push(issue('INVALID_POSITION_QUANTITY', SEVERITY.ERROR, userId, symbol, `Position quantity ${raw.quantity} is not a non-negative number.`));
      return { positions: [], bySymbol, blocked: true };
    }
    if (lockedQuantity < 0) {
      issues.push(issue('NEGATIVE_LOCKED_QUANTITY', SEVERITY.ERROR, userId, symbol, `lockedQuantity ${lockedQuantity} is negative.`));
      return { positions: [], bySymbol, blocked: true };
    }

    // A missing basis is preserved as unknown, never rewritten to zero. Known
    // positive bases are carried through byte-for-byte.
    const costBasisKnown = avgPrice !== null || quantity === 0;
    if (quantity > 0 && !costBasisKnown) {
      issues.push(issue('MISSING_COST_BASIS', SEVERITY.WARNING, userId, symbol, 'Position has quantity but no recoverable average cost basis; avgPrice is stored as null and marked UNKNOWN.'));
    }

    const position = {
      _id: optionalObjectId(raw._id) || undefined,
      symbol,
      quantity: roundTo(quantity),
      lockedQuantity: roundTo(lockedQuantity),
      avgPrice: costBasisKnown ? avgPrice : null,
      costBasisStatus: costBasisKnown ? 'KNOWN' : 'UNKNOWN'
    };
    positions.push(position);
    bySymbol.set(symbol, position);
  }

  return { positions, bySymbol, blocked: false };
}

function planAccount(user, existingOrders = [], existingTrades = [], { now = Date.now() } = {}) {
  const userId = user._id;
  const fallbackTimestamp = normalizeTimestamp(user.createdAt, now);
  const issues = [];
  const orders = [];
  const trades = [];

  const portfolio = buildPositions(user, userId, issues);
  if (portfolio.blocked) {
    return {
      userId: String(userId),
      blocked: true,
      issues,
      orders: [],
      trades: [],
      portfolio: { positions: [], changed: false },
      lockedBalance: asFinite(user.lockedBalance, 0),
      lockedBalanceChanged: false
    };
  }

  const { positions, bySymbol } = portfolio;
  const legacyOrders = Array.isArray(user.pendingOrders) ? user.pendingOrders : [];
  const legacyTrades = Array.isArray(user.trades) ? user.trades : [];

  // Duplicate embedded _ids make ownership of the canonical twin ambiguous.
  // Blocking the whole account is deliberate: migrating one copy would either
  // silently discard the other or invent a second order.
  function duplicateIdGroups(records) {
    const counts = new Map();
    for (const record of records) {
      if (!record || !record._id) continue;
      const id = String(record._id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({ id, count }));
  }

  const duplicateOrderIds = duplicateIdGroups(legacyOrders);
  const duplicateTradeIds = duplicateIdGroups(legacyTrades);

  for (const group of duplicateOrderIds) {
    issues.push(issue('DUPLICATE_LEGACY_ID', SEVERITY.ERROR, userId, group.id, `${group.count} embedded pending orders share this _id; the account is blocked pending manual remediation.`));
  }
  for (const group of duplicateTradeIds) {
    issues.push(issue('DUPLICATE_LEGACY_ID', SEVERITY.ERROR, userId, group.id, `${group.count} embedded trades share this _id; the account is blocked pending manual remediation.`));
  }

  if (duplicateOrderIds.length > 0 || duplicateTradeIds.length > 0) {
    return {
      userId: String(userId),
      blocked: true,
      issues,
      orders: [],
      trades: [],
      duplicateOrderIds,
      duplicateTradeIds,
      portfolio: { positions: [], changed: false },
      lockedBalance: asFinite(user.lockedBalance, 0),
      lockedBalanceChanged: false
    };
  }

  const ordersById = new Map(existingOrders.map(order => [String(order._id), order]));
  const ordersByClientId = new Map(
    existingOrders
      .filter(order => order.clientOrderId)
      .map(order => [order.clientOrderId, order])
  );
  const tradesById = new Map(existingTrades.map(trade => [String(trade._id), trade]));

  const seenOrderIds = new Set();
  for (let index = 0; index < legacyOrders.length; index += 1) {
    const raw = legacyOrders[index] || {};
    const providedId = optionalObjectId(raw._id);
    const legacyId = providedId || deterministicId([
      'order', String(userId), index, raw.symbol, raw.type, raw.quantity, raw.limitPrice
    ]);
    const legacyIdText = String(legacyId);

    if (seenOrderIds.has(legacyIdText)) {
      issues.push(issue('DUPLICATE_LEGACY_ID', SEVERITY.ERROR, userId, legacyIdText, 'Two embedded pending orders share the same _id; the duplicate is not migrated.'));
      continue;
    }
    seenOrderIds.add(legacyIdText);

    const validated = validateLegacyOrder(raw);
    if (!validated.ok) {
      issues.push(issue('INVALID_LEGACY_ORDER', SEVERITY.ERROR, userId, legacyIdText, validated.error));
      if (String(raw.type).toUpperCase() === 'SELL') {
        issues.push(issue('IRRECOVERABLE_ESCROW', SEVERITY.ERROR, userId, legacyIdText, 'Invalid legacy SELL order may have deducted holdings that cannot be reconstructed.'));
      }
      continue;
    }

    const timestamp = normalizeTimestamp(raw.timestamp, fallbackTimestamp);
    if (!raw.timestamp) {
      issues.push(issue('MISSING_TIMESTAMP', SEVERITY.WARNING, userId, legacyIdText, `Legacy order had no timestamp; user.createdAt (${fallbackTimestamp.toISOString()}) was used.`));
    }
    if (!providedId) {
      issues.push(issue('GENERATED_LEGACY_ID', SEVERITY.WARNING, userId, legacyIdText, 'Legacy order had no _id; a deterministic id was generated.'));
    }

    const canonical = ordersById.get(legacyIdText) || ordersByClientId.get(legacyOrderKey(userId, legacyIdText));
    if (canonical) {
      if (matchesMigratedOrder(canonical, validated.value, userId, legacyIdText)) {
        orders.push({ action: 'already-migrated', legacyId: legacyIdText, legacy: raw, canonicalId: String(canonical._id) });
      } else {
        issues.push(issue('CONFLICTING_EXISTING_ORDER', SEVERITY.ERROR, userId, legacyIdText, 'A canonical order with the same id already exists with different financial fields.'));
        orders.push({ action: 'conflict', legacyId: legacyIdText, legacy: raw, canonicalId: String(canonical._id) });
      }
      continue;
    }

    orders.push({
      action: 'insert',
      legacyId: legacyIdText,
      legacy: raw,
      document: buildOrderDocument({
        userId,
        id: legacyId,
        value: validated.value,
        timestamp
      })
    });
  }

  const seenTradeIds = new Set();
  for (let index = 0; index < legacyTrades.length; index += 1) {
    const raw = legacyTrades[index] || {};
    const providedId = optionalObjectId(raw._id);
    const legacyId = providedId || deterministicId([
      'trade', String(userId), index, raw.symbol, raw.type, raw.quantity, raw.price, raw.timestamp
    ]);
    const legacyIdText = String(legacyId);

    if (seenTradeIds.has(legacyIdText)) {
      issues.push(issue('DUPLICATE_LEGACY_ID', SEVERITY.ERROR, userId, legacyIdText, 'Two embedded trades share the same _id; the duplicate is not migrated.'));
      continue;
    }
    seenTradeIds.add(legacyIdText);

    const validated = validateLegacyTrade(raw);
    if (!validated.ok) {
      issues.push(issue('INVALID_LEGACY_TRADE', SEVERITY.ERROR, userId, legacyIdText, validated.error));
      continue;
    }

    const timestamp = normalizeTimestamp(raw.timestamp, fallbackTimestamp);
    if (!raw.timestamp) {
      issues.push(issue('MISSING_TIMESTAMP', SEVERITY.WARNING, userId, legacyIdText, `Legacy trade had no timestamp; user.createdAt (${fallbackTimestamp.toISOString()}) was used.`));
    }
    if (!providedId) {
      issues.push(issue('GENERATED_LEGACY_ID', SEVERITY.WARNING, userId, legacyIdText, 'Legacy trade had no _id; a deterministic id was generated.'));
    }

    const canonical = tradesById.get(legacyIdText);
    if (canonical) {
      if (matchesMigratedTrade(canonical, validated.value, timestamp)) {
        trades.push({ action: 'already-migrated', legacyId: legacyIdText, legacy: raw, canonicalId: String(canonical._id) });
      } else {
        issues.push(issue('CONFLICTING_EXISTING_TRADE', SEVERITY.ERROR, userId, legacyIdText, 'A canonical trade with the same _id already exists with different financial fields.'));
        trades.push({ action: 'conflict', legacyId: legacyIdText, legacy: raw, canonicalId: String(canonical._id) });
      }
      continue;
    }

    trades.push({
      action: 'insert',
      legacyId: legacyIdText,
      legacy: raw,
      document: buildTradeDocument({
        userId,
        id: legacyId,
        value: validated.value,
        timestamp
      })
    });
  }

  // Locks are recomputed from the canonical OPEN orders plus not-yet-migrated
  // legacy orders. Migrated legacy orders are already counted as canonical, so
  // rerunning apply cannot double count or double deduct.
  let reservedBalance = 0;
  const lockedBySymbol = new Map();

  for (const canonical of existingOrders) {
    if (canonical.status !== 'OPEN') continue;
    if (canonical.orderType !== 'LIMIT') {
      issues.push(issue('ORPHANED_CANONICAL_OPEN_MARKET', SEVERITY.WARNING, userId, String(canonical._id), 'A canonical market order is OPEN; it is excluded from lock reconciliation.'));
      continue;
    }
    const remaining = asFinite(canonical.remainingQuantity, canonical.quantity);
    if (remaining <= 0) continue;
    if (canonical.side === 'BUY') {
      reservedBalance = roundTo(reservedBalance + roundTo(remaining * canonical.limitPrice));
    } else if (canonical.side === 'SELL') {
      lockedBySymbol.set(
        canonical.symbol,
        roundTo((lockedBySymbol.get(canonical.symbol) || 0) + remaining)
      );
    }
  }

  for (const planned of orders) {
    if (planned.action !== 'insert') continue;
    const doc = planned.document;
    if (doc.side === 'BUY') {
      reservedBalance = roundTo(reservedBalance + roundTo(doc.quantity * doc.limitPrice));
      continue;
    }

    let position = bySymbol.get(doc.symbol);
    if (!position) {
      position = {
        _id: undefined,
        symbol: doc.symbol,
        quantity: 0,
        lockedQuantity: 0,
        avgPrice: null,
        costBasisStatus: 'UNKNOWN'
      };
      positions.push(position);
      bySymbol.set(doc.symbol, position);
      issues.push(issue('MISSING_POSITION_RECONSTRUCTED', SEVERITY.WARNING, userId, doc.symbol, 'Legacy SELL order had no portfolio position; the deducted quantity is reconstructed from the order.'));
      issues.push(issue('MISSING_COST_BASIS', SEVERITY.WARNING, userId, doc.symbol, 'Reconstructed position has no recoverable cost basis; avgPrice remains null and UNKNOWN.'));
    }
    // The legacy engine deducted holdings when the SELL limit was placed.
    // Restore the total holding and mark it locked.
    position.quantity = roundTo(position.quantity + doc.quantity);
    lockedBySymbol.set(
      doc.symbol,
      roundTo((lockedBySymbol.get(doc.symbol) || 0) + doc.quantity)
    );
  }

  for (const position of positions) {
    const expectedLock = roundTo(lockedBySymbol.get(position.symbol) || 0);
    if (position.lockedQuantity !== expectedLock) {
      if (position.lockedQuantity > expectedLock) {
        issues.push(issue('STALE_LOCK_CLEARED', SEVERITY.WARNING, userId, position.symbol, `lockedQuantity ${position.lockedQuantity} exceeded open SELL orders (${expectedLock}); annotation was reconciled.`));
      }
      position.lockedQuantity = expectedLock;
    }
    if (position.quantity + EPSILON < position.lockedQuantity) {
      issues.push(issue('NEGATIVE_AVAILABLE', SEVERITY.ERROR, userId, position.symbol, `Available quantity would be ${roundTo(position.quantity - position.lockedQuantity)}.`));
    }
  }

  const currentLockedBalance = asFinite(user.lockedBalance, 0);
  if (currentLockedBalance < 0) {
    issues.push(issue('NEGATIVE_LOCKED_BALANCE', SEVERITY.WARNING, userId, null, `lockedBalance ${currentLockedBalance} is negative; annotation was reconciled.`));
  } else if (currentLockedBalance !== reservedBalance) {
    issues.push(issue('LOCK_BALANCE_ADJUSTED', SEVERITY.WARNING, userId, null, `lockedBalance ${currentLockedBalance} did not equal open BUY reservations (${reservedBalance}); annotation was reconciled.`));
  }

  const currentPositions = Array.isArray(user.portfolio) ? user.portfolio : [];
  const positionsChanged = positions.length !== currentPositions.length
    || positions.some((position, index) => {
      const current = currentPositions[index];
      return !current
        || current.symbol !== position.symbol
        || roundTo(asFinite(current.quantity, 0)) !== position.quantity
        || roundTo(asFinite(current.lockedQuantity, 0)) !== position.lockedQuantity
        || normalizeAvgPrice(current.avgPrice) !== normalizeAvgPrice(position.avgPrice)
        || (current.costBasisStatus || 'KNOWN') !== position.costBasisStatus;
    });

  const lockChanged = roundTo(currentLockedBalance) !== reservedBalance;

  return {
    userId: String(userId),
    blocked: false,
    issues,
    orders,
    trades,
    portfolio: { positions, changed: positionsChanged },
    lockedBalance: reservedBalance,
    lockedBalanceChanged: lockChanged
  };
}

function planHasChanges(plan) {
  if (plan.blocked) return false;
  return plan.orders.some(item => item.action === 'insert')
    || plan.trades.some(item => item.action === 'insert')
    || plan.portfolio.changed
    || plan.lockedBalanceChanged;
}

function summarizePlan(plan) {
  const ordersToInsert = plan.orders.filter(item => item.action === 'insert').length;
  const tradesToInsert = plan.trades.filter(item => item.action === 'insert').length;
  return {
    userId: plan.userId,
    blocked: plan.blocked === true,
    ordersToInsert,
    tradesToInsert,
    ordersAlreadyMigrated: plan.orders.filter(item => item.action === 'already-migrated').length,
    tradesAlreadyMigrated: plan.trades.filter(item => item.action === 'already-migrated').length,
    conflicts: plan.orders.filter(item => item.action === 'conflict').length
      + plan.trades.filter(item => item.action === 'conflict').length,
    portfolioChanged: plan.portfolio.changed,
    lockedBalanceChanged: plan.lockedBalanceChanged,
    issues: plan.issues
  };
}

function summarizePlans(plans, { mode, startedAt, finishedAt } = {}) {
  const issueCounts = {};
  const issues = [];
  const totals = {
    usersScanned: plans.length,
    usersBlocked: 0,
    usersWithChanges: 0,
    legacyPendingOrders: 0,
    legacyTrades: 0,
    ordersToInsert: 0,
    tradesToInsert: 0,
    ordersAlreadyMigrated: 0,
    tradesAlreadyMigrated: 0,
    conflicts: 0
  };

  for (const plan of plans) {
    const summary = summarizePlan(plan);
    if (summary.blocked) totals.usersBlocked += 1;
    if (planHasChanges(plan)) totals.usersWithChanges += 1;
    totals.legacyPendingOrders += plan.orders.length;
    totals.legacyTrades += plan.trades.length;
    totals.ordersToInsert += summary.ordersToInsert;
    totals.tradesToInsert += summary.tradesToInsert;
    totals.ordersAlreadyMigrated += summary.ordersAlreadyMigrated;
    totals.tradesAlreadyMigrated += summary.tradesAlreadyMigrated;
    totals.conflicts += summary.conflicts;

    for (const entry of plan.issues) {
      issueCounts[entry.code] = (issueCounts[entry.code] || 0) + 1;
      issues.push(entry);
    }
  }

  const errors = issues.filter(entry => entry.severity === SEVERITY.ERROR).length;
  const warnings = issues.length - errors;

  return {
    mode,
    startedAt: startedAt || null,
    finishedAt: finishedAt || null,
    totals,
    ambiguity: {
      total: issues.length,
      errors,
      warnings,
      issueCounts,
      issues
    }
  };
}

function groupByUser(documents) {
  const map = new Map();
  for (const document of documents) {
    const key = String(document.userId);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(document);
  }
  return map;
}

// Raw collection reads avoid Mongoose applying schema defaults while reading,
// so genuinely missing legacy timestamps remain detectable.
async function loadDataset({ User, Order, Trade }) {
  const [users, orders, trades] = await Promise.all([
    User.collection.find({}).sort({ _id: 1 }).toArray(),
    Order.collection.find({}).toArray(),
    Trade.collection.find({}).toArray()
  ]);
  return {
    users,
    ordersByUser: groupByUser(orders),
    tradesByUser: groupByUser(trades),
    counts: { users: users.length, orders: orders.length, trades: trades.length }
  };
}

function planDataset(dataset, { now = Date.now() } = {}) {
  return dataset.users.map(user => {
    const userId = String(user._id);
    return planAccount(
      user,
      dataset.ordersByUser.get(userId) || [],
      dataset.tradesByUser.get(userId) || [],
      { now }
    );
  });
}

async function transactionsSupported(mongooseInstance) {
  const admin = mongooseInstance.connection.db.admin();
  const hello = await admin.command({ hello: 1 });
  return Boolean(hello.setName) || Boolean(hello.isMongos) || hello.msg === 'isdbgrid';
}

function cleanPosition(position) {
  const doc = {
    symbol: position.symbol,
    quantity: position.quantity,
    lockedQuantity: position.lockedQuantity,
    avgPrice: position.avgPrice,
    costBasisStatus: position.costBasisStatus
  };
  if (position._id) doc._id = position._id;
  return doc;
}

async function applyUserPlan({ User, Order, Trade, mongoose: mongooseInstance, userId, now = Date.now() }) {
  const session = await mongooseInstance.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const [rawUser, user] = await Promise.all([
        User.collection.findOne({ _id: userId }, { session }),
        User.findById(userId).session(session)
      ]);
      if (!rawUser || !user) {
        result = { userId: String(userId), action: 'missing', ordersInserted: 0, tradesInserted: 0 };
        return;
      }
      const [existingOrders, existingTrades] = await Promise.all([
        Order.collection.find({ userId }, { session }).toArray(),
        Trade.collection.find({ userId }, { session }).toArray()
      ]);

      const plan = planAccount(rawUser, existingOrders, existingTrades, { now });
      if (plan.blocked) {
        result = {
          userId: String(userId),
          action: 'blocked',
          ordersInserted: 0,
          tradesInserted: 0,
          issues: plan.issues
        };
        return;
      }
      if (!planHasChanges(plan)) {
        result = {
          userId: String(userId),
          action: 'unchanged',
          ordersInserted: 0,
          tradesInserted: 0,
          issues: plan.issues
        };
        return;
      }

      let ordersInserted = 0;
      let tradesInserted = 0;

      for (const planned of plan.orders) {
        if (planned.action !== 'insert') continue;
        await Order.collection.insertOne(planned.document, { session });
        ordersInserted += 1;
      }
      for (const planned of plan.trades) {
        if (planned.action !== 'insert') continue;
        await Trade.collection.insertOne(planned.document, { session });
        tradesInserted += 1;
      }

      if (plan.portfolio.changed) {
        user.portfolio = plan.portfolio.positions.map(cleanPosition);
      }
      if (plan.lockedBalanceChanged) {
        user.lockedBalance = plan.lockedBalance;
      }
      if (plan.portfolio.changed || plan.lockedBalanceChanged) {
        await user.save({ session });
      }

      result = {
        userId: String(userId),
        action: 'updated',
        ordersInserted,
        tradesInserted,
        portfolioChanged: plan.portfolio.changed,
        lockedBalanceChanged: plan.lockedBalanceChanged,
        issues: plan.issues
      };
    }, DEFAULT_TX_OPTIONS);
  } catch (err) {
    result = {
      userId: String(userId),
      action: 'failed',
      ordersInserted: 0,
      tradesInserted: 0,
      error: err.code || err.name || 'ERROR',
      message: err.message
    };
  } finally {
    await session.endSession();
  }
  return result;
}

async function runMigration({ User, Order, Trade, mongoose: mongooseInstance, mode = 'dry-run', limit = null, now = Date.now() } = {}) {
  if (mode !== 'dry-run' && mode !== 'apply') {
    throw new TypeError('mode must be "dry-run" or "apply".');
  }
  const models = defaultModels({ User, Order, Trade });
  const db = mongooseInstance || mongoose;
  const startedAt = new Date().toISOString();

  if (mode === 'apply') {
    const supported = await transactionsSupported(db);
    if (!supported) {
      throw new Error('Refusing to apply the migration without MongoDB transaction support (a replica set is required).');
    }
  }

  if (mode === 'dry-run') {
    const dataset = await loadDataset(models);
    const users = limit ? dataset.users.slice(0, limit) : dataset.users;
    const plans = users.map(user => {
      const userId = String(user._id);
      return planAccount(
        user,
        dataset.ordersByUser.get(userId) || [],
        dataset.tradesByUser.get(userId) || [],
        { now }
      );
    });
    return {
      ...summarizePlans(plans, { mode, startedAt, finishedAt: new Date().toISOString() }),
      writes: { users: 0, orders: 0, trades: 0 }
    };
  }

  let query = models.User.find({}).sort({ _id: 1 }).select('_id').lean();
  if (limit) query = query.limit(limit);
  const userIds = await query;

  const results = [];
  for (const { _id } of userIds) {
    results.push(await applyUserPlan({
      User: models.User,
      Order: models.Order,
      Trade: models.Trade,
      mongoose: db,
      userId: _id,
      now
    }));
  }

  const issueCounts = {};
  const issues = [];
  for (const result of results) {
    for (const entry of result.issues || []) {
      issueCounts[entry.code] = (issueCounts[entry.code] || 0) + 1;
      issues.push(entry);
    }
  }

  const failed = results.filter(result => result.action === 'failed');
  return {
    mode,
    startedAt,
    finishedAt: new Date().toISOString(),
    usersScanned: results.length,
    usersUpdated: results.filter(result => result.action === 'updated').length,
    usersUnchanged: results.filter(result => result.action === 'unchanged').length,
    usersBlocked: results.filter(result => result.action === 'blocked').length,
    usersMissing: results.filter(result => result.action === 'missing').length,
    usersFailed: failed.length,
    failures: failed,
    writes: {
      users: results.filter(result => result.action === 'updated').length,
      orders: results.reduce((sum, result) => sum + (result.ordersInserted || 0), 0),
      trades: results.reduce((sum, result) => sum + (result.tradesInserted || 0), 0)
    },
    ambiguity: {
      total: issues.length,
      errors: issues.filter(entry => entry.severity === SEVERITY.ERROR).length,
      warnings: issues.filter(entry => entry.severity === SEVERITY.WARNING).length,
      issueCounts,
      issues
    }
  };
}

async function auditLegacyData(modelsInput = {}, { now = Date.now() } = {}) {
  const models = defaultModels(modelsInput);
  const dataset = await loadDataset(models);
  const plans = planDataset(dataset, { now });
  const summary = summarizePlans(plans, {
    mode: 'audit',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  });

  const openBuy = dataset.users.reduce((sum, user) => {
    const legacy = Array.isArray(user.pendingOrders) ? user.pendingOrders : [];
    return sum + legacy.filter(order => String(order.type).toUpperCase() === 'BUY').length;
  }, 0);
  const openSell = dataset.users.reduce((sum, user) => {
    const legacy = Array.isArray(user.pendingOrders) ? user.pendingOrders : [];
    return sum + legacy.filter(order => String(order.type).toUpperCase() === 'SELL').length;
  }, 0);

  function duplicateGroupsFor(records) {
    const counts = new Map();
    for (const record of records) {
      if (!record || !record._id) continue;
      const id = String(record._id);
      counts.set(id, (counts.get(id) || 0) + 1);
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id, count]) => ({ id, count }));
  }

  const duplicateOrderGroups = [];
  const duplicateTradeGroups = [];
  for (const user of dataset.users) {
    for (const group of duplicateGroupsFor(Array.isArray(user.pendingOrders) ? user.pendingOrders : [])) {
      duplicateOrderGroups.push({ userId: String(user._id), legacyOrderId: group.id, count: group.count });
    }
    for (const group of duplicateGroupsFor(Array.isArray(user.trades) ? user.trades : [])) {
      duplicateTradeGroups.push({ userId: String(user._id), legacyTradeId: group.id, count: group.count });
    }
  }

  const unknownCostBasis = [];
  for (const plan of plans) {
    for (const position of plan.portfolio.positions) {
      if (position.costBasisStatus === 'UNKNOWN' && position.quantity > 0) {
        unknownCostBasis.push({ userId: plan.userId, symbol: position.symbol, quantity: position.quantity });
      }
    }
  }

  return {
    readOnly: true,
    checkedAt: new Date().toISOString(),
    collections: dataset.counts,
    legacy: {
      users: summary.totals.usersScanned,
      pendingOrders: summary.totals.legacyPendingOrders,
      openBuy,
      openSell,
      trades: summary.totals.legacyTrades,
      duplicateOrderGroups,
      duplicateTradeGroups,
      unknownCostBasis
    },
    migration: {
      usersWithChanges: summary.totals.usersWithChanges,
      usersBlocked: summary.totals.usersBlocked,
      ordersToInsert: summary.totals.ordersToInsert,
      tradesToInsert: summary.totals.tradesToInsert,
      ordersAlreadyMigrated: summary.totals.ordersAlreadyMigrated,
      tradesAlreadyMigrated: summary.totals.tradesAlreadyMigrated,
      conflicts: summary.totals.conflicts
    },
    ambiguity: summary.ambiguity,
    notes: [
      'Embedded pendingOrders and trades are never modified or deleted by this batch.',
      'Legacy trades are copied without synthesized realized PnL.',
      'Positions without a recoverable cost basis are marked UNKNOWN with a null avgPrice.',
      'Duplicate embedded _ids block the affected account pending manual remediation.',
      'Apply requires an explicit flag, confirmation env var, and a backup file.'
    ]
  };
}

async function verifyMigration(modelsInput = {}, { backupFile = null, now = Date.now() } = {}) {
  const models = defaultModels(modelsInput);
  const dataset = await loadDataset(models);
  const plans = planDataset(dataset, { now });
  const mismatches = [];
  const issues = [];
  const unknownCostBasis = [];

  for (const plan of plans) {
    issues.push(...plan.issues);
    if (plan.blocked) {
      mismatches.push({ code: 'BLOCKED_USER', userId: plan.userId, detail: 'User was not migrated because legacy data is ambiguous.' });
      continue;
    }
    const pendingOrders = plan.orders.filter(item => item.action === 'insert');
    const pendingTrades = plan.trades.filter(item => item.action === 'insert');
    if (pendingOrders.length > 0) {
      mismatches.push({ code: 'UNMIGRATED_ORDERS', userId: plan.userId, detail: `${pendingOrders.length} valid legacy order(s) are not in the canonical collection.` });
    }
    if (pendingTrades.length > 0) {
      mismatches.push({ code: 'UNMIGRATED_TRADES', userId: plan.userId, detail: `${pendingTrades.length} valid legacy trade(s) are not in the canonical collection.` });
    }

    const user = dataset.users.find(item => String(item._id) === plan.userId);
    if (!user) {
      mismatches.push({ code: 'MISSING_USER', userId: plan.userId, detail: 'User disappeared between reads.' });
      continue;
    }
    if (user.balance < 0) {
      mismatches.push({ code: 'NEGATIVE_BALANCE', userId: plan.userId, detail: `balance ${user.balance}.` });
    }
    const expectedLockedBalance = roundTo(plan.lockedBalance);
    const actualLockedBalance = roundTo(asFinite(user.lockedBalance, 0));
    if (expectedLockedBalance !== actualLockedBalance) {
      mismatches.push({
        code: 'LOCKED_BALANCE_MISMATCH',
        userId: plan.userId,
        detail: `lockedBalance ${actualLockedBalance} != open BUY reservations ${expectedLockedBalance}.`
      });
    }

    for (const position of plan.portfolio.positions) {
      if (position.costBasisStatus === 'UNKNOWN' && position.quantity > 0) {
        unknownCostBasis.push({
          userId: plan.userId,
          symbol: position.symbol,
          quantity: position.quantity,
          status: 'UNKNOWN'
        });
      }
      const current = (user.portfolio || []).find(item => item.symbol === position.symbol);
      if (!current) {
        mismatches.push({ code: 'MISSING_POSITION', userId: plan.userId, detail: `${position.symbol} is missing from the user portfolio.` });
        continue;
      }
      const currentQuantity = roundTo(asFinite(current.quantity, 0));
      const expectedStatus = position.costBasisStatus;
      const currentStatus = current.costBasisStatus
        || (normalizeAvgPrice(current.avgPrice) !== null ? 'KNOWN' : (currentQuantity > 0 ? 'UNKNOWN' : 'KNOWN'));
      if (currentStatus !== expectedStatus) {
        mismatches.push({
          code: 'COST_BASIS_STATUS_MISMATCH',
          userId: plan.userId,
          detail: `${position.symbol} costBasisStatus ${currentStatus} != expected ${expectedStatus}.`
        });
      }
      if (normalizeAvgPrice(current.avgPrice) !== normalizeAvgPrice(position.avgPrice)) {
        mismatches.push({
          code: 'COST_BASIS_MISMATCH',
          userId: plan.userId,
          detail: `${position.symbol} avgPrice ${current.avgPrice} != expected ${position.avgPrice}.`
        });
      }
      if (roundTo(asFinite(current.lockedQuantity, 0)) !== roundTo(position.lockedQuantity)) {
        mismatches.push({
          code: 'LOCKED_QUANTITY_MISMATCH',
          userId: plan.userId,
          detail: `${position.symbol} lockedQuantity ${asFinite(current.lockedQuantity, 0)} != open SELL reservations ${position.lockedQuantity}.`
        });
      }
      if (roundTo(asFinite(current.quantity, 0)) !== roundTo(position.quantity)) {
        mismatches.push({
          code: 'POSITION_QUANTITY_MISMATCH',
          userId: plan.userId,
          detail: `${position.symbol} quantity ${asFinite(current.quantity, 0)} != reconstructed total ${position.quantity}.`
        });
      }
      const available = roundTo(position.quantity - position.lockedQuantity);
      if (available < -EPSILON) {
        mismatches.push({ code: 'NEGATIVE_AVAILABLE', userId: plan.userId, detail: `${position.symbol} available ${available}.` });
      }
    }
  }

  let backup = null;
  if (backupFile) {
    backup = await verifyBackup({ User: models.User }, backupFile);
    if (!backup.ok) {
      mismatches.push({ code: 'BACKUP_VERIFICATION_FAILED', userId: null, detail: backup.error || 'Backup integrity check failed.' });
    }
  }

  return {
    ok: mismatches.length === 0,
    checkedAt: new Date().toISOString(),
    collections: dataset.counts,
    users: plans.length,
    migrated: {
      orders: plans.reduce((sum, plan) => sum + plan.orders.filter(item => item.action === 'already-migrated').length, 0),
      trades: plans.reduce((sum, plan) => sum + plan.trades.filter(item => item.action === 'already-migrated').length, 0),
      pending: plans.reduce((sum, plan) => sum
        + plan.orders.filter(item => item.action === 'insert').length
        + plan.trades.filter(item => item.action === 'insert').length, 0)
    },
    lockReconciliation: {
      usersChecked: plans.length,
      mismatches: mismatches.filter(item => item.code.startsWith('LOCKED_')).length
    },
    costBasis: {
      affectedUsers: new Set(unknownCostBasis.map(entry => entry.userId)).size,
      unknownPositions: unknownCostBasis
    },
    mismatches,
    ambiguity: {
      total: issues.length,
      errors: issues.filter(entry => entry.severity === SEVERITY.ERROR).length,
      warnings: issues.filter(entry => entry.severity === SEVERITY.WARNING).length
    },
    backup
  };
}

function backupHash(users) {
  return crypto.createHash('sha256').update(JSON.stringify(users)).digest('hex');
}

async function createBackup({ User }, file, { now = new Date() } = {}) {
  const users = await User.collection.find({}).sort({ _id: 1 }).toArray();
  const payload = {
    version: BACKUP_VERSION,
    createdAt: now.toISOString(),
    userCount: users.length,
    users,
    sha256: backupHash(users)
  };
  await fs.promises.writeFile(file, JSON.stringify(payload, null, 2), 'utf8');
  return {
    file,
    version: BACKUP_VERSION,
    createdAt: payload.createdAt,
    userCount: payload.userCount,
    sha256: payload.sha256
  };
}

function readBackup(file) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, error: `Backup file could not be read: ${err.message}` };
  }
  if (!payload || payload.version !== BACKUP_VERSION || !Array.isArray(payload.users)) {
    return { ok: false, error: `Backup file is not a version ${BACKUP_VERSION} migration backup.` };
  }
  const expected = backupHash(payload.users);
  if (payload.sha256 !== expected) {
    return { ok: false, error: 'Backup checksum does not match its contents.' };
  }
  return { ok: true, payload };
}

async function verifyBackup({ User }, file) {
  const read = readBackup(file);
  if (!read.ok) return read;
  const { payload } = read;

  const currentUsers = await User.collection.find({}).sort({ _id: 1 }).toArray();
  const currentById = new Map(currentUsers.map(user => [String(user._id), user]));
  const missingUsers = [];
  const changedEmbedded = [];

  for (const backupUser of payload.users) {
    const current = currentById.get(String(backupUser._id));
    if (!current) {
      missingUsers.push(String(backupUser._id));
      continue;
    }
    // The embedded arrays are intentionally retained, so a correct migration
    // must leave them byte-for-byte equivalent to the backup.
    if (JSON.stringify(backupUser.pendingOrders || []) !== JSON.stringify(current.pendingOrders || [])
      || JSON.stringify(backupUser.trades || []) !== JSON.stringify(current.trades || [])) {
      changedEmbedded.push(String(backupUser._id));
    }
  }

  return {
    ok: missingUsers.length === 0 && changedEmbedded.length === 0,
    file,
    version: payload.version,
    createdAt: payload.createdAt,
    userCount: payload.userCount,
    currentUserCount: currentUsers.length,
    missingUsers,
    changedEmbedded,
    error: missingUsers.length > 0 ? 'Backup users are missing from the database.' : null
  };
}

module.exports = {
  BACKUP_VERSION,
  SEVERITY,
  DEFAULT_TX_OPTIONS,
  issue,
  deterministicId,
  validateLegacyOrder,
  validateLegacyTrade,
  planAccount,
  planHasChanges,
  summarizePlan,
  summarizePlans,
  loadDataset,
  planDataset,
  transactionsSupported,
  applyUserPlan,
  runMigration,
  auditLegacyData,
  verifyMigration,
  createBackup,
  readBackup,
  verifyBackup,
  backupHash
};
