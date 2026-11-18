jest.mock('axios');
const axios = require('axios');
const request = require('supertest');
const { createApp } = require('../app');

describe('historical price requests', () => {
  beforeEach(() => {
    axios.get.mockReset();
  });

  test('the Binance request carries a finite timeout', async () => {
    axios.get.mockResolvedValue({ data: [[1_700_000_000_000, '1', '2', '0.5', '1.5']] });
    const app = createApp();

    const res = await request(app).get('/api/history/BTCUSDT?interval=5m');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ time: 1_700_000_000, open: 1, high: 2, low: 0.5, close: 1.5 }]);
    expect(axios.get).toHaveBeenCalledTimes(1);

    const [url, options] = axios.get.mock.calls[0];
    expect(url).toContain('symbol=BTCUSDT');
    expect(url).toContain('interval=5m');
    expect(options).toEqual({ timeout: expect.any(Number) });
    expect(Number.isFinite(options.timeout)).toBe(true);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.timeout).toBeLessThanOrEqual(60000);
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
});
