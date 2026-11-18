import React from 'react';
import { formatUsd } from '../lib/marketFormat.mjs';

function Stat({ label, value, tone = 'text-ink-primary' }) {
  return (
    <div className="rounded-panel border border-line-subtle/70 bg-panel-2/50 px-3 py-2.5">
      <dt className="eyebrow">{label}</dt>
      <dd className={`metric mt-1 text-base ${tone}`}>{value}</dd>
    </div>
  );
}

export default function ProfilePanel({
  user,
  balance,
  lockedBalance,
  positions,
  watchlist,
  streamStatus,
  catalogue,
  onLogout,
  onOpenSettings
}) {
  const initial = (user?.username || user?.email || 'N').slice(0, 1).toUpperCase();

  return (
    <div className="space-y-3">
      <section className="panel overflow-hidden" aria-label="Account profile">
        <div className="border-b border-line-subtle bg-panel-2/40 px-4 py-5">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-violet/40 bg-violet/15 font-display text-lg font-bold text-ultraviolet">
              {initial}
            </span>
            <div className="min-w-0">
              <h1 className="truncate font-display text-lg font-semibold">{user?.username || 'Trader'}</h1>
              <p className="truncate font-mono text-xs text-ink-muted">{user?.email || '—'}</p>
            </div>
          </div>
        </div>

        <dl className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Cash balance" value={formatUsd(balance)} tone="text-positive" />
          <Stat label="Reserved" value={formatUsd(lockedBalance)} tone="text-amber" />
          <Stat label="Open positions" value={String((positions || []).length)} />
          <Stat label="Watchlist" value={`${watchlist.length} / 25`} />
          <Stat label="Market stream" value={streamStatus} />
          <Stat label="Catalogue" value={`${catalogue.source} · ${catalogue.symbols.length}`} />
          <Stat label="Snapshot" value={catalogue.stale ? 'cached' : 'fresh'} />
          <Stat
            label="Last refresh"
            value={catalogue.updatedAt ? new Date(catalogue.updatedAt).toLocaleTimeString() : '—'}
          />
        </dl>
      </section>

      <section className="panel p-4" aria-label="Safety posture">
        <p className="eyebrow">Execution posture</p>
        <ul className="mt-2 space-y-2 text-xs leading-relaxed text-ink-secondary">
          <li>Every order is validated against the live tradeable universe before it can be placed.</li>
          <li>Market and limit orders share the same escrow, idempotency, and settlement path.</li>
          <li>Copilot proposals are never executed without an explicit confirmation.</li>
        </ul>
      </section>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onOpenSettings}
          className="rounded-lg border border-cyan/30 bg-cyan/10 px-4 py-2 text-xs font-semibold text-aqua transition-colors hover:border-cyan/60"
        >
          Preferences
        </button>
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
