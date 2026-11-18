const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');

const { loadConfig } = require('./config/env');

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(`❌ Configuration error: ${err.message}`);
  process.exit(1);
}

const { createApp, corsOptions } = require('./app');
const { marketFeed } = require('./services/marketFeed');
const { createMarketCatalogue } = require('./services/marketCatalogue');
const { createMarketStream } = require('./services/marketStream');
const { symbolUniverse } = require('./services/symbolUniverse');
const { createMatcher } = require('./services/matcher');
const { createTradeService } = require('./services/tradeService');
const { findLegacyOrderBlockers } = require('./services/legacyOrders');
const { createRuntimeStatus } = require('./services/runtimeStatus');
const { checkDatabaseIndexes } = require('./scripts/check-idempotency-index');
const { defaultTransactionSupport } = require('./lib/transactions');
const { applySafeMongooseDefaults } = require('./lib/mongooseSetup');
const User = require('./models/User');
const Order = require('./models/Order');

const runtimeStatus = createRuntimeStatus();
let matcherTimer = null;
// Filled with the catalogue instance below; the route resolves it per request.
const marketContext = { catalogue: null };
const app = createApp({ runtimeStatus, market: marketContext });

const server = http.createServer(app);

// Apply to Socket.io
const io = new Server(server, { 
  cors: corsOptions 
});

// --- MARKET DATA ---
// The catalogue decides which pairs are tradeable; the stream carries tickers
// for that whole set plus candle/depth for whatever clients are viewing.
const marketCatalogue = createMarketCatalogue({
  universe: symbolUniverse,
  ttlMs: config.market.cacheTtlMs,
  timeoutMs: config.market.fetchTimeoutMs,
  limit: config.market.universeSize,
  onUpdate: applyCatalogue
});

const marketStream = createMarketStream({
  io,
  feed: marketFeed,
  symbols: symbolUniverse.listActive()
});
marketContext.catalogue = marketCatalogue;

function applyCatalogue(next) {
  const symbols = next.symbols.map(market => market.symbol);
  marketFeed.setSymbols(symbols);
  marketStream.setSymbols(symbols);
}

io.on('connection', socket => {
  let focus = null;

  socket.on('market:focus', payload => {
    const result = marketStream.acquireFocus(payload || {});
    if (!result.ok) {
      socket.emit('marketStatus', { status: 'focus_rejected', code: result.code });
      return;
    }
    if (focus) marketStream.releaseFocus(focus);
    focus = { symbol: result.symbol, interval: result.interval };
    socket.emit('marketStatus', {
      status: 'focused',
      symbol: result.symbol,
      interval: result.interval
    });
  });

  socket.on('disconnect', () => {
    if (focus) marketStream.releaseFocus(focus);
    focus = null;
  });
});

marketCatalogue.start({ intervalMs: config.market.cacheTtlMs });
marketStream.start();

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

applySafeMongooseDefaults(mongoose);

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

      matcherTimer = setInterval(async () => {
        try {
          const stats = await matcher.runCycle();
          // A skipped cycle proves nothing about recovery: the previous cycle
          // may still be running or the matcher may still be FAILED. Only a
          // completed, non-skipped cycle may restore ACTIVE readiness.
          if (!stats.skipped) {
            runtimeStatus.markMatcherActive();
            if (stats.filled > 0 || stats.failed > 0 || stats.recovered > 0) {
              console.log('⚡ Matcher cycle:', JSON.stringify(stats));
            }
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

// --- ROUTES ---
// Mounted in ./app.js (the Express app is imported above).

server.listen(config.port, () => console.log(`🚀 Running on ${config.port}`));

// Graceful shutdown: hosts signal intent before replacing an instance. Stop
// scheduling work, release the exchange socket and catalogue timer, then close
// the database handle. A force timer bounds a stuck connection drain.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`⚠️ Received ${signal}; shutting down.`);

  if (matcherTimer) clearInterval(matcherTimer);
  matcherTimer = null;
  marketCatalogue.stop();
  marketStream.stop();

  const forceExit = setTimeout(() => process.exit(1), 10000);
  if (typeof forceExit.unref === 'function') forceExit.unref();

  io.close(() => {
    mongoose.connection.close(false)
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));