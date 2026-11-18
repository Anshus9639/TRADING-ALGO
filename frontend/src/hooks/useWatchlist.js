import { useCallback, useEffect, useRef, useState } from 'react';
import { api, authHeaders } from '../lib/api';
import {
  MAX_WATCHLIST_SYMBOLS,
  normalizeSymbolList,
  toggleWatchlist
} from '../lib/marketFormat.mjs';

// Optimistic per-user watchlist. The server validates every symbol against the
// active catalogue, so a rejected write rolls the UI back to its last state.
export default function useWatchlist({ token, initial }) {
  const initialKey = normalizeSymbolList(initial).join(',');
  const [watchlist, setWatchlist] = useState(() => normalizeSymbolList(initial));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const tokenRef = useRef(token);
  const watchlistRef = useRef(watchlist);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    watchlistRef.current = watchlist;
  }, [watchlist]);

  useEffect(() => {
    tokenRef.current = token;
    const next = initialKey ? initialKey.split(',') : [];
    watchlistRef.current = next;
    busyRef.current = false;
    setWatchlist(next);
    setBusy(false);
    setError(null);
  }, [token, initialKey]);

  const toggle = useCallback(async (symbol) => {
    if (busyRef.current) return;
    const sessionToken = tokenRef.current;
    if (!sessionToken) return;

    const previous = watchlistRef.current;
    const result = toggleWatchlist(previous, symbol, MAX_WATCHLIST_SYMBOLS);
    if (result.rejected === 'LIMIT_REACHED') {
      setError(`Watchlists are limited to ${MAX_WATCHLIST_SYMBOLS} markets.`);
      return;
    }
    if (result.rejected) {
      setError('That market code is not valid.');
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    watchlistRef.current = result.symbols;
    setWatchlist(result.symbols);

    try {
      const res = await api.put(
        '/api/auth/watchlist',
        { symbols: result.symbols },
        authHeaders(sessionToken)
      );
      if (!mountedRef.current || tokenRef.current !== sessionToken) return;
      const saved = normalizeSymbolList(res.data?.symbols ?? result.symbols);
      watchlistRef.current = saved;
      setWatchlist(saved);
    } catch (err) {
      if (!mountedRef.current || tokenRef.current !== sessionToken) return;
      watchlistRef.current = previous;
      setWatchlist(previous);
      setError(err?.response?.data?.message || 'Could not save the watchlist. Try again.');
    } finally {
      if (tokenRef.current === sessionToken) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { watchlist, toggle, busy, error, clearError };
}
