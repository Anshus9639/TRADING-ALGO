export const SESSION_TOKEN = 'e2e-session-token';

export const MARKETS = [
  {
    symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT',
    lastPrice: 64000, priceChangePercent: 1.25, quoteVolume: 812345678, status: 'TRADING'
  },
  {
    symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT',
    lastPrice: 3200.5, priceChangePercent: -0.75, quoteVolume: 402345678, status: 'TRADING'
  },
  {
    symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT',
    lastPrice: 148.25, priceChangePercent: 3.4, quoteVolume: 98000000, status: 'TRADING'
  },
  {
    symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT',
    lastPrice: 412.75, priceChangePercent: 0.5, quoteVolume: 45000000, status: 'TRADING'
  },
  {
    symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT',
    lastPrice: 0.5321, priceChangePercent: -1.1, quoteVolume: 32000000, status: 'TRADING'
  },
  {
    symbol: 'ADAUSDT', baseAsset: 'ADA', quoteAsset: 'USDT',
    lastPrice: 0.4478, priceChangePercent: 2.05, quoteVolume: 21000000, status: 'TRADING'
  },
  {
    symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT',
    lastPrice: 0.1289, priceChangePercent: -2.3, quoteVolume: 18000000, status: 'TRADING'
  },
  {
    symbol: 'AVAXUSDT', baseAsset: 'AVAX', quoteAsset: 'USDT',
    lastPrice: 27.4, priceChangePercent: 1.8, quoteVolume: 12000000, status: 'TRADING'
  }
];

export const PROFILE = {
  id: 'e2e-user',
  username: 'e2e-trader',
  email: 'e2e@example.com',
  balance: 12500.5,
  lockedBalance: 450,
  portfolio: [
    { _id: 'pos-btc', symbol: 'BTCUSDT', quantity: 0.05, lockedQuantity: 0, avgPrice: 61000 }
  ],
  trades: [
    {
      _id: 'trade-1',
      orderId: 'order-1',
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.05,
      price: 61000,
      timestamp: '2026-11-17T10:15:00.000Z',
      realizedPnl: null,
      clientOrderId: '11111111-1111-4111-8111-111111111111'
    }
  ],
  pendingOrders: [
    {
      _id: 'pending-1',
      symbol: 'ETHUSDT',
      type: 'BUY',
      quantity: 0.5,
      limitPrice: 3000,
      timestamp: '2026-11-17T11:00:00.000Z',
      clientOrderId: '22222222-2222-4222-8222-222222222222',
      status: 'OPEN'
    }
  ],
  watchlist: ['ETHUSDT', 'SOLUSDT'],
  legacyAmbiguity: { pendingOrderIds: [], tradeIds: [] }
};

const INTERVAL_SECONDS = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400
};

export function candlesFor(symbol, interval, count = 120) {
  const step = INTERVAL_SECONDS[interval] || 300;
  const base = symbol === 'BTCUSDT' ? 64000 : 3200;
  const end = Math.floor(Date.now() / 1000 / step) * step;
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const drift = Math.sin(index / 6) * base * 0.01 + index * base * 0.00002;
    const close = base + drift;
    const open = close - Math.cos(index / 5) * base * 0.0015;
    rows.push({
      time: end - (count - index) * step,
      open: Number(open.toFixed(2)),
      high: Number((Math.max(open, close) + base * 0.002).toFixed(2)),
      low: Number((Math.min(open, close) - base * 0.002).toFixed(2)),
      close: Number(close.toFixed(2)),
      volume: Number((10 + (index % 7) * 1.5).toFixed(2))
    });
  }
  return rows;
}

function json(route, status, body) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body)
  });
}

/**
 * Intercept every REST call the workstation makes. Nothing leaves the browser:
 * the URL host is the local preview server, and each route is served from these
 * deterministic fixtures.
 */
export async function mockApi(page) {
  const state = { watchlistWrites: [], catalogueRequests: 0 };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === '/api/market/symbols') {
      state.catalogueRequests += 1;
      return json(route, 200, {
        success: true,
        source: 'binance.us',
        stale: false,
        updatedAt: new Date().toISOString(),
        symbols: MARKETS
      });
    }

    if (path === '/api/auth/me') {
      return json(route, 200, PROFILE);
    }

    if (path.startsWith('/api/history/')) {
      const symbol = decodeURIComponent(path.slice('/api/history/'.length));
      const interval = url.searchParams.get('interval') || '1m';
      return json(route, 200, candlesFor(symbol, interval));
    }

    if (path === '/api/auth/watchlist' && method === 'PUT') {
      const body = request.postDataJSON() || {};
      state.watchlistWrites.push(body.symbols || []);
      return json(route, 200, { success: true, watchlist: body.symbols || [] });
    }

    if (path === '/api/auth/login' && method === 'POST') {
      return json(route, 200, { token: SESSION_TOKEN, user: PROFILE });
    }

    return json(route, 404, { success: false, message: `No e2e fixture for ${method} ${path}` });
  });

  return state;
}

export async function seedSession(page, token = SESSION_TOKEN) {
  await page.addInitScript(value => {
    window.localStorage.setItem('token', value);
  }, token);
}
