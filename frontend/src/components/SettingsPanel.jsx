import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { normalizeSymbolList } from '../lib/marketFormat.mjs';

export default function SettingsPanel({
  catalogue,
  watchlist,
  markets,
  onToggleWatchlist,
  watchlistBusy,
  watchlistError,
  streamStatus,
  onLogout
}) {
  const [selected, setSelected] = useState('');
  const addable = markets.filter(market => !watchlist.includes(market.symbol));

  const handleAdd = () => {
    if (!selected) return;
    onToggleWatchlist(selected);
    setSelected('');
  };

  return (
    <div className="space-y-3">
      <div className="panel overflow-hidden">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Preferences</p>
            <h2 className="font-display text-sm font-semibold">Watchlist</h2>
          </div>
          <span className="font-mono text-[10px] text-ink-muted">{watchlist.length} / 25</span>
        </div>

        <div className="space-y-3 p-4">
          <div className="flex flex-wrap gap-2">
            {normalizeSymbolList(watchlist).map(symbol => (
              <span
                key={symbol}
                className="inline-flex items-center gap-1 rounded-full border border-line-subtle bg-panel-2 px-2.5 py-1 font-mono text-[11px]"
              >
                {symbol}
                <button
                  type="button"
                  onClick={() => onToggleWatchlist(symbol)}
                  disabled={watchlistBusy}
                  aria-label={`Remove ${symbol} from watchlist`}
                  className="text-ink-muted transition-colors hover:text-negative disabled:opacity-40"
                >
                  <Trash2 size={12} aria-hidden="true" />
                </button>
              </span>
            ))}
            {watchlist.length === 0 && (
              <p className="font-mono text-xs text-ink-muted">No pinned markets yet.</p>
            )}
          </div>

          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="block flex-1">
              <span className="sr-only">Add a market to the watchlist</span>
              <select
                value={selected}
                onChange={event => setSelected(event.target.value)}
                className="control w-full text-xs"
              >
                <option value="">Select a market…</option>
                {addable.map(market => (
                  <option key={market.symbol} value={market.symbol}>{market.symbol}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!selected || watchlistBusy}
              className="rounded-lg border border-cyan/30 bg-cyan/10 px-4 py-2 text-xs font-semibold text-aqua transition-colors hover:border-cyan/60 disabled:opacity-40"
            >
              Add
            </button>
          </div>

          {watchlistError && (
            <p role="alert" className="rounded-md border border-negative/25 bg-negative/10 px-3 py-2 text-xs text-negative">
              {watchlistError}
            </p>
          )}
        </div>
      </div>

      <div className="panel p-4">
        <p className="eyebrow">Data sources</p>
        <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
          <div className="flex justify-between gap-3 rounded-lg bg-panel-2/60 px-3 py-2">
            <dt className="text-ink-muted">Catalogue</dt>
            <dd className="font-mono">{catalogue.source} · {catalogue.symbols.length} pairs</dd>
          </div>
          <div className="flex justify-between gap-3 rounded-lg bg-panel-2/60 px-3 py-2">
            <dt className="text-ink-muted">Market stream</dt>
            <dd className="font-mono">{streamStatus}</dd>
          </div>
          <div className="flex justify-between gap-3 rounded-lg bg-panel-2/60 px-3 py-2">
            <dt className="text-ink-muted">Catalogue snapshot</dt>
            <dd className="font-mono">{catalogue.stale ? 'cached' : 'fresh'}</dd>
          </div>
          <div className="flex justify-between gap-3 rounded-lg bg-panel-2/60 px-3 py-2">
            <dt className="text-ink-muted">Last refresh</dt>
            <dd className="truncate font-mono">
              {catalogue.updatedAt ? new Date(catalogue.updatedAt).toLocaleTimeString() : '—'}
            </dd>
          </div>
        </dl>
      </div>

      <div className="panel flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-display text-sm font-semibold">Session</p>
          <p className="text-xs text-ink-muted">Sign out of this device. Open orders remain in escrow.</p>
        </div>
        <button
          type="button"
          onClick={onLogout}
          className="rounded-lg border border-negative/30 bg-negative/10 px-4 py-2 text-xs font-semibold text-negative transition-colors hover:border-negative/60"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
