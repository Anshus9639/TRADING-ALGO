import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHART_INTERVALS,
  MAX_WATCHLIST_SYMBOLS,
  PINNED_SYMBOLS,
  fallbackMarkets,
  filterMarkets,
  formatPercent,
  formatPrice,
  formatUsd,
  formatVolume,
  marketTradingBlocked,
  mergeWatchlistMarkets,
  normalizeSymbol,
  normalizeSymbolList,
  resolveQuote,
  toggleWatchlist
} from '../src/lib/marketFormat.mjs';

test('symbol normalization follows the backend format', () => {
  assert.equal(normalizeSymbol(' btcusdt '), 'BTCUSDT');
  assert.equal(normalizeSymbol('eth/usdt'), null);
  assert.equal(normalizeSymbol('BTC'), null);
  assert.equal(normalizeSymbol('BTCUSDT<script>'), null);
  assert.equal(normalizeSymbol(null), null);
  assert.equal(normalizeSymbol(12345), null);
});

test('symbol lists are normalized, deduplicated, and bounded', () => {
  assert.deepEqual(normalizeSymbolList(['btcusdt', 'BTCUSDT', ' ethusdt ', 'bad/symbol']), ['BTCUSDT', 'ETHUSDT']);
  assert.deepEqual(normalizeSymbolList('BTCUSDT'), []);
  const many = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 5 }, (_, index) => `COIN${String(index).padStart(3, '0')}USDT`);
  assert.equal(normalizeSymbolList(many).length, MAX_WATCHLIST_SYMBOLS);
});

test('watchlist toggles add, remove, and reject over the limit', () => {
  assert.deepEqual(toggleWatchlist(['BTCUSDT'], 'ETHUSDT'), { symbols: ['BTCUSDT', 'ETHUSDT'], rejected: null });
  assert.deepEqual(toggleWatchlist(['BTCUSDT', 'ETHUSDT'], 'btcusdt'), { symbols: ['ETHUSDT'], rejected: null });
  assert.deepEqual(toggleWatchlist([], 'NOT A SYMBOL'), { symbols: [], rejected: 'INVALID_SYMBOL' });

  const full = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => `COIN${String(index).padStart(3, '0')}USDT`);
  assert.deepEqual(toggleWatchlist(full, 'BTCUSDT'), { symbols: full, rejected: 'LIMIT_REACHED' });
});

test('quotes prefer the live stream and mark catalogue snapshots as stale', () => {
  const market = { symbol: 'BTCUSDT', lastPrice: 60_000, priceChangePercent: 1.5, quoteVolume: 1e9 };
  const live = resolveQuote(market, { BTCUSDT: { price: 61_000, changePercent: 2, quoteVolume: 2e9 } });
  assert.deepEqual(live, { price: 61_000, changePercent: 2, quoteVolume: 2e9, live: true });

  const snapshot = resolveQuote(market, {});
  assert.deepEqual(snapshot, { price: 60_000, changePercent: 1.5, quoteVolume: 1e9, live: false });

  // A malformed live tick must not hide a valid snapshot or invent a price.
  const invalid = resolveQuote(market, { BTCUSDT: { price: Number.NaN, changePercent: 0 } });
  assert.equal(invalid.live, false);

  assert.equal(resolveQuote({ symbol: 'ETHUSDT', lastPrice: null }, {}), null);
  assert.equal(resolveQuote(null, { ETHUSDT: { price: 3000 } }), null);
});

test('catalogue fallback contains only pinned symbols and no prices', () => {
  const markets = fallbackMarkets();
  assert.deepEqual(markets.map(market => market.symbol), [...PINNED_SYMBOLS]);
  for (const market of markets) {
    assert.equal(market.lastPrice, null);
    assert.equal(market.priceChangePercent, null);
    assert.equal(market.quoteVolume, null);
    assert.equal(market.status, 'UNKNOWN');
  }
});

test('formatters render honest placeholders instead of fabricated numbers', () => {
  assert.equal(formatPrice(null), '—');
  assert.equal(formatPrice(Number.NaN), '—');
  assert.equal(formatPrice(0), '—');
  assert.equal(formatPrice(60_000), '60,000.00');
  assert.equal(formatPrice(0.1289), '0.1289');
  assert.equal(formatPrice(0.00000123), '0.00000123');

  assert.equal(formatPercent(null), '—');
  assert.equal(formatPercent(1.234), '+1.23%');
  assert.equal(formatPercent(-2.5), '-2.50%');

  assert.equal(formatVolume(null), '—');
  assert.equal(formatVolume(2_500_000_000), '2.50B');
  assert.equal(formatVolume(1_500_000), '1.50M');
  assert.equal(formatVolume(2_500), '2.50K');

  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(1234.5), '$1,234.50');
});

test('market filtering matches symbol and base asset', () => {
  const markets = [
    { symbol: 'BTCUSDT', baseAsset: 'BTC' },
    { symbol: 'ETHUSDT', baseAsset: 'ETH' },
    { symbol: 'SOLUSDT', baseAsset: 'SOL' }
  ];
  assert.equal(filterMarkets(markets, '').length, 3);
  assert.deepEqual(filterMarkets(markets, 'eth').map(market => market.symbol), ['ETHUSDT']);
  assert.deepEqual(filterMarkets(markets, 'usdt').map(market => market.symbol), ['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
  assert.deepEqual(filterMarkets(null, 'btc'), []);
});

test('watchlist merge keeps stored order and drops delisted pairs', () => {
  const markets = [
    { symbol: 'BTCUSDT' },
    { symbol: 'ETHUSDT' },
    { symbol: 'SOLUSDT' }
  ];
  assert.deepEqual(
    mergeWatchlistMarkets(markets, ['SOLUSDT', 'DOGEUSDT', 'BTCUSDT']).map(market => market.symbol),
    ['SOLUSDT', 'BTCUSDT']
  );
});

test('chart intervals match the backend allowlist', () => {
  assert.deepEqual([...CHART_INTERVALS], ['1m', '5m', '15m', '1h', '4h', '1d']);
});

test('trading is blocked until a pair publishes complete exchange rules', () => {
  const rules = { tickSize: 0.01, stepSize: 0.00001, minQty: 0.00001, minNotional: 10 };
  assert.equal(marketTradingBlocked(rules), false);
  assert.equal(marketTradingBlocked({ symbol: 'BTCUSDT', ...rules }), false);

  assert.equal(marketTradingBlocked({ ...rules, minNotional: null }), true);
  assert.equal(marketTradingBlocked({ ...rules, stepSize: 0 }), true);
  assert.equal(marketTradingBlocked({ ...rules, tickSize: Number.NaN }), true);
  // Fallback entries are price-less and rule-less, so they never enable trading.
  assert.equal(marketTradingBlocked(fallbackMarkets()[0]), true);
  assert.equal(marketTradingBlocked(null), true);
});
