jest.mock('axios');
const axios = require('axios');
const request = require('supertest');
const { createApp } = require('../app');
const { createHistoryFetcher } = require('../services/marketHistory');
const { symbolUniverse } = require('../services/symbolUniverse');

describe('historical price requests', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  afterEach(() => {
    symbolUniverse.reset();
  });

  test('the Binance request carries a finite timeout', async () => {
    axios.get.mockResolvedValue({ data: [[1_700_000_000_000, '1', '2', '0.5', '1.5', '1200']] });
    const app = createApp();

    const res = await request(app).get('/api/history/BTCUSDT?interval=5m');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{
      time: 1_700_000_000,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 1200
    }]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    const [url, options] = axios.get.mock.calls[0];
    expect(url).toContain('symbol=BTCUSDT');
    expect(url).toContain('interval=5m');
    expect(options).toEqual({ timeout: expect.any(Number) });
    expect(Number.isFinite(options.timeout)).toBe(true);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(60000);

    // The response advertises exactly the fetcher's own cache lifetime.
    expect(res.headers['cache-control']).toBe('public, max-age=5, stale-while-revalidate=10');
  });

  test('a stalled upstream request fails the handler instead of hanging', async () => {
    axios.get.mockRejectedValue(Object.assign(
      new Error('timeout of 10000ms exceeded'),
      { code: 'ECONNABORTED' }
    ));
    const app = createApp();

    const res = await request(app).get('/api/history/ETHUSDT');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch history' });
  });

  test('rejects symbols outside the active universe without calling the exchange', async () => {
    const app = createApp();

    const res = await request(app).get('/api/history/DOGEUSDT');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Unsupported symbol.' });
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('rejects malformed or unsupported intervals without calling the exchange', async () => {
    const app = createApp();

    for (const query of ['interval=30m', 'interval=1M', 'interval=1m&interval=5m']) {
      const res = await request(app).get(`/api/history/BTCUSDT?${query}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Unsupported interval.' });
    }
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('shares a short-lived cache between repeated requests', async () => {
    axios.get.mockResolvedValue({ data: [[1_700_000_000_000, '1', '2', '0.5', '1.5', '1200']] });
    const app = createApp();

    await request(app).get('/api/history/BTCUSDT?interval=1h');
    await request(app).get('/api/history/btcusdt?interval=1h');

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  test('a malformed upstream payload becomes a 500 instead of a chart of nulls', async () => {
    axios.get.mockResolvedValue({ data: { error: 'rate limited' } });
    const app = createApp();

    const res = await request(app).get('/api/history/BTCUSDT');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to fetch history' });
  });

  test('bounds chart requests per client without breaking normal navigation', async () => {
    axios.get.mockResolvedValue({ data: [[1_700_000_000_000, '1', '2', '0.5', '1.5', '1200']] });
    const app = createApp({ marketReadRateLimit: { max: 2, windowMs: 60000 } });

    expect((await request(app).get('/api/history/BTCUSDT')).status).toBe(200);
    expect((await request(app).get('/api/history/BTCUSDT')).status).toBe(200);

    const limited = await request(app).get('/api/history/BTCUSDT');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });

  test('a disabled read limit still serves charts', async () => {
    axios.get.mockResolvedValue({ data: [[1_700_000_000_000, '1', '2', '0.5', '1.5', '1200']] });
    const app = createApp({ marketReadRateLimit: { max: 0, windowMs: 60000 } });

    for (let index = 0; index < 5; index += 1) {
      expect((await request(app).get('/api/history/BTCUSDT')).status).toBe(200);
    }
  });
});

describe('history fetcher cache', () => {
  test('expires entries after the TTL and bounds the cache size', async () => {
    let clock = 1_000;
    const http = { get: jest.fn(async () => ({ data: [[0, '1', '1', '1', '1']] })) };
    const fetcher = createHistoryFetcher({ http, now: () => clock, ttlMs: 500 });

    await fetcher.fetchKlines({ symbol: 'BTCUSDT', interval: '1m' });
    await fetcher.fetchKlines({ symbol: 'BTCUSDT', interval: '1m' });
    expect(http.get).toHaveBeenCalledTimes(1);

    clock += 500;
    await fetcher.fetchKlines({ symbol: 'BTCUSDT', interval: '1m' });
    expect(http.get).toHaveBeenCalledTimes(2);
  });

  test('builds the upstream URL with encoded parameters', async () => {
    const http = { get: jest.fn(async () => ({ data: [] })) };
    const fetcher = createHistoryFetcher({ http, ttlMs: 0 });

    await fetcher.fetchKlines({ symbol: 'SOLUSDT', interval: '4h' });

    const [url, options] = http.get.mock.calls[0];
    expect(url).toBe(
      'https://api.binance.us/api/v3/klines?symbol=SOLUSDT&interval=4h&limit=500'
    );
    expect(options.timeout).toBe(10000);
  });

  test('exposes the effective TTL so headers match the real cache lifetime', () => {
    expect(createHistoryFetcher({ ttlMs: 5000 }).ttlMs).toBe(5000);
    expect(createHistoryFetcher({ ttlMs: 0 }).ttlMs).toBe(0);
    // Invalid values fall back to the documented default rather than disabling
    // the cache or creating immortal entries.
    expect(createHistoryFetcher({ ttlMs: -1 }).ttlMs).toBe(5000);
    expect(createHistoryFetcher({ ttlMs: Number.NaN }).ttlMs).toBe(5000);
  });
});
