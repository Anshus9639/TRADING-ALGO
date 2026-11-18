const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { marketFeed } = require('./services/marketFeed');
const { createTradeRouter } = require('./routes/trade');
const { createCopilotRouter } = require('./routes/copilot');
const { createAuthRouter } = require('./routes/auth');
const { loadAppConfig } = require('./config/env');

// App-only configuration: does not require database or JWT secrets, so isolated
// tests can import this factory without a full environment.
const { corsOrigins, trustProxy } = loadAppConfig();

// An external history request must never hold a Node request handler open
// indefinitely; Binance can accept a connection and then stall.
const HISTORY_FETCH_TIMEOUT_MS = 10000;

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
  trade: tradeOptions = {}
} = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);

  // Apply to Express
  app.use(cors(corsOptions));
  app.use(express.json());

  // --- ROUTES ---
  app.use('/api/auth', createAuthRouter(authOptions));
  app.use('/api/trade', createTradeRouter({ feed, runtimeStatus, ...tradeOptions }));
  app.use('/api/copilot', createCopilotRouter({ feed, ...copilot, runtimeStatus }));

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

  // 3. FIXED HISTORY (The "Pattern" Fix)
  app.get('/api/history/:symbol', async (req, res) => {
    try {
      const { symbol } = req.params;
      // 🚀 Look for the interval in the URL query, default to 1m
      const interval = req.query.interval || '1m';

      const response = await axios.get(
        `https://api.binance.us/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=500`,
        { timeout: HISTORY_FETCH_TIMEOUT_MS }
      );

      const formattedData = response.data.map(d => ({
        time: Math.floor(d[0] / 1000),
        open: parseFloat(d[1]),
        high: parseFloat(d[2]),
        low: parseFloat(d[3]),
        close: parseFloat(d[4]),
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
