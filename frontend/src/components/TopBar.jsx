import React from 'react';
import { Menu, PanelRight, User, Wifi, WifiOff, Loader2 } from 'lucide-react';
import { formatPercent, formatPrice } from '../lib/marketFormat.mjs';

function StreamBadge({ status }) {
  const base = 'inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-wider';

  if (status === 'live') {
    return (
      <span className={`${base} border-positive/25 bg-positive/10 text-positive`}>
        <Wifi size={11} aria-hidden="true" />
        <span className="hidden sm:inline">Live</span>
      </span>
    );
  }
  if (status === 'connecting') {
    return (
      <span className={`${base} border-line-subtle bg-panel-2 text-ink-secondary`}>
        <Loader2 size={11} className="animate-spin" aria-hidden="true" />
        <span className="hidden sm:inline">Syncing</span>
      </span>
    );
  }
  return (
    <span className={`${base} border-amber/25 bg-amber/10 text-amber`}>
      <WifiOff size={11} aria-hidden="true" />
      <span className="hidden sm:inline">Reconnecting</span>
    </span>
  );
}

export default function TopBar({
  symbol,
  quote,
  streamStatus,
  stale,
  onOpenMarkets,
  onOpenTrade,
  onOpenProfile
}) {
  const change = quote ? quote.changePercent : null;
  const changeClass = Number.isFinite(change) && change < 0 ? 'text-negative' : 'text-positive';

  return (
    <header className="safe-top flex h-14 shrink-0 items-center gap-2 border-b border-line-subtle/80 bg-graphite/80 px-3 backdrop-blur md:gap-3 md:px-4">
      <div className="flex min-w-0 items-center gap-2 md:hidden">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-violet/40 bg-violet/15 font-display text-sm font-bold text-ultraviolet">
          N
        </span>
        <span className="hidden truncate font-display text-sm font-semibold tracking-tight sm:inline">
          NexusTrade
        </span>
      </div>

      <button
        type="button"
        onClick={onOpenMarkets}
        aria-label="Open market navigator"
        className="flex min-w-0 max-w-[136px] items-center gap-2 rounded-lg border border-line-subtle bg-panel-2/70 px-2.5 py-1.5 text-left transition-colors hover:border-line-strong xl:hidden"
      >
        <Menu size={15} className="shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="truncate font-mono text-xs font-semibold">
          {symbol.replace('USDT', '')}<span className="text-ink-muted">/USDT</span>
        </span>
      </button>

      <div className="hidden min-w-0 items-baseline gap-2 xl:flex">
        <span className="font-display text-sm font-semibold tracking-tight">
          {symbol.replace('USDT', '')}<span className="text-ink-muted">/USDT</span>
        </span>
        <span className="metric text-sm text-ink-primary">{quote ? formatPrice(quote.price) : '—'}</span>
        <span className={`metric text-xs ${changeClass}`}>{quote ? formatPercent(change) : '—'}</span>
      </div>

      <div className="ml-auto flex items-center gap-1.5 md:gap-2">
        {stale && (
          <span className="hidden rounded-full border border-amber/25 bg-amber/10 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-amber sm:inline">
            Snapshot
          </span>
        )}
        <StreamBadge status={streamStatus} />
        <button
          type="button"
          onClick={onOpenTrade}
          aria-label="Open trading panel"
          className="inline-flex items-center gap-1.5 rounded-lg border border-violet/30 bg-violet/15 px-2 py-1.5 text-xs font-semibold text-ultraviolet transition-colors hover:border-violet/60 sm:px-2.5 xl:hidden"
        >
          <PanelRight size={14} aria-hidden="true" />
          <span className="hidden sm:inline">Trade</span>
        </button>
        <button
          type="button"
          onClick={onOpenProfile}
          aria-label="Open profile"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-panel-2 hover:text-ink-primary md:hidden"
        >
          <User size={18} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
