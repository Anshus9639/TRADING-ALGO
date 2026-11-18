const express = require('express');
const { rateLimit } = require('express-rate-limit');
const { rateLimitOptions } = require('../middleware/rateLimit');
const { getRateLimitConfig } = require('../config/env');

function createMarketRouter({
  market = null,
  rateLimit: rateLimitConfig = getRateLimitConfig().marketRead
} = {}) {
  const router = express.Router();
  const readLimiter = rateLimitConfig.max > 0 && rateLimitConfig.windowMs > 0
    ? rateLimit(rateLimitOptions({
      ...rateLimitConfig,
      message: 'Too many market data requests. Please wait and retry.'
    }))
    : (_req, _res, next) => next();

  // Startup creates the app before the catalogue exists and attaches it to the
  // shared market context afterwards, so the catalogue must be resolved per
  // request instead of captured once at router construction.
  function currentCatalogue() {
    const catalogue = market && market.catalogue;
    return catalogue && typeof catalogue.getCatalogue === 'function' ? catalogue : null;
  }

  // The catalogue itself caches upstream refreshes; the limiter bounds how
  // often a single caller can ask for that cached snapshot.
  router.get('/symbols', readLimiter, async (req, res) => {
    const catalogue = currentCatalogue();
    if (!catalogue) {
      return res.status(503).json({
        success: false,
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Market data is unavailable.'
      });
    }

    try {
      const report = await catalogue.getCatalogue();
      res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=30');
      return res.json({
        success: true,
        source: report.source,
        stale: Boolean(report.stale),
        updatedAt: report.updatedAt,
        symbols: report.symbols
      });
    } catch {
      return res.status(503).json({
        success: false,
        code: 'MARKET_DATA_UNAVAILABLE',
        message: 'Market data is unavailable.'
      });
    }
  });

  return router;
}

module.exports = { createMarketRouter };
