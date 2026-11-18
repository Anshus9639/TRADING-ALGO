import { useEffect, useRef, useState } from 'react';
import io from 'socket.io-client';
import { API_ORIGIN } from '../lib/api';
import { CHART_INTERVALS } from '../lib/marketFormat.mjs';

// Tick events arrive per symbol. Coalescing them keeps the workstation to a
// bounded number of renders per second no matter how large the universe is.
const QUOTE_FLUSH_MS = 120;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export default function useMarketStream({ symbol, interval, enabled = true }) {
  const [quotes, setQuotes] = useState({});
  const [candle, setCandle] = useState(null);
  const [depth, setDepth] = useState(null);
  const [status, setStatus] = useState(enabled ? 'connecting' : 'offline');
  const [focusError, setFocusError] = useState(null);

  const socketRef = useRef(null);
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const pendingQuotesRef = useRef(new Map());
  const flushTimerRef = useRef(null);
  const mountedRef = useRef(true);

  const emitFocus = () => {
    const socket = socketRef.current;
    const currentSymbol = symbolRef.current;
    const currentInterval = intervalRef.current;
    if (!socket || !socket.connected) return;
    if (!currentSymbol || !CHART_INTERVALS.includes(currentInterval)) return;
    socket.emit('market:focus', { symbol: currentSymbol, interval: currentInterval });
  };

  useEffect(() => {
    if (!enabled) {
      setStatus('offline');
      setQuotes({});
      setCandle(null);
      setDepth(null);
      setFocusError(null);
      return undefined;
    }

    mountedRef.current = true;
    pendingQuotesRef.current = new Map();
    const socket = io(API_ORIGIN);
    socketRef.current = socket;

    const flushQuotes = () => {
      flushTimerRef.current = null;
      const pending = pendingQuotesRef.current;
      pendingQuotesRef.current = new Map();
      if (!mountedRef.current || pending.size === 0) return;
      setQuotes(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [key, quote] of pending) {
          const current = next[key];
          if (!current
            || current.price !== quote.price
            || current.changePercent !== quote.changePercent
            || current.quoteVolume !== quote.quoteVolume) {
            next[key] = quote;
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    };

    const scheduleFlush = () => {
      if (flushTimerRef.current) return;
      flushTimerRef.current = setTimeout(flushQuotes, QUOTE_FLUSH_MS);
    };

    const handleConnect = () => {
      if (!mountedRef.current || socketRef.current !== socket) return;
      setStatus('live');
      emitFocus();
    };

    const handleDisconnect = reason => {
      if (!mountedRef.current || socketRef.current !== socket) return;
      if (reason === 'io client disconnect') return;
      setStatus('reconnecting');
    };

    const handleConnectError = () => {
      if (!mountedRef.current || socketRef.current !== socket) return;
      setStatus('reconnecting');
    };

    const handleMarketUpdate = update => {
      if (!mountedRef.current || !update || typeof update.symbol !== 'string') return;
      if (!finite(update.price) || update.price <= 0) return;
      pendingQuotesRef.current.set(update.symbol, {
        price: update.price,
        changePercent: finite(update.changePercent) ? update.changePercent : null,
        quoteVolume: finite(update.quoteVolume) ? update.quoteVolume : null,
        ts: finite(update.ts) ? update.ts : Date.now()
      });
      scheduleFlush();
    };

    const handleCandleUpdate = payload => {
      if (!mountedRef.current || !payload) return;
      if (payload.symbol !== symbolRef.current || payload.interval !== intervalRef.current) return;
      const values = [payload.time, payload.open, payload.high, payload.low, payload.close];
      if (!values.every(finite) || payload.close <= 0) return;
      setCandle({
        symbol: payload.symbol,
        interval: payload.interval,
        time: payload.time,
        open: payload.open,
        high: payload.high,
        low: payload.low,
        close: payload.close,
        volume: finite(payload.volume) ? payload.volume : null,
        closed: Boolean(payload.closed)
      });
    };

    const handleDepthUpdate = payload => {
      if (!mountedRef.current || !payload) return;
      if (payload.symbol !== symbolRef.current) return;
      if (!Array.isArray(payload.bids) || !Array.isArray(payload.asks)) return;
      setDepth({ symbol: payload.symbol, bids: payload.bids, asks: payload.asks });
    };

    const handleMarketStatus = payload => {
      if (!mountedRef.current || !payload) return;
      if (payload.status === 'focus_rejected') {
        setFocusError(typeof payload.code === 'string' ? payload.code : 'FOCUS_REJECTED');
        return;
      }
      if (payload.status === 'focused') {
        setFocusError(null);
        return;
      }
      if (payload.status === 'live') {
        setStatus('live');
        setFocusError(null);
      } else if (payload.status === 'reconnecting') {
        setStatus('reconnecting');
      } else if (payload.status === 'offline' || payload.status === 'stopped') {
        setStatus('offline');
      } else if (payload.status === 'idle') {
        setStatus('connecting');
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('connect_error', handleConnectError);
    socket.on('marketUpdate', handleMarketUpdate);
    socket.on('candleUpdate', handleCandleUpdate);
    socket.on('depthUpdate', handleDepthUpdate);
    socket.on('marketStatus', handleMarketStatus);

    return () => {
      mountedRef.current = false;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
      pendingQuotesRef.current = new Map();
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
    };
  }, [enabled]);

  // Switching market or interval discards the previous candles/depth and
  // re-subscribes this socket instead of creating another connection.
  useEffect(() => {
    const changed = symbolRef.current !== symbol || intervalRef.current !== interval;
    symbolRef.current = symbol;
    intervalRef.current = interval;
    if (!changed) return;
    setCandle(null);
    setDepth(null);
    setFocusError(null);
    emitFocus();
  }, [symbol, interval]);

  return { quotes, candle, depth, status, focusError };
}
