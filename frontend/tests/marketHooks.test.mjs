import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function readSource(...segments) {
  return fs.readFileSync(path.join(here, '..', 'src', ...segments), 'utf8');
}

test('catalogue hook polls the server, aborts stale requests, and keeps a priced-free fallback', () => {
  const source = readSource('hooks', 'useMarketCatalogue.js');

  assert.ok(source.includes("'/api/market/symbols'"), 'catalogue must come from the API');
  assert.ok(source.includes('fallbackMarkets'), 'a failed catalogue must fall back to pinned symbols');
  assert.match(source, /CATALOGUE_POLL_MS\s*=\s*60000/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\.signal\.aborted/);
  assert.match(source, /ERR_CANCELED/);
  assert.match(source, /setInterval\(load, CATALOGUE_POLL_MS\)/);
  assert.match(source, /clearInterval\(timer\)/);
  assert.match(source, /markets: prev\.markets\.length > 0 \? prev\.markets : fallbackMarkets\(\)/);
  assert.match(source, /stale: true/);
});

test('watchlist hook is token-scoped, optimistic, and rolls back rejected writes', () => {
  const source = readSource('hooks', 'useWatchlist.js');

  assert.ok(source.includes("'/api/auth/watchlist'"), 'watchlist must persist server-side');
  assert.match(source, /api\.put\(/);
  assert.match(source, /authHeaders\(sessionToken\)/);
  assert.match(source, /if \(busyRef\.current\) return;/);
  assert.match(source, /tokenRef\.current !== sessionToken/);
  assert.match(source, /toggleWatchlist\(previous, symbol, MAX_WATCHLIST_SYMBOLS\)/);
  assert.match(source, /watchlistRef\.current = previous;\s*\n\s*setWatchlist\(previous\);/);
  assert.match(source, /LIMIT_REACHED/);
});

test('market stream owns one socket, re-focuses on symbol/interval, and guards every payload', () => {
  const source = readSource('hooks', 'useMarketStream.js');

  assert.equal((source.match(/io\(API_ORIGIN\)/g) || []).length, 1, 'one socket per hook instance');
  assert.match(source, /socket\.emit\('market:focus', \{ symbol: currentSymbol, interval: currentInterval \}\)/);
  assert.match(source, /socket\.on\('connect', handleConnect\)/);
  assert.match(source, /socket\.on\('marketStatus', handleMarketStatus\)/);
  assert.match(source, /socket\.on\('marketUpdate', handleMarketUpdate\)/);
  assert.match(source, /socket\.on\('candleUpdate', handleCandleUpdate\)/);
  assert.match(source, /socket\.on\('depthUpdate', handleDepthUpdate\)/);

  assert.match(source, /payload\.symbol !== symbolRef\.current \|\| payload\.interval !== intervalRef\.current/);
  assert.match(source, /payload\.symbol !== symbolRef\.current/);

  assert.match(source, /setTimeout\(flushQuotes, QUOTE_FLUSH_MS\)/, 'ticks must be coalesced');
  assert.match(source, /setCandle\(null\);\s*\n\s*setDepth\(null\);/);
  assert.match(source, /\}, \[enabled\]\);/);
  assert.match(source, /\}, \[symbol, interval\]\);/);

  assert.match(source, /socket\.removeAllListeners\(\);\s*\n\s*socket\.disconnect\(\);/);
});

test('App composes the workstation from hooks and never creates its own socket', () => {
  const source = readSource('App.jsx');

  assert.ok(!source.includes("from 'socket.io-client'"), 'App must not own a socket connection');
  assert.match(source, /useMarketCatalogue from '\.\/hooks\/useMarketCatalogue'/);
  assert.match(source, /useMarketStream from '\.\/hooks\/useMarketStream'/);
  assert.match(source, /useWatchlist from '\.\/hooks\/useWatchlist'/);

  for (const component of [
    'NavRail',
    'TopBar',
    'TickerStrip',
    'BottomNav',
    'MarketNavigator',
    'MarketsTable',
    'TradeDock',
    'PortfolioPanel',
    'SettingsPanel',
    'ProfilePanel'
  ]) {
    assert.ok(source.includes(`'./components/${component}'`), `missing ${component}`);
  }

  assert.ok(!source.includes('Math.random()'), 'no random React keys');
  assert.ok(!source.includes('http://') && !source.includes('https://'), 'no hardcoded backend URL');
  assert.match(source, /encodeURIComponent\(activeSymbol\)/);
  assert.match(source, /encodeURIComponent\(chartInterval\)/);
  assert.match(source, /new AbortController\(\)/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /ERR_CANCELED/);

  assert.match(source, /!markets\.some\(market => market\.symbol === activeSymbol\)/);
  assert.match(source, /CHART_INTERVALS\.map/);
  assert.ok(source.includes("const CHART_INDICATORS = ['SMA', 'EMA', 'NONE']"));

  for (const view of ['terminal', 'markets', 'portfolio', 'activity', 'copilot', 'settings', 'profile']) {
    assert.ok(source.includes(`'${view}'`), `missing ${view} view`);
  }

  assert.match(source, /role="dialog" aria-modal="true"/);
});

test('chart uses ResizeObserver, cleans up, and never invents OHLCV', () => {
  const source = readSource('components', 'CandleChart.jsx');

  assert.match(source, /new ResizeObserver\(resize\)/);
  assert.match(source, /observer\.disconnect\(\)/);
  assert.match(source, /chart\.remove\(\)/);
  assert.match(source, /requestFullscreen/);
  assert.match(source, /addHistogramSeries/);
  assert.match(source, /calculateEma/);
  assert.match(source, /calculateSma/);
  assert.match(source, /normalizeCandles\(initialData\)/);
  assert.match(source, /mergeCandle\(dataRef\.current, candle\)/);
  assert.ok(source.includes('interval ='));
  assert.ok(source.includes('symbol ='));
});

test('QuickOrder keeps its idempotency and session protections after the restyle', () => {
  const source = readSource('components', 'QuickOrder.jsx');

  assert.ok(source.includes("'/api/trade/buy'"));
  assert.ok(source.includes("'/api/trade/sell'"));
  assert.ok(source.includes("'/api/trade/limit'"));
  assert.match(source, /payload\.clientOrderId = clientOrderId;/);
  assert.match(source, /api\.post\(endpoint, payload, authHeaders\(sessionToken\)\)/);
  assert.match(source, /shouldRetirePendingKey\(status, code\)/);
  assert.match(source, /submissions\.deleteIf\(requestKey, clientOrderId\)/);
  assert.match(source, /mountedRef\.current && tokenRef\.current === sessionToken/);
});
