import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { fallbackMarkets } from '../lib/marketFormat.mjs';

export const CATALOGUE_POLL_MS = 60000;

function initialCatalogue() {
  return {
    markets: fallbackMarkets(),
    source: 'fallback',
    stale: true,
    updatedAt: null,
    loading: true,
    error: null
  };
}

// The server is the only source of tradeable symbols and prices. A failed poll
// keeps the last good catalogue (marked stale) instead of guessing, and the
// pinned fallback carries no prices at all.
export default function useMarketCatalogue() {
  const [state, setState] = useState(initialCatalogue);
  const mountedRef = useRef(true);
  const requestRef = useRef(null);

  const load = useCallback(async () => {
    if (requestRef.current) requestRef.current.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    requestRef.current = controller;

    try {
      const res = await api.get(
        '/api/market/symbols',
        controller ? { signal: controller.signal } : undefined
      );
      if (!mountedRef.current || (controller && controller.signal.aborted)) return;

      const payload = res.data || {};
      const markets = Array.isArray(payload.symbols)
        ? payload.symbols.filter(row => row && typeof row.symbol === 'string')
        : [];

      if (markets.length === 0) {
        setState(prev => ({ ...prev, loading: false, stale: true, error: 'MARKET_CATALOGUE_EMPTY' }));
        return;
      }

      setState({
        markets,
        source: typeof payload.source === 'string' ? payload.source : 'exchange',
        stale: Boolean(payload.stale),
        updatedAt: payload.updatedAt || null,
        loading: false,
        error: null
      });
    } catch (err) {
      if (!mountedRef.current) return;
      if (controller && controller.signal.aborted) return;
      if (err?.code === 'ERR_CANCELED') return;
      setState(prev => ({
        ...prev,
        markets: prev.markets.length > 0 ? prev.markets : fallbackMarkets(),
        stale: true,
        loading: false,
        error: err?.response?.data?.message || 'Market data is unavailable.'
      }));
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    load();
    const timer = setInterval(load, CATALOGUE_POLL_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      if (requestRef.current) requestRef.current.abort();
    };
  }, [load]);

  return { ...state, refresh: load };
}
