const express = require('express');
const { rateLimit } = require('express-rate-limit');
const auth = require('../middleware/auth');
const { rateLimitOptions } = require('../middleware/rateLimit');
const { getRateLimitConfig } = require('../config/env');
const { createTradeService } = require('../services/tradeService');
const { validateClientOrderId } = require('../lib/validate');

function createTradeRouter({
  feed,
  runtimeStatus = null,
  rateLimit: rateLimitConfig = getRateLimitConfig().trade
} = {}) {
  const router = express.Router();
  const tradeService = createTradeService({ feed, runtimeStatus });
  const tradeLimiter = rateLimitConfig.max > 0 && rateLimitConfig.windowMs > 0
    ? rateLimit(rateLimitOptions(rateLimitConfig))
    : (_req, _res, next) => next();

  async function send(res, work) {
    try {
      const result = await work();
      return res.status(result.status).json(result.body);
    } catch (err) {
      console.error('Trade error:', err.message);
      return res.status(500).json({ success: false, message: 'Server Error' });
    }
  }

  // Every manual order requires a client-generated UUID `clientOrderId`. It is
  // the idempotency key shared by market and limit submissions: a retry with
  // the same key and identical parameters returns the original result, while
  // reusing a key with different parameters is rejected with 409
  // IDEMPOTENCY_CONFLICT instead of creating a second trade.
  function requireClientOrderId(req, res) {
    const check = validateClientOrderId(req.body?.clientOrderId);
    if (!check.ok) {
      res.status(400).json({ success: false, code: 'INVALID_CLIENT_ORDER_ID', message: check.error });
      return null;
    }
    return check.value;
  }

  function handleMarketOrder(req, res, side) {
    const clientOrderId = requireClientOrderId(req, res);
    if (!clientOrderId) return undefined;

    return send(res, () => tradeService.executeMarketOrder({
      userId: req.user.id,
      side,
      symbol: req.body?.symbol,
      quantity: req.body?.quantity,
      clientOrderId
    }));
  }

  // Market orders are priced exclusively by the server-side market feed.
  // The limiter runs before `auth` so it also bounds token verification work;
  // keying by IP is therefore required (there is no authenticated user yet).
  router.post('/buy', tradeLimiter, auth, (req, res) => handleMarketOrder(req, res, 'BUY'));
  router.post('/sell', tradeLimiter, auth, (req, res) => handleMarketOrder(req, res, 'SELL'));

  router.post('/limit', tradeLimiter, auth, (req, res) => {
    const clientOrderId = requireClientOrderId(req, res);
    if (!clientOrderId) return undefined;

    const { symbol, type, quantity, limitPrice } = req.body || {};

    return send(res, () => tradeService.placeLimitOrder({
      userId: req.user.id,
      side: type,
      symbol,
      quantity,
      limitPrice,
      clientOrderId
    }));
  });

  router.delete('/cancel/:orderId', tradeLimiter, auth, (req, res) => {
    return send(res, () => tradeService.cancelOrder({
      orderId: req.params.orderId,
      userId: req.user.id
    }));
  });

  return router;
}

module.exports = { createTradeRouter };
