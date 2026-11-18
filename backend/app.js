const express = require('express');
const cors = require('cors');
const { rateLimit } = require('express-rate-limit');
const { marketFeed } = require('./services/marketFeed');
const { createTradeRouter } = require('./routes/trade');
const { createCopilotRouter } = require('./routes/copilot');
const { createAuthRouter } = require('./routes/auth');
const { createMarketRouter } = require('./routes/market');
const { createHistoryFetcher } = require('./services/marketHistory');
const { normalizeChartInterval } = require('./lib/chartIntervals');
const { validateSymbolFormat } = require('./lib/validate');
const { symbolUniverse } = require('./services/symbolUniverse');
const { loadAppConfig, getRateLimitConfig } = require('./config/env');
const { rateLimitOptions } = require('./middleware/rateLimit');

// App-only configuration: does not require database or JWT secrets, so isolated
// tests can import this factory without a full environment.
const { corsOrigins, trustProxy } = loadAppConfig();

const corsOptions = {
  origin: corsOrigins,
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true
};

function createApp({
  feed = marketFeed,
  copilot = {},
  runtimeStatus = null,
  auth: authOptions = {},
  trade: tradeOptions = {},
  market = null,
  marketReadRateLimit = null,
  history = null
} = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  const historyFetcher = history || createHistoryFetcher();
  const readLimitConfig = marketReadRateLimit || getRateLimitConfig().marketRead;
  const historyLimiter = readLimitConfig.max > 0 && readLimitConfig.windowMs > 0
    ? rateLimit(rateLimitOptions({
      ...readLimitConfig,
      message: 'Too many chart requests. Please wait and retry.'
    }))
    : (_req, _res, next) => next();


  // Apply to Express
  app.use(cors(corsOptions));
  app.use(express.json());

  // --- ROUTES ---
  app.use('/api/auth', createAuthRouter(authOptions));
  app.use('/api/trade', createTradeRouter({ feed, runtimeStatus, market, ...tradeOptions }));
  app.use('/api/copilot', createCopilotRouter({ feed, ...copilot, runtimeStatus, market }));
  app.use('/api/market', createMarketRouter({
    market,
    rateLimit: readLimitConfig
  }));

  // Liveness never depends on downstream components: it only proves the HTTP
  // process is alive. Readiness reports safe component codes and is served
  // from the in-memory status; it never mutates indexes or data.
  app.get('/health/live', (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.get('/health/ready', (req, res) => {
    if (!runtimeStatus || typeof runtimeStatus.readiness !== 'function') {
      return res.status(503).json({
        status: 'not_ready',
        codes: ['STARTUP_INCOMPLETE'],
        components: {
          startup: false,
          mongo: false,
          transactions: false,
          indexes: false,
          legacyGate: false,
          matcher: false
        }
      });
    }

    const report = runtimeStatus.readiness();
    return res.status(report.ok ? 200 : 503).json({
      status: report.status,
      codes: report.codes,
      components: report.components,
      matcher: report.matcher,
      matcherCode: report.matcherCode,
      checkedAt: report.checkedAt
    });
  });

  // Candles are only served for symbols the catalogue currently trades and for
  // a fixed interval allowlist, so the endpoint cannot proxy arbitrary Binance
  // paths. The limiter bounds per-IP request volume; the response advertises
  // exactly the lifetime of the fetcher's own short-lived cache.
  app.get('/api/history/:symbol', historyLimiter, async (req, res) => {
    const symbolCheck = validateSymbolFormat(req.params.symbol);
    if (!symbolCheck.ok || !symbolUniverse.isActive(symbolCheck.value)) {
      return res.status(400).json({ error: 'Unsupported symbol.' });
    }

    const requested = req.query.interval;
    const interval = requested === undefined ? '1m' : normalizeChartInterval(requested);
    if (!interval) {
      return res.status(400).json({ error: 'Unsupported interval.' });
    }

    try {
      const raw = await historyFetcher.fetchKlines({ symbol: symbolCheck.value, interval });
      const ttlSeconds = Math.max(0, Math.floor(
        (Number.isFinite(historyFetcher.ttlMs) ? historyFetcher.ttlMs : 0) / 1000
      ));
      if (ttlSeconds > 0) {
        res.set(
          'Cache-Control',
          `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`
        );
      }
      const formattedData = raw.map(d => ({
        time: Math.floor(d[0] / 1000),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
        volume: Number.isFinite(parseFloat(d[5])) ? parseFloat(d[5]) : null,
      }));

      res.json(formattedData);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch history" });
    }
  });

  app.get('/', (req, res) => res.send('API LIVE'));

  return app;
}

const app = createApp();

module.exports = { app, createApp, corsOptions };
