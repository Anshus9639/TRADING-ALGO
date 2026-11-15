const crypto = require('crypto');
const Order = require('../models/Order');
const { SUPPORTED_SYMBOLS } = require('../lib/validate');
const { shouldExecuteLimitOrder } = require('./limitMatcher');

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_LEASE_MS = 15000;
const DEFAULT_MAX_ATTEMPTS = 5;

function isPositiveFinite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isMalformedOrder(order) {
  if (!order || typeof order.symbol !== 'string' || !SUPPORTED_SYMBOLS.includes(order.symbol)) return true;
  if (!['BUY', 'SELL'].includes(order.side)) return true;
  if (!isPositiveFinite(order.quantity) || !isPositiveFinite(order.remainingQuantity)) return true;
  if (!isPositiveFinite(order.limitPrice)) return true;
  return false;
}

// The matcher only ever reads bounded batches of OPEN orders and atomically
// claims each one before filling. Multiple instances can run concurrently:
// claim filters and lease expiry guarantee a single winner per order.
function createMatcher({
  feed,
  tradeService,
  Order: OrderModel = Order,
  now = Date.now,
  batchSize = DEFAULT_BATCH_SIZE,
  leaseMs = DEFAULT_LEASE_MS,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  workerId = `matcher:${crypto.randomUUID()}`
} = {}) {
  if (!feed || typeof feed.getQuote !== 'function') {
    throw new TypeError('createMatcher requires a market feed instance.');
  }
  if (!tradeService || typeof tradeService.fillLimitOrder !== 'function') {
    throw new TypeError('createMatcher requires a trade service.');
  }

  let running = false;

  async function claim(orderId) {
    const timestamp = now();
    return OrderModel.findOneAndUpdate(
      { _id: orderId, status: 'OPEN' },
      {
        $set: {
          status: 'FILLING',
          claimedBy: workerId,
          claimedAt: new Date(timestamp),
          leaseExpiresAt: new Date(timestamp + leaseMs)
        },
        $inc: { attempts: 1 }
      },
      { new: true }
    );
  }

  async function abandon(orderId, error) {
    const order = await OrderModel.findById(orderId).select('attempts').lean();
    const attempts = order ? order.attempts : maxAttempts;
    if (attempts >= maxAttempts) {
      return tradeService.failOrder({ orderId, workerId, error });
    }
    return tradeService.releaseClaim({ orderId, workerId, error });
  }

  async function processOrder(order) {
    if (isMalformedOrder(order)) {
      await tradeService.failOrder({
        orderId: order._id,
        workerId,
        error: 'Malformed order rejected by the matching engine.'
      });
      return 'failed';
    }

    const quote = feed.getQuote(order.symbol);
    if (quote.status !== 'ok') return 'skipped';

    if (!shouldExecuteLimitOrder({ type: order.side, limitPrice: order.limitPrice }, quote)) {
      return 'skipped';
    }

    const claimed = await claim(order._id);
    if (!claimed) return 'skipped';

    let result;
    try {
      result = await tradeService.fillLimitOrder({
        orderId: claimed._id,
        executionQuote: { symbol: order.symbol, price: quote.price, ts: quote.ts },
        workerId,
        now: now()
      });
    } catch (err) {
      await abandon(claimed._id, err.message);
      return 'failed';
    }

    if (result.status === 200) return 'filled';

    if (['NOT_ELIGIBLE', 'QUOTE_UNAVAILABLE', 'CLAIM_EXPIRED'].includes(result.code)) {
      await tradeService.releaseClaim({
        orderId: claimed._id,
        workerId,
        error: result.code
      });
      return 'skipped';
    }

    if (result.code === 'ORDER_NOT_CLAIMED' || result.code === 'ORDER_NOT_FOUND') {
      return 'skipped';
    }

    await abandon(claimed._id, result.code || 'FILL_FAILED');
    return 'failed';
  }

  async function runCycle() {
    if (running) return { skipped: true, reason: 'CYCLE_IN_PROGRESS' };
    running = true;

    const stats = {
      skipped: false,
      recovered: 0,
      examined: 0,
      filled: 0,
      failed: 0,
      deferred: 0
    };

    try {
      const timestamp = now();

      // Recover abandoned claims so a crashed worker cannot strand escrow.
      const recovery = await OrderModel.updateMany(
        {
          status: 'FILLING',
          leaseExpiresAt: { $lt: new Date(timestamp) }
        },
        {
          $set: { status: 'OPEN', lastError: 'Claim lease expired; order requeued.' },
          $unset: { claimedBy: 1, claimedAt: 1, leaseExpiresAt: 1 }
        }
      );
      stats.recovered = recovery.modifiedCount || 0;

      const candidates = await OrderModel.find({ status: 'OPEN', orderType: 'LIMIT' })
        .sort({ createdAt: 1, _id: 1 })
        .limit(batchSize)
        .lean();

      stats.examined = candidates.length;

      for (const candidate of candidates) {
        try {
          const outcome = await processOrder(candidate);
          if (outcome === 'filled') stats.filled += 1;
          else if (outcome === 'failed') stats.failed += 1;
          else stats.deferred += 1;
        } catch (err) {
          // One malformed or failing order must never stop the cycle.
          stats.failed += 1;
          console.error(`[matcher] order ${candidate._id} failed:`, err.message);
          try {
            await tradeService.releaseClaim({
              orderId: candidate._id,
              workerId,
              error: err.message
            });
          } catch (releaseErr) {
            console.error(`[matcher] could not release order ${candidate._id}:`, releaseErr.message);
          }
        }
      }

      return stats;
    } finally {
      running = false;
    }
  }

  return { runCycle, workerId, batchSize, leaseMs, maxAttempts };
}

module.exports = {
  createMatcher,
  DEFAULT_BATCH_SIZE,
  DEFAULT_LEASE_MS,
  DEFAULT_MAX_ATTEMPTS,
  isMalformedOrder
};
