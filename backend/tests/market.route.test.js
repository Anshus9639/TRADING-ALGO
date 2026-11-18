const request = require('supertest');
const { createApp } = require('../app');

function stubCatalogue(report) {
  return { getCatalogue: jest.fn(async () => report) };
}

const LIVE_REPORT = {
  source: 'live',
  stale: false,
  updatedAt: '2026-11-18T00:00:00.000Z',
  symbols: [
    {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      lastPrice: 65000,
      priceChangePercent: 1.2,
      quoteVolume: 1000000,
      status: 'TRADING',
      pinned: true,
      tickSize: 0.01,
      stepSize: 0.00001,
      minQty: 0.00001,
      minNotional: 10
    }
  ]
};

describe('GET /api/market/symbols', () => {
  test('returns the catalogue with cache metadata', async () => {
    const catalogue = stubCatalogue(LIVE_REPORT);
    const app = createApp({ market: { catalogue } });

    const res = await request(app).get('/api/market/symbols');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ...LIVE_REPORT });
    expect(res.headers['cache-control']).toContain('max-age=15');
    expect(catalogue.getCatalogue).toHaveBeenCalledTimes(1);
  });

  test('reports stale catalogues without changing their shape', async () => {
    const catalogue = stubCatalogue({ ...LIVE_REPORT, source: 'cache', stale: true });
    const app = createApp({ market: { catalogue } });

    const res = await request(app).get('/api/market/symbols');

    expect(res.status).toBe(200);
    expect(res.body.source).toBe('cache');
    expect(res.body.stale).toBe(true);
  });

  test('is unavailable when no catalogue is wired', async () => {
    const app = createApp();

    const res = await request(app).get('/api/market/symbols');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      message: 'Market data is unavailable.'
    });
  });

  test('fails closed when the catalogue read throws', async () => {
    const catalogue = { getCatalogue: jest.fn(async () => { throw new Error('boom'); }) };
    const app = createApp({ market: { catalogue } });

    const res = await request(app).get('/api/market/symbols');

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
  });

  test('bounds catalogue reads per client without breaking ordinary navigation', async () => {
    const catalogue = stubCatalogue(LIVE_REPORT);
    const app = createApp({
      market: { catalogue },
      marketReadRateLimit: { max: 2, windowMs: 60000 }
    });

    expect((await request(app).get('/api/market/symbols')).status).toBe(200);
    expect((await request(app).get('/api/market/symbols')).status).toBe(200);

    const limited = await request(app).get('/api/market/symbols');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

// server.js creates the app before the catalogue exists and attaches it to the
// shared market context afterwards. The router must resolve the current
// catalogue per request instead of capturing the initial null.
describe('GET /api/market/symbols with deferred catalogue wiring', () => {
  test('fails closed before attachment and serves the catalogue afterwards', async () => {
    const market = { catalogue: null };
    const app = createApp({ market });

    const before = await request(app).get('/api/market/symbols');
    expect(before.status).toBe(503);
    expect(before.body).toEqual({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      message: 'Market data is unavailable.'
    });

    market.catalogue = stubCatalogue(LIVE_REPORT);

    // Same app instance: no re-creation, no route rewiring.
    const after = await request(app).get('/api/market/symbols');
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ success: true, ...LIVE_REPORT });
    expect(after.headers['cache-control']).toContain('max-age=15');
  });

  test('does not leak internal catalogue failures', async () => {
    const market = { catalogue: null };
    const app = createApp({ market });
    market.catalogue = {
      getCatalogue: jest.fn(async () => {
        throw new Error('internal credentials rejected');
      })
    };

    const res = await request(app).get('/api/market/symbols');

    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      success: false,
      code: 'MARKET_DATA_UNAVAILABLE',
      message: 'Market data is unavailable.'
    });
    expect(JSON.stringify(res.body)).not.toContain('credentials');
  });

  test('keeps rate limiting active after a deferred attachment', async () => {
    const market = { catalogue: null };
    const app = createApp({
      market,
      marketReadRateLimit: { max: 2, windowMs: 60000 }
    });
    market.catalogue = stubCatalogue(LIVE_REPORT);

    expect((await request(app).get('/api/market/symbols')).status).toBe(200);
    expect((await request(app).get('/api/market/symbols')).status).toBe(200);

    const limited = await request(app).get('/api/market/symbols');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
  });
});
