import React, { useMemo, useState } from 'react';
import { Search, Star, X } from 'lucide-react';
import { filterMarkets, formatPercent, formatPrice, resolveQuote } from '../lib/marketFormat.mjs';

function StarButton({ symbol, starred, onToggle, disabled }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(symbol)}
      disabled={disabled}
      aria-label={starred ? `Remove ${symbol} from watchlist` : `Add ${symbol} to watchlist`}
      aria-pressed={starred}
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${
        starred ? 'text-amber hover:bg-amber/10' : 'text-ink-muted hover:bg-panel-2 hover:text-ink-secondary'
      }`}
    >
      <Star size={14} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
    </button>
  );
}

function MarketRow({ market, quote, active, starred, onSelect, onToggle, busy }) {
  const changeDown = quote && Number.isFinite(quote.changePercent) && quote.changePercent < 0;
  return (
    <div
      className={`flex items-center gap-1 rounded-lg border px-2 py-1.5 transition-colors ${
        active ? 'border-violet/40 bg-violet/10' : 'border-transparent hover:bg-panel-2/70'
      }`}
    >
      <button
        type="button"
        onClick={() => onSelect(market.symbol)}
        aria-current={active ? 'true' : undefined}
        className="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1 py-0.5 text-left"
      >
        <span className="min-w-0">
          <span className="block truncate font-mono text-xs font-semibold text-ink-primary">
            {market.baseAsset}<span className="text-ink-muted">/{market.quoteAsset}</span>
          </span>
          <span className="block truncate font-mono text-[10px] text-ink-muted">{market.symbol}</span>
        </span>
        <span className="shrink-0 text-right">
          <span className="metric block text-xs text-ink-primary">
            {quote ? formatPrice(quote.price) : '—'}
          </span>
          <span className={`metric block text-[10px] ${changeDown ? 'text-negative' : 'text-positive'}`}>
            {quote ? formatPercent(quote.changePercent) : 'Vol —'}
          </span>
        </span>
      </button>
      <StarButton symbol={market.symbol} starred={starred} onToggle={onToggle} disabled={busy} />
    </div>
  );
}

export default function MarketNavigator({
  markets,
  quotes,
  activeSymbol,
  onSelect,
  watchlist,
  onToggleWatchlist,
  watchlistBusy,
  catalogueMeta,
  onClose
}) {
  const [query, setQuery] = useState('');
  const term = query.trim().toUpperCase();
  const starred = useMemo(() => new Set(watchlist), [watchlist]);

  const pinned = useMemo(
    () => filterMarkets(markets, term).filter(market => starred.has(market.symbol)),
    [markets, term, starred]
  );
  const rest = useMemo(
    () => filterMarkets(markets, term).filter(market => !starred.has(market.symbol)),
    [markets, term, starred]
  );

  const handleSelect = symbol => {
    onSelect(symbol);
    if (onClose) onClose();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Market navigator</p>
          <p className="font-display text-sm font-semibold">Tradeable universe</p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close market navigator"
            className="rounded-md p-1.5 text-ink-muted hover:bg-panel-2 hover:text-ink-primary"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className="border-b border-line-subtle/70 px-3 py-2.5">
        <label className="relative block">
          <span className="sr-only">Search markets</span>
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-muted" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="Search BTC, SOL, ETH…"
            className="control w-full py-1.5 pl-8 text-xs"
          />
        </label>
        <p className="mt-2 flex items-center justify-between font-mono text-[10px] text-ink-muted">
          <span>{markets.length} pairs</span>
          <span>{catalogueMeta && catalogueMeta.stale ? 'cached snapshot' : 'live catalogue'}</span>
        </p>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {pinned.length > 0 && (
          <section aria-label="Watchlist">
            <h3 className="eyebrow mb-1.5">Watchlist</h3>
            <div className="space-y-1">
              {pinned.map(market => (
                <MarketRow
                  key={market.symbol}
                  market={market}
                  quote={resolveQuote(market, quotes)}
                  active={market.symbol === activeSymbol}
                  starred
                  onSelect={handleSelect}
                  onToggle={onToggleWatchlist}
                  busy={watchlistBusy}
                />
              ))}
            </div>
          </section>
        )}

        <section aria-label="All markets">
          <h3 className="eyebrow mb-1.5">{pinned.length > 0 ? 'All markets' : 'Markets'}</h3>
          <div className="space-y-1">
            {rest.map(market => (
              <MarketRow
                key={market.symbol}
                market={market}
                quote={resolveQuote(market, quotes)}
                active={market.symbol === activeSymbol}
                starred={false}
                onSelect={handleSelect}
                onToggle={onToggleWatchlist}
                busy={watchlistBusy}
              />
            ))}
          </div>
          {rest.length === 0 && pinned.length === 0 && (
            <p className="px-2 py-6 text-center font-mono text-xs text-ink-muted">No markets match “{query}”.</p>
          )}
        </section>
      </div>
    </div>
  );
}
