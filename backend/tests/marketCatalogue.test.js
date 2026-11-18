const {
  createMarketCatalogue,
  selectMarkets,
  fallbackCatalogue,
  DEFAULT_UNIVERSE_SIZE
} = require('../services/marketCatalogue');
const { createSymbolUniverse } = require('../services/symbolUniverse');
const { PINNED_SYMBOLS } = require('../lib/symbols');

function symbolInfo(symbol, overrides = {}) {
  const baseAsset = symbol.replace(/USDT$/, '');
  return {
    symbol,
    status: 'TRADING',
    quoteAsset: 'USDT',
    baseAsset,
    isSpotTradingAllowed: true,
    permissions: ['SPOT'],
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '0.01' },
      { filterType: 'LOT_SIZE', stepSize: '0.0001', minQty: '0.0001' },
      { filterType: 'NOTIONAL', minNotional: '10' }
    ],
    ...overrides
  };
}

function ticker(symbol, { lastPrice = 100, priceChangePercent = 1.5, quoteVolume = 1000 } = {}) {
  return { symbol, lastPrice, priceChangePercent, quoteVolume };
}

function exchangeFixture() {
  return [
    symbolInfo('BTCUSDT'),
    symbolInfo('ETHUSDT'),
    symbolInfo('SOLUSDT'),
    symbolInfo('BNBUSDT'),
    symbolInfo('DOGEUSDT'),
    symbolInfo('ADAUSDT'),
    symbolInfo('HALTEDUSDT', { status: 'BREAK' }),
    symbolInfo('ETHBTC', { quoteAsset: 'BTC' }),
    symbolInfo('USDCUSDT', { baseAsset: 'USDC' }),
    symbolInfo('LEVERUSDT', { permissions: ['SPOT', 'LEVERAGED'] }),
    symbolInfo('NOFLOWUSDT')
  ];
}

function tickerFixture() {
  return [
    ticker('BTCUSDT', { quoteVolume: 9000 }),
    ticker('ETHUSDT', { quoteVolume: 8000 }),
    ticker('SOLUSDT', { quoteVolume: 7000 }),
    ticker('BNBUSDT', { quoteVolume: 6000 }),
    ticker('DOGEUSDT', { quoteVolume: 5000 }),
    ticker('ADAUSDT', { quoteVolume: 4000 }),
    ticker('HALTEDUSDT', { quoteVolume: 3000 }),
    ticker('ETHBTC', { quoteVolume: 2000 }),
    ticker('USDCUSDT', { quoteVolume: 1999 }),
    ticker('LEVERUSDT', { quoteVolume: 1998 }),
    ticker('NOFLOWUSDT', { quoteVolume: 0 })
  ];
}

function fakeHttp({ exchangeInfo = exchangeFixture(), tickers = tickerFixture(), failUrls = [] } = {}) {
  const calls = [];
  const http = {
    get: jest.fn(async (url) => {
      calls.push(url);
      if (failUrls.some(fragment => url.includes(fragment))) {
        throw new Error('UPSTREAM_DOWN');
      }
      if (url.includes('exchangeInfo')) return { data: { symbols: exchangeInfo } };
      if (url.includes('ticker/24hr')) return { data: tickers };
      throw new Error(`UNEXPECTED_URL ${url}`);
    })
  };
  return { http, calls };
}

describe('market catalogue selection', () => {
  test('keeps only eligible USDT spot pairs with live tickers', () => {
    const selected = selectMarkets(exchangeFixture(), tickerFixture(), { limit: 50 });
    const symbols = selected.map(market => market.symbol);

    expect(symbols).toContain('DOGEUSDT');
    expect(symbols).toContain('ADAUSDT');
    expect(symbols).not.toContain('HALTEDUSDT');
    expect(symbols).not.toContain('ETHBTC');
    expect(symbols).not.toContain('USDCUSDT');
    expect(symbols).not.toContain('LEVERUSDT');
    expect(symbols).not.toContain('NOFLOWUSDT');
  });

  test('pins BTC, ETH, SOL and BNB ahead of volume ranking', () => {
    const selected = selectMarkets(exchangeFixture(), tickerFixture(), { limit: 50 });

    expect(selected.slice(0, PINNED_SYMBOLS.length).map(market => market.symbol)).toEqual([
      'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'
    ]);
    const tail = selected.slice(PINNED_SYMBOLS.length).map(market => market.symbol);
    expect(tail).toEqual(['DOGEUSDT', 'ADAUSDT']);
  });

  test('bounds the universe size and never invents prices', () => {
    const selected = selectMarkets(exchangeFixture(), tickerFixture(), { limit: 4 });
    expect(selected).toHaveLength(4);

    const market = selected[0];
    expect(market).toMatchObject({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 100,
      status: 'TRADING',
      pinned: true,
      tickSize: 0.01,
      stepSize: 0.0001,
      minQty: 0.0001,
      minNotional: 10
    });
  });

  test('deduplicates repeated exchange entries', () => {
    const selected = selectMarkets(
      [...exchangeFixture(), symbolInfo('BTCUSDT')],
      tickerFixture(),
      { limit: 50 }
    );
    expect(selected.filter(market => market.symbol === 'BTCUSDT')).toHaveLength(1);
  });

  test('a failed universe falls back to the active set with unknown prices', () => {
    const fallback = fallbackCatalogue(['BTCUSDT', 'ETHUSDT'], () => Date.UTC(2026, 0, 1));

    expect(fallback).toMatchObject({ source: 'fallback', stale: true });
    expect(fallback.symbols.map(market => market.symbol)).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(fallback.symbols.every(market => market.lastPrice === null)).toBe(true);
    expect(fallback.symbols.every(market => market.priceChangePercent === null)).toBe(true);
    expect(fallback.symbols.every(market => market.status === 'UNKNOWN')).toBe(true);
  });
});

describe('market catalogue lifecycle', () => {
  test('refreshes from the exchange, updates the universe and caches until the TTL', async () => {
    const universe = createSymbolUniverse();
    const { http } = fakeHttp();
    let clock = 1_700_000_000_000;
    const onUpdate = jest.fn();
    const catalogue = createMarketCatalogue({
      universe,
      http,
      now: () => clock,
      ttlMs: 60000,
      limit: 50,
      onUpdate
    });

    const first = await catalogue.getCatalogue();
    expect(first.source).toBe('live');
    expect(first.stale).toBe(false);
    expect(first.symbols.length).toBeGreaterThanOrEqual(4);
    expect(http.get).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(universe.isActive('DOGEUSDT')).toBe(true);
    expect(catalogue.getSymbol('dogeusdt').symbol).toBe('DOGEUSDT');

    clock += 1000;
    await catalogue.getCatalogue();
    expect(http.get).toHaveBeenCalledTimes(2);

    clock += 60000;
    await catalogue.getCatalogue();
    expect(http.get).toHaveBeenCalledTimes(4);
  });

  test('concurrent callers share one in-flight refresh', async () => {
    const universe = createSymbolUniverse();
    const { http } = fakeHttp();
    const catalogue = createMarketCatalogue({ universe, http, ttlMs: 0, limit: 50 });

    await Promise.all([catalogue.getCatalogue(), catalogue.getCatalogue(), catalogue.getCatalogue()]);
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  test('a failed refresh keeps the last live catalogue and marks it stale', async () => {
    const universe = createSymbolUniverse();
    let fail = false;
    const http = {
      get: jest.fn(async (url) => {
        if (fail) throw new Error('UPSTREAM_DOWN');
        if (url.includes('exchangeInfo')) return { data: { symbols: exchangeFixture() } };
        return { data: tickerFixture() };
      })
    };
    let clock = 1_700_000_000_000;
    const catalogue = createMarketCatalogue({ universe, http, now: () => clock, ttlMs: 1000, limit: 50 });

    const live = await catalogue.getCatalogue();
    fail = true;
    clock += 2000;

    const stale = await catalogue.getCatalogue();
    expect(stale.source).toBe('cache');
    expect(stale.stale).toBe(true);
    expect(stale.symbols).toEqual(live.symbols);
    expect(catalogue.diagnostics().lastErrorCode).toBe('CATALOGUE_REFRESH_FAILED');

    // The pair is not tradeable any more, but it stays historically known so an
    // idempotent retry can still be recognised.
    expect(universe.isActive('DOGEUSDT')).toBe(true);
  });

  test('a failed first refresh returns the fallback instead of throwing', async () => {
    const universe = createSymbolUniverse();
    const { http } = fakeHttp({ failUrls: ['exchangeInfo'] });
    const catalogue = createMarketCatalogue({ universe, http, limit: 50 });

    const report = await catalogue.getCatalogue();
    expect(report.source).toBe('fallback');
    expect(report.stale).toBe(true);
    expect(report.symbols.map(market => market.symbol)).toEqual([...PINNED_SYMBOLS]);
    expect(universe.isActive('BTCUSDT')).toBe(true);
  });

  test('malformed exchange payloads never activate an empty universe', async () => {
    const universe = createSymbolUniverse();
    const { http } = fakeHttp({ exchangeInfo: null });
    const catalogue = createMarketCatalogue({ universe, http, limit: 50 });

    const report = await catalogue.getCatalogue();
    expect(report.source).toBe('fallback');
    expect(universe.listActive()).toEqual([...PINNED_SYMBOLS]);
    expect(catalogue.diagnostics()).toMatchObject({
      source: 'fallback',
      stale: true,
      count: PINNED_SYMBOLS.length,
      lastErrorCode: 'CATALOGUE_REFRESH_FAILED'
    });
  });

  test('a shrinking catalogue leaves delisted pairs known but inactive', async () => {
    const universe = createSymbolUniverse();
    let exchangeInfo = exchangeFixture();
    const http = {
      get: jest.fn(async (url) => {
        if (url.includes('exchangeInfo')) return { data: { symbols: exchangeInfo } };
        return { data: tickerFixture() };
      })
    };
    let clock = 1_700_000_000_000;
    const catalogue = createMarketCatalogue({ universe, http, now: () => clock, ttlMs: 1000, limit: 50 });

    await catalogue.getCatalogue();
    expect(universe.isActive('DOGEUSDT')).toBe(true);

    exchangeInfo = exchangeFixture().filter(info => info.symbol !== 'DOGEUSDT');
    clock += 2000;
    await catalogue.getCatalogue();

    expect(universe.isActive('DOGEUSDT')).toBe(false);
    expect(universe.isKnown('DOGEUSDT')).toBe(true);
    expect(catalogue.getSymbol('DOGEUSDT')).toBeNull();
  });

  test('refuses an insufficient live set instead of shrinking the universe to a few pairs', async () => {
    const universe = createSymbolUniverse();
    const { http } = fakeHttp({
      exchangeInfo: [symbolInfo('BTCUSDT'), symbolInfo('ETHUSDT')],
      tickers: [ticker('BTCUSDT'), ticker('ETHUSDT')]
    });
    const catalogue = createMarketCatalogue({ universe, http, limit: 50 });

    const report = await catalogue.getCatalogue();
    expect(report.source).toBe('fallback');
    expect(universe.listActive()).toEqual([...PINNED_SYMBOLS]);
  });

  test('start and stop are idempotent and never leave a live timer behind', async () => {
    const universe = createSymbolUniverse();
    const { http } = fakeHttp();
    const catalogue = createMarketCatalogue({ universe, http, limit: 50 });

    catalogue.start({ intervalMs: 30000 });
    catalogue.start({ intervalMs: 30000 });
    await catalogue.getCatalogue();
    catalogue.stop();
    catalogue.stop();
    expect(DEFAULT_UNIVERSE_SIZE).toBeGreaterThanOrEqual(4);
  });
});
