import React from 'react';
import { formatPercent, formatPrice, resolveQuote } from '../lib/marketFormat.mjs';

export default function TickerStrip({ markets, quotes, activeSymbol, onSelect }) {
  if (!markets || markets.length === 0) return null;

  return (
    <div className="shrink-0 border-b border-line-subtle/70 bg-void/60 xl:hidden">
      <div className="no-scrollbar flex gap-2 overflow-x-auto px-3 py-2">
        {markets.map(market => {
          const quote = resolveQuote(market, quotes);
          const active = market.symbol === activeSymbol;
          const down = quote && Number.isFinite(quote.changePercent) && quote.changePercent < 0;
          return (
            <button
              key={market.symbol}
              type="button"
              onClick={() => onSelect(market.symbol)}
              aria-pressed={active}
              className={`flex shrink-0 items-baseline gap-2 rounded-lg border px-2.5 py-1.5 transition-colors ${
                active
                  ? 'border-violet/50 bg-violet/10'
                  : 'border-line-subtle bg-panel-1/70 hover:border-line-strong'
              }`}
            >
              <span className="font-mono text-[11px] font-semibold text-ink-primary">
                {market.symbol.replace('USDT', '')}
              </span>
              <span className="metric text-[11px] text-ink-secondary">
                {quote ? formatPrice(quote.price) : '—'}
              </span>
              <span className={`metric text-[10px] ${down ? 'text-negative' : 'text-positive'}`}>
                {quote ? formatPercent(quote.changePercent) : '—'}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
