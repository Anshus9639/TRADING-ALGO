const WebSocket = require('ws');
const { normalizeSymbol } = require('../lib/symbols');
const { normalizeChartInterval } = require('../lib/chartIntervals');

const STREAM_URL = 'wss://stream.binance.us:9443/stream';
const DEFAULT_MAX_FOCUS_STREAMS = 6;
const DEFAULT_BACKOFF_BASE_MS = 1000;
const DEFAULT_BACKOFF_MAX_MS = 30000;
const DEFAULT_BACKOFF_JITTER = 0.2;
const DEFAULT_RESTART_DEBOUNCE_MS = 150;
const ERROR_LOG_INTERVAL_MS = 5000;

function focusKey(symbol, interval) {
  return `${symbol}|${interval}`;
}

function symbolFromStreamName(streamName) {
  if (typeof streamName !== 'string') return null;
  return normalizeSymbol(streamName.split('@')[0]);
}

function klineIntervalFromStreamName(streamName) {
  if (typeof streamName !== 'string') return null;
  const match = streamName.match(/@kline_([a-z0-9]+)$/);
  return match ? normalizeChartInterval(match[1]) : null;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const normalized = [];
  for (const level of levels.slice(0, 8)) {
    if (!Array.isArray(level)) continue;
    const price = numeric(level[0]);
    const quantity = numeric(level[1]);
    if (price === null || quantity === null) continue;
    normalized.push([price, quantity]);
  }
  return normalized;
}

// Bounded Binance.US bridge. One socket carries tickers for the catalogue and
// candle/depth streams only for the focus keys clients asked for, so the
// subscription set never grows with traffic. Every reconnect re-derives the
// stream list from current state.
function createMarketStream({
  io,
  feed,
  symbols = [],
  WebSocketImpl = WebSocket,
  url = STREAM_URL,
  maxFocusStreams = DEFAULT_MAX_FOCUS_STREAMS,
  now = Date.now,
  rng = Math.random,
  logger = console,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  backoffJitter = DEFAULT_BACKOFF_JITTER,
  restartDebounceMs = DEFAULT_RESTART_DEBOUNCE_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) {
  if (!io || typeof io.emit !== 'function') {
    throw new TypeError('createMarketStream requires a socket server.');
  }
  if (!feed || typeof feed.setQuote !== 'function' || typeof feed.hasSymbol !== 'function') {
    throw new TypeError('createMarketStream requires a market feed.');
  }

  const tickers = new Set();
  const focus = new Map();
  let socket = null;
  let generation = 0;
  let started = false;
  let retry = 0;
  let reconnectTimer = null;
  let restartTimer = null;
  let connected = false;
  let lastErrorAt = 0;
  let suppressedErrors = 0;

  function normalizeSymbolList(list) {
    const next = [];
    const seen = new Set();
    if (!Array.isArray(list)) return next;
    for (const item of list) {
      const symbol = normalizeSymbol(item);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      next.push(symbol);
    }
    return next;
  }

  function setSymbols(list) {
    const next = normalizeSymbolList(list);
    if (next.length === 0) return Array.from(tickers);
    const same = next.length === tickers.size && next.every(symbol => tickers.has(symbol));
    if (same) return Array.from(tickers);

    tickers.clear();
    for (const symbol of next) tickers.add(symbol);

    // A pair that left the catalogue cannot keep a candle/depth subscription.
    for (const key of Array.from(focus.keys())) {
      const symbol = key.split('|')[0];
      if (!tickers.has(symbol)) focus.delete(key);
    }

    if (started) scheduleRestart();
    return Array.from(tickers);
  }

  function activeFocusList() {
    return Array.from(focus.keys()).map(key => {
      const [symbol, interval] = key.split('|');
      return { symbol, interval };
    });
  }

  function acquireFocus({ symbol, interval } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeChartInterval(interval);
    if (!normalizedSymbol || !tickers.has(normalizedSymbol)) {
      return { ok: false, code: 'UNSUPPORTED_SYMBOL' };
    }
    if (!normalizedInterval) {
      return { ok: false, code: 'UNSUPPORTED_INTERVAL' };
    }

    const key = focusKey(normalizedSymbol, normalizedInterval);
    const existing = focus.get(key) || 0;
    if (existing === 0 && focus.size >= maxFocusStreams) {
      return { ok: false, code: 'FOCUS_LIMIT_REACHED' };
    }

    focus.set(key, existing + 1);
    if (existing === 0 && started) scheduleRestart();
    return { ok: true, symbol: normalizedSymbol, interval: normalizedInterval };
  }

  function releaseFocus({ symbol, interval } = {}) {
    const normalizedSymbol = normalizeSymbol(symbol);
    const normalizedInterval = normalizeChartInterval(interval);
    if (!normalizedSymbol || !normalizedInterval) return false;

    const key = focusKey(normalizedSymbol, normalizedInterval);
    const existing = focus.get(key);
    if (!existing) return false;

    if (existing <= 1) focus.delete(key);
    else focus.set(key, existing - 1);

    if (existing <= 1 && started) scheduleRestart();
    return true;
  }

  function buildUrl() {
    const streams = [
      ...Array.from(tickers).map(symbol => `${symbol.toLowerCase()}@ticker`)
    ];
    for (const { symbol, interval } of activeFocusList()) {
      streams.push(`${symbol.toLowerCase()}@kline_${interval}`);
      streams.push(`${symbol.toLowerCase()}@depth20@100ms`);
    }
    return `${url}?streams=${streams.join('/')}`;
  }

  function safeError(code, detail) {
    const timestamp = now();
    if (timestamp - lastErrorAt >= ERROR_LOG_INTERVAL_MS) {
      const suffix = suppressedErrors > 0 ? ` (${suppressedErrors} similar suppressed)` : '';
      logger.error(`Market stream error: ${code}${detail ? ` ${detail}` : ''}${suffix}`);
      lastErrorAt = timestamp;
      suppressedErrors = 0;
    } else {
      suppressedErrors += 1;
    }
  }

  function emitStatus(payload) {
    io.emit('marketStatus', {
      ...payload,
      activeSymbols: tickers.size,
      focusedStreams: focus.size,
      checkedAt: new Date(now()).toISOString()
    });
  }

  function handleTicker(msg) {
    const symbol = normalizeSymbol(msg.s);
    if (!symbol) return;
    const price = numeric(msg.c);
    if (price === null || price <= 0) return;
    if (!feed.setQuote(symbol, price)) return;

    io.emit('marketUpdate', {
      symbol,
      price,
      changePercent: numeric(msg.P),
      quoteVolume: numeric(msg.q),
      ts: now()
    });
  }

  function handleKline(raw, streamName, msg) {
    const symbol = symbolFromStreamName(streamName);
    const interval = klineIntervalFromStreamName(streamName);
    if (!symbol || !interval) return;
    if (!focus.has(focusKey(symbol, interval))) return;

    const candle = msg.k;
    const open = numeric(candle.o);
    const high = numeric(candle.h);
    const low = numeric(candle.l);
    const close = numeric(candle.c);
    const openTime = numeric(candle.t);
    if (open === null || high === null || low === null || close === null || openTime === null) {
      safeError('MALFORMED_KLINE', symbol);
      return;
    }
    const volume = numeric(candle.v);

    io.emit('candleUpdate', {
      symbol,
      interval,
      time: Math.floor(openTime / 1000),
      open,
      high,
      low,
      close,
      volume: volume !== null && volume >= 0 ? volume : null,
      closed: Boolean(candle.x)
    });
  }

  function handleDepth(streamName, msg) {
    // Depth payloads carry no symbol field; attribution must come from the
    // stream name. There is deliberately no fallback symbol.
    const symbol = symbolFromStreamName(streamName);
    if (!symbol) {
      safeError('UNATTRIBUTED_DEPTH');
      return;
    }
    if (!Array.from(focus.keys()).some(key => key.startsWith(`${symbol}|`))) {
      return;
    }
    io.emit('depthUpdate', {
      symbol,
      bids: normalizeLevels(msg.bids || msg.b),
      asks: normalizeLevels(msg.asks || msg.a)
    });
  }

  function handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      safeError('INVALID_JSON');
      return;
    }

    const streamName = typeof parsed.stream === 'string' ? parsed.stream : '';
    const msg = parsed.data || parsed;
    if (!msg || typeof msg !== 'object') {
      safeError('MALFORMED_MESSAGE');
      return;
    }

    if (msg.e === '24hrTicker') {
      handleTicker(msg);
      return;
    }
    if (msg.e === 'kline') {
      handleKline(parsed, streamName, msg);
      return;
    }
    if (Array.isArray(msg.bids) || Array.isArray(msg.b) || Array.isArray(msg.asks) || Array.isArray(msg.a)) {
      handleDepth(streamName, msg);
      return;
    }

    // Binance emits subscription acks and other events; only unknown shapes
    // with a usable stream name are worth reporting.
    if (streamName && !streamName.includes('@ticker')) {
      safeError('UNHANDLED_STREAM', streamName);
    }
  }

  function scheduleReconnect() {
    if (!started || reconnectTimer) return;
    const exponential = Math.min(backoffMaxMs, backoffBaseMs * (2 ** retry));
    const jitterSpread = exponential * backoffJitter;
    const delay = Math.round(exponential - jitterSpread + rng() * jitterSpread * 2);
    retry += 1;

    emitStatus({ status: 'reconnecting', retryInMs: delay });
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function scheduleRestart() {
    if (!started) return;
    if (restartTimer) clearTimeoutFn(restartTimer);
    restartTimer = setTimeoutFn(() => {
      restartTimer = null;
      connect();
    }, restartDebounceMs);
  }

  function connect() {
    if (!started) return;
    if (restartTimer) {
      clearTimeoutFn(restartTimer);
      restartTimer = null;
    }
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }

    generation += 1;
    const currentGeneration = generation;

    if (socket) {
      try {
        socket.close();
      } catch {
        // Closing an already-dead socket is expected during reconnects.
      }
      socket = null;
    }

    if (tickers.size === 0) {
      emitStatus({ status: 'idle' });
      return;
    }

    let next;
    try {
      next = new WebSocketImpl(buildUrl());
    } catch (err) {
      safeError('CONNECT_FAILED', err && err.message);
      scheduleReconnect();
      return;
    }
    socket = next;

    next.on('open', () => {
      if (currentGeneration !== generation) return;
      connected = true;
      retry = 0;
      emitStatus({ status: 'live' });
    });

    next.on('message', data => {
      if (currentGeneration !== generation) return;
      handleMessage(data);
    });

    next.on('error', err => {
      if (currentGeneration !== generation) return;
      safeError('SOCKET_ERROR', err && err.message);
    });

    next.on('close', () => {
      if (currentGeneration !== generation) return;
      connected = false;
      socket = null;
      emitStatus({ status: 'offline' });
      scheduleReconnect();
    });
  }

  function start({ symbols: initialSymbols } = {}) {
    if (started) return;
    if (initialSymbols) setSymbols(initialSymbols);
    started = true;
    connect();
  }

  function stop() {
    started = false;
    generation += 1;
    connected = false;
    if (reconnectTimer) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    if (restartTimer) {
      clearTimeoutFn(restartTimer);
      restartTimer = null;
    }
    if (socket) {
      try {
        socket.close();
      } catch {
        // Ignore close failures while shutting down.
      }
      socket = null;
    }
    emitStatus({ status: 'stopped' });
  }

  function snapshot() {
    return {
      started,
      connected,
      symbols: Array.from(tickers),
      focus: activeFocusList(),
      retry,
      url: buildUrl()
    };
  }

  if (Array.isArray(symbols) && symbols.length > 0) setSymbols(symbols);

  return {
    start,
    stop,
    setSymbols,
    acquireFocus,
    releaseFocus,
    snapshot,
    buildUrl
  };
}

module.exports = {
  createMarketStream,
  STREAM_URL,
  DEFAULT_MAX_FOCUS_STREAMS
};
