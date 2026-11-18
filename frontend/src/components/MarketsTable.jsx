import React from 'react';
import { Star } from 'lucide-react';
import { formatPercent, formatPrice, formatVolume, resolveQuote } from '../lib/marketFormat.mjs';

export default function MarketsTable({
  markets,
  quotes,
  watchlist,
  activeSymbol,
  onSelect,
  onToggleWatchlist,
  watchlistBusy
}) {
  return (
    <div className="panel overflow-hidden">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Catalogue</p>
          <h2 className="font-display text-sm font-semibold">USDT spot markets</h2>
        </div>
        <span className="font-mono text-[10px] text-ink-muted">{markets.length} pairs</span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left">
          <thead>
            <tr className="border-b border-line-subtle/70 text-[10px] uppercase tracking-wider text-ink-muted">
              <th className="px-3 py-2 font-medium">Pair</th>
              <th className="px-3 py-2 text-right font-medium">Last</th>
              <th className="px-3 py-2 text-right font-medium">24h</th>
              <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Volume</th>
              <th className="hidden px-3 py-2 font-medium sm:table-cell">Status</th>
              <th className="px-3 py-2 text-right font-medium">Watch</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-subtle/50">
            {markets.map(market => {
              const quote = resolveQuote(market, quotes);
              const starred = watchlist.includes(market.symbol);
              const down = quote && Number.isFinite(quote.changePercent) && quote.changePercent < 0;
              const active = market.symbol === activeSymbol;
              return (
                <tr key={market.symbol} className={`transition-colors hover:bg-panel-2/60 ${active ? 'bg-violet/5' : ''}`}>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      onClick={() => onSelect(market.symbol)}
                      className="flex flex-col items-start text-left"
                    >
                      <span className="font-mono text-xs font-semibold text-ink-primary">
                        {market.baseAsset}<span className="text-ink-muted">/{market.quoteAsset}</span>
                      </span>
                      <span className="font-mono text-[10px] text-ink-muted">{market.symbol}</span>
                    </button>
                  </td>
                  <td className="metric px-3 py-2 text-right text-xs">{quote ? formatPrice(quote.price) : '—'}</td>
                  <td className={`metric px-3 py-2 text-right text-xs ${down ? 'text-negative' : 'text-positive'}`}>
                    {quote ? formatPercent(quote.changePercent) : '—'}
                  </td>
                  <td className="metric hidden px-3 py-2 text-right text-xs text-ink-secondary sm:table-cell">
                    {quote ? formatVolume(quote.quoteVolume) : '—'}
                  </td>
                  <td className="hidden px-3 py-2 sm:table-cell">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                      market.status === 'TRADING'
                        ? 'border-positive/25 bg-positive/10 text-positive'
                        : 'border-amber/25 bg-amber/10 text-amber'
                    }`}>
                      {market.status === 'TRADING' ? 'Trading' : 'Snapshot'}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => onToggleWatchlist(market.symbol)}
                      disabled={watchlistBusy}
                      aria-label={starred ? `Remove ${market.symbol} from watchlist` : `Add ${market.symbol} to watchlist`}
                      aria-pressed={starred}
                      className={`rounded-md p-1.5 transition-colors disabled:opacity-40 ${
                        starred ? 'text-amber hover:bg-amber/10' : 'text-ink-muted hover:bg-panel-2 hover:text-ink-secondary'
                      }`}
                    >
                      <Star size={14} fill={starred ? 'currentColor' : 'none'} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
