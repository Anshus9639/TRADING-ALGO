const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');

const { loadConfig } = require('./config/env');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`❌ Configuration error: ${err.message}`);
  process.exit(1);
}

const { createApp, corsOptions } = require('./app');
const { marketFeed, setQuote } = require('./services/marketFeed');
const { createMatcher } = require('./services/matcher');
const { createTradeService } = require('./services/tradeService');
const { findLegacyOrderBlockers } = require('./services/legacyOrders');
const { createRuntimeStatus } = require('./services/runtimeStatus');
const { checkDatabaseIndexes } = require('./scripts/check-idempotency-index');
const { defaultTransactionSupport } = require('./lib/transactions');
const User = require('./models/User');
const Order = require('./models/Order');

const runtimeStatus = createRuntimeStatus();
const app = createApp({ runtimeStatus });

const server = http.createServer(app);

// Apply to Socket.io
const io = new Server(server, { 
  cors: corsOptions 
});

// --- DATABASE ---
// Trading requires multi-document transactions, which need a replica set.
// Readiness and LIMIT placement are gated on every prerequisite below; none of
// these checks create or modify indexes.
mongoose.connection.on('connected', () => runtimeStatus.setMongoConnected(true));
mongoose.connection.on('disconnected', () => {
  console.error('⚠️ MongoDB disconnected; trading readiness is now false.');
  runtimeStatus.setMongoConnected(false);
});
mongoose.connection.on('error', (err) => {
  console.error('❌ MongoDB connection error:', err.message);
  runtimeStatus.setMongoConnected(false);
});

mongoose.connect(config.mongoUri)
  .then(async () => {
    runtimeStatus.setMongoConnected(true);
    console.log('✅ MongoDB Connected');

    try {
      const supported = await defaultTransactionSupport.isSupported();
      runtimeStatus.setTransactionsVerified(supported);
      if (!supported) {
        console.error('❌ MongoDB transactions are unavailable (standalone deployment). Trading endpoints will refuse orders until a replica set is configured.');
        runtimeStatus.markMatcherBlocked('TRANSACTIONS_UNAVAILABLE');
        runtimeStatus.setStartupComplete(true);
        return;
      }
      console.log('✅ MongoDB transaction support verified');

      // Read-only index verification. A missing or malformed index makes the
      // process not ready; the operator must fix it with an approved migration.
      const indexReport = await checkDatabaseIndexes({ db: mongoose.connection.db });
      runtimeStatus.setIndexesVerified(indexReport.ok);
      if (!indexReport.ok) {
        console.error(`❌ Required index preflight failed: ${indexReport.failedChecks.join(', ')}`);
        runtimeStatus.markMatcherBlocked('INDEXES_UNVERIFIED');
        runtimeStatus.setStartupComplete(true);
        return;
      }
      console.log('✅ Required indexes verified');

      // Deployment policy: the canonical matcher only executes canonical
      // orders. Embedded legacy orders remain cancellable with their original
      // refund semantics but can never fill, so the matcher stays disabled
      // while any unmigrated, malformed, or duplicate-id order exists.
      const blockers = await findLegacyOrderBlockers({ User, Order });
      const gateClear = blockers.length === 0;
      runtimeStatus.setLegacyGateClear(gateClear);
      if (!gateClear) {
        const orderCount = blockers.reduce((sum, entry) => sum + entry.count, 0);
        const accountLabel = blockers.length >= 100 ? '100+' : String(blockers.length);
        const duplicateAccounts = blockers.filter(entry => entry.reasons.includes('DUPLICATE_ORDER_ID')).length;
        const missingIdAccounts = blockers.filter(entry => entry.reasons.includes('MISSING_ORDER_ID')).length;
        console.error(`❌ Matcher not started: ${orderCount} embedded pending order(s) across ${accountLabel} account(s) are not safely migratable.`);
        console.error(`   duplicate-id accounts=${duplicateAccounts} missing-id accounts=${missingIdAccounts}`);
        console.error('   Legacy orders remain cancellable and refundable, but they cannot fill.');
        console.error('   Run scripts/migrate-embedded-to-collections.js (dry run, then approved apply), resolve reported ambiguity, and restart.');
        runtimeStatus.markMatcherBlocked('LEGACY_GATE_BLOCKED');
        runtimeStatus.setStartupComplete(true);
        return;
      }
      console.log('✅ Legacy order gate is clear');

      const tradeService = createTradeService({ feed: marketFeed, runtimeStatus });
      const matcher = createMatcher({
        feed: marketFeed,
        tradeService
      });

      setInterval(async () => {
        try {
          const stats = await matcher.runCycle();
          // A successful cycle clears a previous FAILED state; a failure below
          // immediately clears ACTIVE so readiness cannot remain stale.
          runtimeStatus.markMatcherActive();
          if (!stats.skipped && (stats.filled > 0 || stats.failed > 0 || stats.recovered > 0)) {
            console.log('⚡ Matcher cycle:', JSON.stringify(stats));
          }
        } catch (err) {
          runtimeStatus.markMatcherFailed('MATCHER_CYCLE_FAILED', err.message);
          console.error('⚠️ Order Engine Error:', err.message);
        }
      }, 3000);

      runtimeStatus.markMatcherActive();
      runtimeStatus.setStartupComplete(true);
      console.log('✅ Matching engine started');
    } catch (err) {
      console.error('❌ Startup readiness checks failed:', err.message);
      runtimeStatus.markMatcherFailed('STARTUP_CHECK_FAILED', err.message);
      runtimeStatus.setStartupComplete(true);
    }
  })
  .catch(err => {
    console.error('❌ DB Error:', err.message);
    runtimeStatus.setMongoConnected(false);
    runtimeStatus.markMatcherFailed('MONGO_CONNECT_FAILED', err.message);
    runtimeStatus.setStartupComplete(true);
  });

// --- BINANCE WS BRIDGE (SELF-HEALING) ---
const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];
let binanceConn;

const connectBinance = () => {
  const streams = [
    ...SYMBOLS.map(s => `${s.toLowerCase()}@ticker`),
    ...SYMBOLS.map(s => `${s.toLowerCase()}@kline_1m`),
    ...SYMBOLS.map(s => `${s.toLowerCase()}@depth5`)
  ].join('/');

  binanceConn = new WebSocket(`wss://stream.binance.us:9443/stream?streams=${streams}`);

  binanceConn.on('message', (data) => {
    try {
      const rawData = JSON.parse(data);
      const msg = rawData.data || rawData;

      if (msg.e === '24hrTicker') {
        const currentPrice = parseFloat(msg.c);
        if (setQuote(msg.s, currentPrice)) {
          io.emit('marketUpdate', { symbol: msg.s, price: currentPrice.toFixed(2), change: msg.P });
        }
      } 
      else if (msg.e === 'kline') {
        io.emit('candleUpdate', { 
          symbol: msg.s, 
          time: Math.floor(msg.k.t / 1000), 
          open: parseFloat(msg.k.o), 
          high: parseFloat(msg.k.h), 
          low: parseFloat(msg.k.l), 
          close: parseFloat(msg.k.c) 
        });
      }
      else if (msg.b || msg.bids) {
        const streamName = rawData.stream || "";
        const symbol = (msg.s || streamName.split('@')[0] || 'BTCUSDT').toUpperCase();
        
        io.emit('depthUpdate', { symbol, bids: (msg.b || msg.bids).slice(0, 8), asks: (msg.a || msg.asks).slice(0, 8) });
      }
    } catch (e) {}
  });

  binanceConn.on('error', (err) => console.error("WS Error:", err.message));
  binanceConn.on('close', () => {
    console.log("🔌 Reconnecting to Binance...");
    setTimeout(connectBinance, 5000);
  });
};
connectBinance();

// --- ROUTES ---
// Mounted in ./app.js (the Express app is imported above).

server.listen(config.port, () => console.log(`🚀 Running on ${config.port}`));