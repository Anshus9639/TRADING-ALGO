const mongoose = require('mongoose');
const {
  validateSymbol,
  validateSymbolFormat,
  validateSide,
  validateQuantity,
  validateLimitPrice,
  validateNotional
} = require('../lib/validate');
const { roundTo, DUST_THRESHOLD } = require('../lib/numbers');
const { checkMarketRules, hasUsableMarketRules } = require('../lib/exchangeFilters');
const { assertTransition } = require('../lib/orderState');
const { shouldExecuteLimitOrder } = require('./limitMatcher');
const { TRANSACTIONS_UNAVAILABLE, createTransactionSupport } = require('../lib/transactions');
const {
  mapTrade,
  mapOrder,
  loadPendingOrders,
  serializePortfolio
} = require('./accountView');
const { resolveLegacyOrderId } = require('../lib/legacyIdentity');

const CLIENT_ORDER_ID_PATTERN = /^[A-Za-z0-9:_-]{1,100}$/;

class TradeRejection extends Error {
  constructor(status, message, code = null) {
    super(message);
    this.name = 'TradeRejection';
    this.status = status;
    this.code = code;
  }
}

function reject(status, message, code = null) {
  const body = { success: false, message };
  if (code) body.code = code;
  return { status, body };
}

const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
const PARAMETER_TOLERANCE = 1e-9;
const ESCROW_TOLERANCE = 1e-9;
// Matches the market feed's default staleness window. A quote accepted just
// before a claim or transaction can otherwise settle long after it expired.
const EXECUTION_QUOTE_MAX_AGE_MS = 15000;
const ACTIVE_ORDER_STATUSES = ['OPEN', 'FILLING'];

// Legacy holdings may have no recoverable purchase price. A null/UNKNOWN basis
// is never coerced to zero: doing so would invent realized profit on every sale.
function hasKnownCostBasis(position) {
  if (!position) return false;
  if (position.costBasisStatus === 'UNKNOWN') return false;
  return typeof position.avgPrice === 'number'
    && Number.isFinite(position.avgPrice)
    && position.avgPrice > 0;
}

function applyBuyToPosition(position, quantity, notional, executionPrice) {
  const oldQty = roundTo(position.quantity || 0);
  const newQty = roundTo(oldQty + quantity);

  if (oldQty <= DUST_THRESHOLD) {
    // A dust/empty position carries no meaningful historical average.
    position.avgPrice = executionPrice;
    position.costBasisStatus = 'KNOWN';
  } else if (hasKnownCostBasis(position)) {
    position.avgPrice = roundTo(((oldQty * position.avgPrice) + notional) / newQty);
    position.costBasisStatus = 'KNOWN';
  } else {
    // The historical component is unknown, so the blended basis stays unknown.
    position.avgPrice = null;
    position.costBasisStatus = 'UNKNOWN';
  }

  position.quantity = newQty;
}

// A missing key is never generated implicitly: an order that was created
// without a stable key could not be retried safely after a network failure.
// Manual HTTP endpoints additionally require a UUID; the AI path supplies its
// server-issued proposal id, which is also accepted here.
function normalizeClientOrderId(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'clientOrderId is required and must be a string.' };
  }
  const trimmed = input.trim();
  if (trimmed === '' || !CLIENT_ORDER_ID_PATTERN.test(trimmed)) {
    return { ok: false, error: 'clientOrderId must be 1-100 characters of letters, digits, ":", "_" or "-".' };
  }
  return { ok: true, value: trimmed };
}

// A retry with the same key must describe the same order. Same key with
// different parameters is a client bug and never creates a second trade.
function matchesExistingOrder(order, expected) {
  if (!order) return false;
  if (order.orderType !== expected.orderType) return false;
  if (order.side !== expected.side) return false;
  if (String(order.symbol) !== String(expected.symbol)) return false;
  if (Math.abs(Number(order.quantity) - expected.quantity) > PARAMETER_TOLERANCE) return false;
  if (expected.orderType === 'LIMIT') {
    if (Math.abs(Number(order.limitPrice) - expected.limitPrice) > PARAMETER_TOLERANCE) return false;
  }
  return true;
}

function idempotencyConflict() {
  return reject(
    409,
    'clientOrderId was already used with different order parameters.',
    IDEMPOTENCY_CONFLICT
  );
}

function validateExecutionQuote(quote, symbol) {
  if (!quote || typeof quote !== 'object') {
    return { ok: false, error: 'Execution quote is required.' };
  }
  const { price } = quote;
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    return { ok: false, error: 'Execution quote price must be a positive number.' };
  }
  if (quote.symbol && String(quote.symbol).trim().toUpperCase() !== symbol) {
    return { ok: false, error: 'Execution quote symbol does not match the order.' };
  }
  return { ok: true, price };
}

// Settlement can be delayed by claim acquisition, transaction retries or slow
// database writes. The original observation must still be fresh when it is
// used, so its timestamp is re-checked inside every transaction attempt.
function isFreshExecutionQuote(quote, nowMs) {
  if (!quote || typeof quote.ts !== 'number' || !Number.isFinite(quote.ts)) return false;
  const ageMs = nowMs - quote.ts;
  return ageMs >= 0 && ageMs <= EXECUTION_QUOTE_MAX_AGE_MS;
}

function isDuplicateKeyError(err) {
  return Boolean(err) && (err.code === 11000 || err.code === 11001);
}

function createTradeService({
  feed,
  User = require('../models/User'),
  Order = require('../models/Order'),
  Trade = require('../models/Trade'),
  transactionSupport = null,
  runtimeStatus = null,
  getMarketRules = null,
  now = Date.now
} = {}) {
  if (!feed || typeof feed.getQuote !== 'function') {
    throw new TypeError('createTradeService requires a market feed instance.');
  }

  // Per-symbol exchange filters (tick/lot/minimums) come from the live
  // catalogue. When a provider is configured, complete filters are required:
  // new orders fail closed instead of being validated against global limits
  // the exchange may not honour. A provider therefore also acts as the
  // authority for which symbols currently have verifiable trading rules.
  function resolveMarketRules(symbol) {
    if (typeof getMarketRules !== 'function') {
      return { required: false, rules: null };
    }
    const rules = getMarketRules(symbol);
    return { required: true, rules: hasUsableMarketRules(rules) ? rules : null };
  }

  function marketRulesUnavailable() {
    return reject(
      503,
      'Trading is temporarily unavailable for this market because exchange rules could not be verified.',
      'MARKET_RULES_UNAVAILABLE'
    );
  }

  const support = transactionSupport
    || createTransactionSupport({ mongoose, now });

  async function runTransaction(work) {
    if (!(await support.isSupported())) {
      throw new TradeRejection(
        503,
        'Transactional trading is unavailable on this database deployment. Trading is disabled until a replica set is configured.',
        TRANSACTIONS_UNAVAILABLE
      );
    }

    const session = await mongoose.startSession();
    try {
      let value;
      await session.withTransaction(async () => {
        value = await work(session);
      }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary'
      });
      return value;
    } finally {
      await session.endSession();
    }
  }

  async function findExistingOrder(userId, clientOrderId) {
    return Order.findOne({ userId, clientOrderId }).lean();
  }

  async function waitForOrder(userId, clientOrderId) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      const order = await findExistingOrder(userId, clientOrderId);
      if (order) return order;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return null;
  }

  async function buildExistingResult(order) {
    if (!order) return null;
    const user = await User.findById(order.userId);
    if (!user) return null;

    if (order.status === 'FILLED') {
      const trade = await Trade.findOne({ orderId: order._id }).lean();
      return {
        status: 200,
        body: {
          success: true,
          message: 'Trade Executed Successfully',
          balance: user.balance,
          lockedBalance: user.lockedBalance || 0,
          portfolio: serializePortfolio(user),
          newTrade: trade ? mapTrade(trade) : null,
          executedPrice: order.filledPrice,
          pendingOrders: await loadPendingOrders(user),
          idempotent: true
        }
      };
    }

    if (order.status === 'OPEN') {
      return {
        status: 200,
        body: {
          success: true,
          message: `${order.side} Limit Order Placed at $${order.limitPrice}`,
          balance: user.balance,
          lockedBalance: user.lockedBalance || 0,
          portfolio: serializePortfolio(user),
          pendingOrders: await loadPendingOrders(user),
          idempotent: true
        }
      };
    }

    // A retry that reaches an order while the matcher holds its claim must be
    // told the placement was accepted, not treated as a new submission. The
    // escrow was reserved by the original request and is not reserved again.
    if (order.status === 'FILLING' && order.orderType === 'LIMIT') {
      return {
        status: 200,
        body: {
          success: true,
          message: `${order.side} Limit Order is being filled`,
          balance: user.balance,
          lockedBalance: user.lockedBalance || 0,
          portfolio: serializePortfolio(user),
          pendingOrders: await loadPendingOrders(user),
          idempotent: true
        }
      };
    }

    return null;
  }

  async function resolveExistingOrder(order, expected) {
    if (!order) return null;
    if (!matchesExistingOrder(order, expected)) return idempotencyConflict();
    const existing = await buildExistingResult(order);
    if (existing) return existing;
    return reject(409, 'Order is no longer active.', 'ORDER_NOT_ACTIVE');
  }

  async function executeMarketOrder({
    userId,
    side,
    symbol,
    quantity,
    clientOrderId,
    executionQuote = null
  }) {
    // Format-only first: a retried request for a pair that has since left the
    // live catalogue must still be able to replay its original order.
    const symbolCheck = validateSymbolFormat(symbol);
    if (!symbolCheck.ok) return reject(400, symbolCheck.error);

    const sideCheck = validateSide(side);
    if (!sideCheck.ok) return reject(400, sideCheck.error);

    const quantityCheck = validateQuantity(quantity);
    if (!quantityCheck.ok) return reject(400, quantityCheck.error);

    const clientCheck = normalizeClientOrderId(clientOrderId);
    if (!clientCheck.ok) return reject(400, clientCheck.error);

    const normalizedSymbol = symbolCheck.value;
    const normalizedQuantity = quantityCheck.value;
    const normalizedSide = sideCheck.value;
    const idempotencyKey = clientCheck.value;

    const expected = {
      orderType: 'MARKET',
      side: normalizedSide,
      symbol: normalizedSymbol,
      quantity: normalizedQuantity
    };

    const prior = await findExistingOrder(userId, idempotencyKey);
    if (prior) {
      const resolved = await resolveExistingOrder(prior, expected);
      if (resolved) return resolved;
    }

    const activeCheck = validateSymbol(normalizedSymbol);
    if (!activeCheck.ok) return reject(400, activeCheck.error);

    // A pair the catalogue cannot describe with complete filters is not
    // tradeable, even though the global limits alone would accept it. This
    // runs after the prior-order replay so an accepted order still returns its
    // original result when exchange metadata later becomes unavailable.
    const marketRules = resolveMarketRules(normalizedSymbol);
    if (marketRules.required && !marketRules.rules) return marketRulesUnavailable();

    // A quote accepted by a caller (AI drift check) is used for settlement so
    // the price shown and the price filled are the same observation. Freshness
    // is still verified against the authoritative feed.
    const freshness = feed.getQuote(normalizedSymbol);
    if (freshness.status !== 'ok') {
      return reject(503, 'Market price unavailable. Please retry.');
    }

    let executionPrice = freshness.price;
    if (executionQuote) {
      const quoteCheck = validateExecutionQuote(executionQuote, normalizedSymbol);
      if (!quoteCheck.ok) return reject(500, quoteCheck.error, 'INVALID_EXECUTION_QUOTE');
      executionPrice = quoteCheck.price;
    }

    const notionalCheck = validateNotional(normalizedQuantity, executionPrice);
    if (!notionalCheck.ok) return reject(400, notionalCheck.error);
    const notional = notionalCheck.value;

    // Refuse a size or value the market itself would reject. An explicit
    // quantity is never rounded into something the user did not request.
    const rulesCheck = checkMarketRules({
      quantity: normalizedQuantity,
      price: executionPrice,
      rules: marketRules.rules,
      enforceTick: false
    });
    if (!rulesCheck.ok) return reject(400, rulesCheck.error, 'INVALID_ORDER_PRECISION');

    try {
      const outcome = await runTransaction(async session => {
        // A retry can reach its transaction after the original request has
        // committed. The existing order wins over an expired quote: the trade
        // already happened with the observation the caller is reusing.
        const duplicate = await Order.findOne({ userId, clientOrderId: idempotencyKey }).session(session).lean();
        if (duplicate) return { duplicate };

        // For a genuinely new order the quote was validated before the
        // transaction was opened. Re-check its timestamp now: a retry or a
        // slow commit must never settle at a price that has already expired.
        if (executionQuote && !isFreshExecutionQuote(executionQuote, now())) {
          throw new TradeRejection(
            409,
            'Execution quote expired before settlement. Request a fresh proposal.',
            'PRICE_CHANGED'
          );
        }

        // A manual order has no caller-supplied observation, so the feed is the
        // only source. It must still be fresh at settlement, not merely when
        // the request was accepted.
        if (!executionQuote && feed.getQuote(normalizedSymbol).status !== 'ok') {
          throw new TradeRejection(
            503,
            'Market price expired before settlement. Please retry.',
            'PRICE_UNAVAILABLE'
          );
        }

        const user = await User.findById(userId).session(session);
        if (!user) throw new TradeRejection(404, 'User not found in database.');

        let realizedPnl = null;

        if (normalizedSide === 'BUY') {
          if (user.balance < notional) {
            throw new TradeRejection(400, 'Insufficient USDT Balance.');
          }

          user.balance = roundTo(user.balance - notional);

          const assetIndex = user.portfolio.findIndex(p => p.symbol === normalizedSymbol);
          if (assetIndex > -1) {
            applyBuyToPosition(user.portfolio[assetIndex], normalizedQuantity, notional, executionPrice);
          } else {
            user.portfolio.push({
              symbol: normalizedSymbol,
              quantity: normalizedQuantity,
              lockedQuantity: 0,
              avgPrice: executionPrice,
              costBasisStatus: 'KNOWN'
            });
          }
        } else {
          const assetIndex = user.portfolio.findIndex(p => p.symbol === normalizedSymbol);
          if (assetIndex === -1) {
            throw new TradeRejection(400, `You do not own any ${normalizedSymbol}.`);
          }

          const position = user.portfolio[assetIndex];
          const availableQuantity = roundTo(position.quantity - (position.lockedQuantity || 0));
          if (availableQuantity < normalizedQuantity) {
            throw new TradeRejection(400, 'Insufficient Crypto Balance.');
          }

          realizedPnl = hasKnownCostBasis(position)
            ? roundTo((executionPrice - position.avgPrice) * normalizedQuantity)
            : null;
          user.balance = roundTo(user.balance + notional);

          const remaining = roundTo(position.quantity - normalizedQuantity);
          const stillLocked = position.lockedQuantity || 0;
          if (remaining <= DUST_THRESHOLD && stillLocked === 0) {
            user.portfolio.splice(assetIndex, 1);
          } else {
            position.quantity = remaining;
          }
        }

        const order = new Order({
          userId,
          symbol: normalizedSymbol,
          side: normalizedSide,
          orderType: 'MARKET',
          quantity: normalizedQuantity,
          remainingQuantity: 0,
          limitPrice: null,
          status: 'FILLED',
          clientOrderId: idempotencyKey,
          filledPrice: executionPrice,
          filledAt: new Date(now())
        });

        const trade = new Trade({
          userId,
          orderId: order._id,
          symbol: normalizedSymbol,
          side: normalizedSide,
          quantity: normalizedQuantity,
          executionPrice,
          notional,
          realizedPnl,
          clientOrderId: idempotencyKey,
          timestamp: new Date(now())
        });

        await order.save({ session });
        await trade.save({ session });
        await user.save({ session });

        return {
          orderId: order._id,
          balance: user.balance,
          lockedBalance: user.lockedBalance || 0,
          portfolio: serializePortfolio(user),
          newTrade: mapTrade(trade)
        };
      });

      if (outcome.duplicate) {
        const resolved = await resolveExistingOrder(outcome.duplicate, expected);
        if (resolved) return resolved;
      }

      return {
        status: 200,
        body: {
          success: true,
          message: 'Trade Executed Successfully',
          balance: outcome.balance,
          lockedBalance: outcome.lockedBalance,
          portfolio: outcome.portfolio,
          newTrade: outcome.newTrade,
          executedPrice: executionPrice,
          idempotent: false
        }
      };
    } catch (err) {
      return handleTransactionFailure(err, userId, idempotencyKey, expected);
    }
  }

  async function placeLimitOrder({
    userId,
    side,
    symbol,
    quantity,
    limitPrice,
    clientOrderId
  }) {
    // Format-only first: replaying a prior order must outrank the live
    // catalogue check (see executeMarketOrder).
    const symbolCheck = validateSymbolFormat(symbol);
    if (!symbolCheck.ok) return reject(400, symbolCheck.error);

    const sideCheck = validateSide(side);
    if (!sideCheck.ok) return reject(400, sideCheck.error);

    const quantityCheck = validateQuantity(quantity);
    if (!quantityCheck.ok) return reject(400, quantityCheck.error);

    const priceCheck = validateLimitPrice(limitPrice);
    if (!priceCheck.ok) return reject(400, priceCheck.error);

    const notionalCheck = validateNotional(quantityCheck.value, priceCheck.value);
    if (!notionalCheck.ok) return reject(400, notionalCheck.error);

    const clientCheck = normalizeClientOrderId(clientOrderId);
    if (!clientCheck.ok) return reject(400, clientCheck.error);

    const normalizedSymbol = symbolCheck.value;
    const normalizedSide = sideCheck.value;
    const normalizedQuantity = quantityCheck.value;
    const normalizedLimitPrice = priceCheck.value;
    const reservedAmount = notionalCheck.value;
    const idempotencyKey = clientCheck.value;

    const expected = {
      orderType: 'LIMIT',
      side: normalizedSide,
      symbol: normalizedSymbol,
      quantity: normalizedQuantity,
      limitPrice: normalizedLimitPrice
    };

    const prior = await findExistingOrder(userId, idempotencyKey);
    if (prior) {
      const resolved = await resolveExistingOrder(prior, expected);
      if (resolved) return resolved;
    }

    const activeCheck = validateSymbol(normalizedSymbol);
    if (!activeCheck.ok) return reject(400, activeCheck.error);

    // New LIMIT orders fail closed for the same reason as market orders; the
    // prior-order replay above keeps an existing order addressable.
    const marketRules = resolveMarketRules(normalizedSymbol);
    if (marketRules.required && !marketRules.rules) return marketRulesUnavailable();

    const rulesCheck = checkMarketRules({
      quantity: normalizedQuantity,
      price: normalizedLimitPrice,
      rules: marketRules.rules
    });
    if (!rulesCheck.ok) return reject(400, rulesCheck.error, 'INVALID_ORDER_PRECISION');

    // New LIMIT orders are refused while the matcher cannot safely execute
    // them (legacy gate, transactions, indexes, or a failed matcher). Market
    // orders and cancellation/refund paths remain available.
    if (runtimeStatus
      && typeof runtimeStatus.isMatcherOperational === 'function'
      && !runtimeStatus.isMatcherOperational()) {
      return reject(
        503,
        'Limit orders are temporarily unavailable while the matching engine is not operational.',
        'MATCHER_NOT_READY'
      );
    }

    try {
      const outcome = await runTransaction(async session => {
        const duplicate = await Order.findOne({ userId, clientOrderId: idempotencyKey }).session(session).lean();
        if (duplicate) return { duplicate };

        const user = await User.findById(userId).session(session);
        if (!user) throw new TradeRejection(404, 'User not found.');

        // Escrow: BUY reserves USDT, SELL reserves asset quantity. Total
        // ownership is unchanged for SELL; only lockedQuantity increases.
        if (normalizedSide === 'BUY') {
          if (user.balance < reservedAmount) {
            throw new TradeRejection(400, 'Insufficient USDT for Limit Buy.');
          }
          user.balance = roundTo(user.balance - reservedAmount);
          user.lockedBalance = roundTo((user.lockedBalance || 0) + reservedAmount);
        } else {
          const assetIndex = user.portfolio.findIndex(p => p.symbol === normalizedSymbol);
          const availableQuantity = assetIndex === -1
            ? 0
            : roundTo(user.portfolio[assetIndex].quantity - (user.portfolio[assetIndex].lockedQuantity || 0));

          if (assetIndex === -1 || availableQuantity < normalizedQuantity) {
            throw new TradeRejection(400, `Insufficient ${normalizedSymbol} for Limit Sell.`);
          }

          user.portfolio[assetIndex].lockedQuantity = roundTo(
            (user.portfolio[assetIndex].lockedQuantity || 0) + normalizedQuantity
          );
        }

        const order = new Order({
          userId,
          symbol: normalizedSymbol,
          side: normalizedSide,
          orderType: 'LIMIT',
          quantity: normalizedQuantity,
          remainingQuantity: normalizedQuantity,
          limitPrice: normalizedLimitPrice,
          status: 'OPEN',
          clientOrderId: idempotencyKey
        });

        await order.save({ session });
        await user.save({ session });

        const openOrders = await Order.find({ userId, status: 'OPEN' })
          .sort({ createdAt: 1, _id: 1 })
          .session(session)
          .lean();

        return {
          balance: user.balance,
          lockedBalance: user.lockedBalance || 0,
          portfolio: serializePortfolio(user),
          pendingOrders: openOrders.map(mapOrder)
        };
      });

      if (outcome.duplicate) {
        const resolved = await resolveExistingOrder(outcome.duplicate, expected);
        if (resolved) return resolved;
      }

      return {
        status: 200,
        body: {
          success: true,
          message: `${normalizedSide} Limit Order Placed at $${normalizedLimitPrice}`,
          balance: outcome.balance,
          lockedBalance: outcome.lockedBalance,
          portfolio: outcome.portfolio,
          pendingOrders: outcome.pendingOrders,
          idempotent: false
        }
      };
    } catch (err) {
      return handleTransactionFailure(err, userId, idempotencyKey, expected);
    }
  }

  async function handleTransactionFailure(err, userId, clientOrderId, expected) {
    if (err instanceof TradeRejection) return reject(err.status, err.message, err.code);

    if (isDuplicateKeyError(err)) {
      const existingOrder = await waitForOrder(userId, clientOrderId);
      if (existingOrder) {
        const resolved = await resolveExistingOrder(existingOrder, expected);
        if (resolved) return resolved;
      }
    }

    throw err;
  }

  async function fillLimitOrder({ orderId, executionQuote, workerId, now: fillNow = now() }) {
    try {
      return await runTransaction(async session => {
        const order = await Order.findById(orderId).session(session);
        if (!order) return { status: 404, code: 'ORDER_NOT_FOUND' };
        if (order.status !== 'FILLING') return { status: 409, code: 'ORDER_NOT_CLAIMED' };
        if (!workerId || order.claimedBy !== workerId) return { status: 409, code: 'ORDER_NOT_CLAIMED' };
        if (!order.leaseExpiresAt || order.leaseExpiresAt.getTime() <= fillNow) {
          return { status: 409, code: 'CLAIM_EXPIRED' };
        }

        const quoteCheck = validateExecutionQuote(executionQuote, order.symbol);
        if (!quoteCheck.ok) return { status: 503, code: 'QUOTE_UNAVAILABLE' };
        if (!isFreshExecutionQuote(executionQuote, now())) {
          return { status: 503, code: 'QUOTE_UNAVAILABLE' };
        }
        const fillPrice = quoteCheck.price;

        if (!shouldExecuteLimitOrder({ type: order.side, limitPrice: order.limitPrice }, {
          status: 'ok',
          price: fillPrice
        })) {
          return { status: 409, code: 'NOT_ELIGIBLE' };
        }

        const user = await User.findById(order.userId).session(session);
        if (!user) throw new TradeRejection(404, 'User not found.');

        const quantity = roundTo(order.remainingQuantity);
        const reservedAmount = roundTo(quantity * order.limitPrice);
        const notional = roundTo(quantity * fillPrice);
        let realizedPnl = null;

        if (order.side === 'BUY') {
          if ((user.lockedBalance || 0) < reservedAmount) {
            throw new TradeRejection(500, 'Locked balance does not cover the reserved amount.');
          }

          user.lockedBalance = roundTo((user.lockedBalance || 0) - reservedAmount);
          // Price improvement: the difference between the reservation and the
          // actual quote returns to spendable balance.
          user.balance = roundTo(user.balance + reservedAmount - notional);

          const assetIndex = user.portfolio.findIndex(p => p.symbol === order.symbol);
          if (assetIndex > -1) {
            applyBuyToPosition(user.portfolio[assetIndex], quantity, notional, fillPrice);
          } else {
            user.portfolio.push({
              symbol: order.symbol,
              quantity,
              lockedQuantity: 0,
              avgPrice: fillPrice,
              costBasisStatus: 'KNOWN'
            });
          }
        } else {
          const assetIndex = user.portfolio.findIndex(p => p.symbol === order.symbol);
          if (assetIndex === -1) {
            throw new TradeRejection(500, `Portfolio position for ${order.symbol} is missing.`);
          }

          const position = user.portfolio[assetIndex];
          const locked = position.lockedQuantity || 0;
          if (position.quantity < quantity || locked < quantity) {
            throw new TradeRejection(500, `Locked quantity for ${order.symbol} does not cover the order.`);
          }

          realizedPnl = hasKnownCostBasis(position)
            ? roundTo((fillPrice - position.avgPrice) * quantity)
            : null;
          const remaining = roundTo(position.quantity - quantity);
          position.lockedQuantity = roundTo(locked - quantity);
          if (remaining <= DUST_THRESHOLD && position.lockedQuantity === 0) {
            user.portfolio.splice(assetIndex, 1);
          } else {
            position.quantity = remaining;
          }
          user.balance = roundTo(user.balance + notional);
        }

        assertTransition(order.status, 'FILLED');
        order.status = 'FILLED';
        order.filledPrice = fillPrice;
        order.filledAt = new Date(fillNow);
        order.remainingQuantity = 0;
        order.claimedBy = null;
        order.claimedAt = null;
        order.leaseExpiresAt = null;

        const trade = new Trade({
          userId: order.userId,
          orderId: order._id,
          symbol: order.symbol,
          side: order.side,
          quantity,
          executionPrice: fillPrice,
          notional,
          realizedPnl,
          clientOrderId: order.clientOrderId,
          timestamp: new Date(fillNow)
        });

        await trade.save({ session });
        await order.save({ session });
        await user.save({ session });

        return {
          status: 200,
          code: 'FILLED',
          body: {
            success: true,
            message: 'Limit order filled.',
            orderId: order._id,
            executedPrice: fillPrice,
            realizedPnl,
            balance: user.balance,
            lockedBalance: user.lockedBalance || 0,
            portfolio: serializePortfolio(user),
            newTrade: mapTrade(trade)
          }
        };
      });
    } catch (err) {
      if (err instanceof TradeRejection) return reject(err.status, err.message, err.code);
      throw err;
    }
  }

  async function releaseClaim({ orderId, workerId, error = null }) {
    await Order.updateOne(
      { _id: orderId, status: 'FILLING', claimedBy: workerId },
      {
        $set: { status: 'OPEN', lastError: error },
        $unset: { claimedBy: 1, claimedAt: 1, leaseExpiresAt: 1 }
      }
    );
  }

  function sumBuyReservations(orders) {
    return orders.reduce((sum, item) => {
      const remaining = Number(item.remainingQuantity);
      const price = Number(item.limitPrice);
      if (!Number.isFinite(remaining) || remaining <= 0) return sum;
      if (!Number.isFinite(price) || price <= 0) return sum;
      return roundTo(sum + roundTo(remaining * price));
    }, 0);
  }

  function sumSellReservations(orders) {
    return orders.reduce((sum, item) => {
      const remaining = Number(item.remainingQuantity);
      return Number.isFinite(remaining) && remaining > 0
        ? roundTo(sum + roundTo(remaining))
        : sum;
    }, 0);
  }

  // Escrow is aggregated per account (lockedBalance) and per position
  // (lockedQuantity), so it is shared by every active order. A failed order may
  // only refund its own reservation while the pool still covers all active
  // reservations. When the pool is short, ownership of the missing funds is
  // ambiguous; releasing anything would silently consume a sibling order's
  // escrow, so the record is quarantined instead.
  async function verifyBuyEscrow({ order, user, reservedAmount, session }) {
    if (reservedAmount <= 0) return { ok: true, amount: 0 };
    const active = await Order.find({
      userId: order.userId,
      side: 'BUY',
      status: { $in: ACTIVE_ORDER_STATUSES }
    }).session(session).lean();
    const required = sumBuyReservations(active);
    const locked = roundTo(user.lockedBalance || 0);
    if (locked + ESCROW_TOLERANCE < required) return { ok: false, amount: 0 };
    return { ok: true, amount: reservedAmount };
  }

  async function verifySellEscrow({ order, user, quantity, session }) {
    if (quantity <= 0) return { ok: true, amount: 0 };
    const active = await Order.find({
      userId: order.userId,
      side: 'SELL',
      symbol: order.symbol,
      status: { $in: ACTIVE_ORDER_STATUSES }
    }).session(session).lean();
    const required = sumSellReservations(active);
    const position = (user.portfolio || []).find(item => item.symbol === order.symbol);
    if (!position) return { ok: false, amount: 0 };
    const locked = roundTo(position.lockedQuantity || 0);
    if (locked + ESCROW_TOLERANCE < required) return { ok: false, amount: 0 };
    return { ok: true, amount: quantity };
  }

  async function failOrder({ orderId, workerId, error = null }) {
    try {
      return await runTransaction(async session => {
        const order = await Order.findById(orderId).session(session);
        if (!order) return { status: 404, code: 'ORDER_NOT_FOUND' };
        if (!['OPEN', 'FILLING'].includes(order.status)) {
          return { status: 409, code: 'ORDER_NOT_ACTIVE' };
        }
        if (order.status === 'FILLING' && workerId && order.claimedBy !== workerId) {
          return { status: 409, code: 'ORDER_NOT_CLAIMED' };
        }

        const user = await User.findById(order.userId).session(session);
        if (!user) throw new TradeRejection(404, 'User not found.');

        // Malformed legacy/corrupt orders may have non-numeric fields. They
        // never reserved valid escrow, so release only finite, positive values
        // instead of propagating NaN through the balance.
        const rawQuantity = Number(order.remainingQuantity);
        const rawLimitPrice = Number(order.limitPrice);
        const quantity = Number.isFinite(rawQuantity) && rawQuantity > 0 ? roundTo(rawQuantity) : 0;
        const escrowIssues = [];

        if (order.side === 'BUY') {
          const reservedAmount = Number.isFinite(rawLimitPrice) && rawLimitPrice > 0
            ? roundTo(quantity * rawLimitPrice)
            : 0;
          const escrow = await verifyBuyEscrow({ order, user, reservedAmount, session });
          if (escrow.ok) {
            user.lockedBalance = roundTo((user.lockedBalance || 0) - escrow.amount);
            user.balance = roundTo(user.balance + escrow.amount);
          } else {
            escrowIssues.push('BUY escrow could not be verified; no funds were released.');
          }
        } else {
          const escrow = await verifySellEscrow({ order, user, quantity, session });
          if (escrow.ok) {
            const position = user.portfolio.find(item => item.symbol === order.symbol);
            if (position) {
              position.lockedQuantity = roundTo((position.lockedQuantity || 0) - escrow.amount);
            }
          } else {
            escrowIssues.push('SELL escrow could not be verified; no holdings were unlocked.');
          }
        }

        assertTransition(order.status, 'FAILED');
        order.status = 'FAILED';
        order.lastError = [error, ...escrowIssues].filter(Boolean).join(' ') || null;
        order.claimedBy = null;
        order.claimedAt = null;
        order.leaseExpiresAt = null;
        order.remainingQuantity = 0;

        // A malformed record cannot pass full schema validation, but it must
        // still be terminally marked FAILED so it cannot block the matcher.
        await order.save({ session, validateBeforeSave: false });
        await user.save({ session });

        return { status: 200, code: 'FAILED' };
      });
    } catch (err) {
      if (err instanceof TradeRejection) return reject(err.status, err.message, err.code);
      throw err;
    }
  }

  async function cancelOrder({ orderId, userId }) {
    try {
      return await runTransaction(async session => {
        let order = null;
        if (mongoose.Types.ObjectId.isValid(orderId)) {
          order = await Order.findOne({ _id: orderId, userId }).session(session);
        }

        const user = await User.findById(userId).session(session);
        if (!user) return reject(404, 'User not found.');

        if (order) {
          if (order.status === 'CANCELLED') {
            return { status: 200, body: { success: true, message: 'Order already cancelled.' } };
          }
          if (order.status === 'FILLING') {
            return reject(409, 'Order is being filled and cannot be cancelled.', 'ORDER_IN_PROGRESS');
          }
          if (order.status === 'FILLED') {
            return reject(409, 'Order was already filled.', 'ORDER_ALREADY_FILLED');
          }
          if (order.status !== 'OPEN') {
            return reject(409, 'Order is no longer active.', 'ORDER_NOT_ACTIVE');
          }

          const quantity = roundTo(order.remainingQuantity);
          if (order.side === 'BUY') {
            const reservedAmount = roundTo(quantity * order.limitPrice);
            if ((user.lockedBalance || 0) < reservedAmount) {
              throw new TradeRejection(500, 'Locked balance is inconsistent with this order.');
            }
            user.lockedBalance = roundTo((user.lockedBalance || 0) - reservedAmount);
            user.balance = roundTo(user.balance + reservedAmount);
          } else {
            const assetIndex = user.portfolio.findIndex(p => p.symbol === order.symbol);
            if (assetIndex === -1 || (user.portfolio[assetIndex].lockedQuantity || 0) < quantity) {
              throw new TradeRejection(500, 'Locked quantity is inconsistent with this order.');
            }
            user.portfolio[assetIndex].lockedQuantity = roundTo(
              (user.portfolio[assetIndex].lockedQuantity || 0) - quantity
            );
          }

          assertTransition(order.status, 'CANCELLED');
          order.status = 'CANCELLED';
          order.cancelledAt = new Date(now());
          order.remainingQuantity = 0;

          await order.save({ session });
          await user.save({ session });

          return {
            status: 200,
            body: { success: true, message: 'Order Cancelled & Escrow Refunded' }
          };
        }

        // Legacy embedded orders created before Batch D are still cancellable
        // with their original escrow semantics until the gated migration runs.
        // Match the resolved identity the account view exposes: records that
        // never stored an _id are shown with a deterministic id, so comparing
        // the hydrating synthetic _id would make them impossible to cancel.
        const legacyIndex = (user.pendingOrders || []).findIndex(
          o => o && String(resolveLegacyOrderId(user._id, o)) === String(orderId)
        );
        if (legacyIndex === -1) return reject(404, 'Order not found.');

        const legacy = user.pendingOrders[legacyIndex];
        if (legacy.type === 'BUY') {
          user.balance = roundTo(user.balance + (legacy.quantity * legacy.limitPrice));
        } else if (legacy.type === 'SELL') {
          const assetIndex = user.portfolio.findIndex(p => p.symbol === legacy.symbol);
          if (assetIndex > -1) {
            const position = user.portfolio[assetIndex];
            position.quantity = roundTo(position.quantity + legacy.quantity);
            // The restored units came from this position, so a verified basis
            // still applies to them. Without one the basis must stay UNKNOWN
            // rather than inventing a purchase price for the restored units.
            const basis = Number(position.avgPrice);
            if (!Number.isFinite(basis) || basis <= 0) {
              position.avgPrice = null;
              position.costBasisStatus = 'UNKNOWN';
            }
          } else {
            user.portfolio.push({
              symbol: legacy.symbol,
              quantity: legacy.quantity,
              lockedQuantity: 0,
              avgPrice: null,
              costBasisStatus: 'UNKNOWN'
            });
          }
        }

        user.pendingOrders.splice(legacyIndex, 1);
        await user.save({ session });

        return {
          status: 200,
          body: { success: true, message: 'Order Cancelled & Escrow Refunded', legacy: true }
        };
      });
    } catch (err) {
      if (err instanceof TradeRejection) return reject(err.status, err.message, err.code);
      throw err;
    }
  }

  async function getExecutionResult({ userId, clientOrderId }) {
    if (typeof clientOrderId !== 'string' || !clientOrderId) return null;
    const order = await findExistingOrder(userId, clientOrderId);
    return buildExistingResult(order);
  }

  return {
    executeMarketOrder,
    placeLimitOrder,
    fillLimitOrder,
    cancelOrder,
    releaseClaim,
    failOrder,
    getExecutionResult
  };
}

module.exports = {
  createTradeService,
  CLIENT_ORDER_ID_PATTERN,
  TradeRejection
};
