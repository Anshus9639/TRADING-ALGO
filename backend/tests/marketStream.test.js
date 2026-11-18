const { createMarketStream, DEFAULT_MAX_FOCUS_STREAMS } = require('../services/marketStream');
const { createMarketFeed } = require('../services/marketFeed');

class FakeSocket {
  constructor(url) {
    this.url = url;
    this.closed = false;
    this.handlers = new Map();
    FakeSocket.instances.push(this);
  }

  on(event, handler) {
    if (!this.handlers.has(event)) this.handlers.set(event, []);
    this.handlers.get(event).push(handler);
    return this;
  }

  emitEvent(event, payload) {
    for (const handler of this.handlers.get(event) || []) {
      handler(payload);
    }
  }

  close() {
    this.closed = true;
  }

  static instances = [];
}

function makeIo() {
  return { emit: jest.fn() };
}

function events(io, name) {
  return io.emit.mock.calls
    .filter(([event]) => event === name)
    .map(([, payload]) => payload);
}

function makeStream(overrides = {}) {
  const io = makeIo();
  const feed = createMarketFeed({ symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'] });
  const logger = { error: jest.fn() };
  const stream = createMarketStream({
    io,
    feed,
    symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
    WebSocketImpl: FakeSocket,
    rng: () => 0,
    backoffJitter: 0,
    logger,
    now: () => 1_700_000_000_000,
    ...overrides
  });
  return { io, feed, stream, logger };
}

describe('market stream bridge', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('subscribes tickers for the whole universe and no focus streams by default', () => {
    const { stream } = makeStream();

    const url = stream.buildUrl();
    expect(url).toContain('btcusdt@ticker');
    expect(url).toContain('ethusdt@ticker');
    expect(url).toContain('solusdt@ticker');
    expect(url).not.toContain('@kline_');
    expect(url).not.toContain('@depth');
  });

  test('reports live status and publishes numeric ticker updates into the feed', () => {
    const { io, feed, stream } = makeStream();
    stream.start();

    const socket = FakeSocket.instances[0];
    socket.emitEvent('open');
    expect(events(io, 'marketStatus').at(-1)).toMatchObject({ status: 'live', activeSymbols: 3 });

    socket.emitEvent('message', JSON.stringify({
      stream: 'btcusdt@ticker',
      data: { e: '24hrTicker', s: 'BTCUSDT', c: '65000.50', P: '2.51', q: '123456.75' }
    }));

    expect(events(io, 'marketUpdate')).toEqual([
      { symbol: 'BTCUSDT', price: 65000.5, changePercent: 2.51, quoteVolume: 123456.75, ts: 1_700_000_000_000 }
    ]);
    expect(feed.getQuote('BTCUSDT')).toMatchObject({ status: 'ok', price: 65000.5 });
  });

  test('ignores tickers for symbols outside the feed instead of inventing quotes', () => {
    const { io, stream } = makeStream();
    stream.start();
    const socket = FakeSocket.instances[0];
    socket.emitEvent('open');

    socket.emitEvent('message', JSON.stringify({
      data: { e: '24hrTicker', s: 'DOGEUSDT', c: '0.42', P: '5', q: '1000' }
    }));

    expect(events(io, 'marketUpdate')).toEqual([]);
  });

  test('validates focus requests and bounds simultaneous candle/depth streams', () => {
    const { stream } = makeStream({ maxFocusStreams: 1 });

    expect(stream.acquireFocus({ symbol: 'BTCUSDT', interval: '5m' })).toMatchObject({ ok: true });
    expect(stream.acquireFocus({ symbol: 'ETHUSDT', interval: '5m' })).toEqual({
      ok: false,
      code: 'FOCUS_LIMIT_REACHED'
    });
    expect(stream.acquireFocus({ symbol: 'DOGEUSDT', interval: '5m' })).toEqual({
      ok: false,
      code: 'UNSUPPORTED_SYMBOL'
    });
    expect(stream.acquireFocus({ symbol: 'BTCUSDT', interval: '30m' })).toEqual({
      ok: false,
      code: 'UNSUPPORTED_INTERVAL'
    });

    stream.releaseFocus({ symbol: 'BTCUSDT', interval: '5m' });
    expect(stream.acquireFocus({ symbol: 'ETHUSDT', interval: '1h' })).toMatchObject({ ok: true });
    expect(DEFAULT_MAX_FOCUS_STREAMS).toBeGreaterThan(1);
  });

  test('re-derives the subscription list when a focus is added', () => {
    jest.useFakeTimers();
    const { stream } = makeStream();
    stream.start();
    const first = FakeSocket.instances[0];

    stream.acquireFocus({ symbol: 'btcusdt', interval: '5m' });
    expect(FakeSocket.instances).toHaveLength(1);

    jest.advanceTimersByTime(150);
    expect(first.closed).toBe(true);
    const second = FakeSocket.instances[1];
    expect(second.url).toContain('btcusdt@kline_5m');
    expect(second.url).toContain('btcusdt@depth20@100ms');
    expect(second.url).toContain('btcusdt@ticker');
  });

  test('emits candles only for focused streams with numeric values', () => {
    jest.useFakeTimers();
    const { io, stream } = makeStream();
    stream.start();
    const socket = FakeSocket.instances[0];
    socket.emitEvent('open');
    io.emit.mockClear();

    stream.acquireFocus({ symbol: 'BTCUSDT', interval: '5m' });
    jest.advanceTimersByTime(150);
    const focused = FakeSocket.instances[1];

    focused.emitEvent('message', JSON.stringify({
      stream: 'btcusdt@kline_5m',
      data: {
        e: 'kline',
        k: { t: 1_700_000_000_000, o: '100.1', h: '101.2', l: '99.5', c: '100.8', v: '12.5', x: true }
      }
    }));

    expect(events(io, 'candleUpdate')).toEqual([{
      symbol: 'BTCUSDT',
      interval: '5m',
      time: 1_700_000_000,
      open: 100.1,
      high: 101.2,
      low: 99.5,
      close: 100.8,
      volume: 12.5,
      closed: true
    }]);

    io.emit.mockClear();
    focused.emitEvent('message', JSON.stringify({
      stream: 'ethusdt@kline_5m',
      data: { e: 'kline', k: { t: 1, o: '1', h: '1', l: '1', c: '1' } }
    }));
    expect(events(io, 'candleUpdate')).toEqual([]);
  });

  test('attributes depth to its stream and never falls back to BTCUSDT', () => {
    jest.useFakeTimers();
    const { io, stream } = makeStream();
    stream.start();
    FakeSocket.instances[0].emitEvent('open');

    stream.acquireFocus({ symbol: 'ETHUSDT', interval: '1m' });
    jest.advanceTimersByTime(150);
    const focused = FakeSocket.instances[1];
    io.emit.mockClear();

    focused.emitEvent('message', JSON.stringify({
      stream: 'ethusdt@depth20@100ms',
      data: { bids: [['3000.5', '1.25']], asks: [['3001', '0.5']] }
    }));
    expect(events(io, 'depthUpdate')).toEqual([{
      symbol: 'ETHUSDT',
      bids: [[3000.5, 1.25]],
      asks: [[3001, 0.5]]
    }]);

    io.emit.mockClear();
    focused.emitEvent('message', JSON.stringify({ data: { bids: [['1', '1']], asks: [] } }));
    expect(events(io, 'depthUpdate')).toEqual([]);
  });

  test('reconnects with exponential backoff and rejects malformed frames without crashing', () => {
    jest.useFakeTimers();
    const { io, stream, logger } = makeStream({ backoffBaseMs: 1000, backoffMaxMs: 30000 });
    stream.start();

    const first = FakeSocket.instances[0];
    first.emitEvent('open');
    io.emit.mockClear();

    first.emitEvent('message', 'not json');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(events(io, 'candleUpdate')).toEqual([]);

    first.emitEvent('close');
    expect(events(io, 'marketStatus').map(status => status.status)).toEqual(['offline', 'reconnecting']);
    expect(events(io, 'marketStatus').at(-1).retryInMs).toBe(1000);

    jest.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);

    // A second failure before any successful open doubles the delay.
    FakeSocket.instances[1].emitEvent('close');
    expect(events(io, 'marketStatus').at(-1).retryInMs).toBe(2000);

    jest.advanceTimersByTime(2000);
    expect(FakeSocket.instances).toHaveLength(3);
  });

  test('stop closes the socket and cancels pending reconnects', () => {
    jest.useFakeTimers();
    const { io, stream } = makeStream();
    stream.start();
    const socket = FakeSocket.instances[0];

    socket.emitEvent('close');
    stream.stop();

    jest.advanceTimersByTime(60000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(events(io, 'marketStatus').at(-1).status).toBe('stopped');

    const second = makeStream();
    second.stream.start();
    second.stream.stop();
    expect(FakeSocket.instances.at(-1).closed).toBe(true);
    expect(events(second.io, 'marketStatus').at(-1).status).toBe('stopped');
  });

  test('a shrinking symbol set drops out-of-universe focus subscriptions', () => {
    jest.useFakeTimers();
    const { stream } = makeStream();
    stream.start();
    const first = FakeSocket.instances[0];
    first.emitEvent('open');

    stream.acquireFocus({ symbol: 'BTCUSDT', interval: '5m' });
    stream.acquireFocus({ symbol: 'ETHUSDT', interval: '1m' });
    jest.advanceTimersByTime(150);

    stream.setSymbols(['BTCUSDT', 'SOLUSDT']);
    jest.advanceTimersByTime(150);

    const latest = FakeSocket.instances.at(-1);
    expect(latest.url).toContain('btcusdt@kline_5m');
    expect(latest.url).not.toContain('ethusdt');
    expect(latest.url).toContain('solusdt@ticker');
    expect(stream.snapshot().focus).toEqual([{ symbol: 'BTCUSDT', interval: '5m' }]);
  });

  test('refuses to run with no symbols instead of opening an empty subscription', () => {
    const { io, stream } = makeStream({ symbols: [] });
    stream.start();

    expect(FakeSocket.instances).toHaveLength(0);
    expect(events(io, 'marketStatus').at(-1).status).toBe('idle');
  });
});
