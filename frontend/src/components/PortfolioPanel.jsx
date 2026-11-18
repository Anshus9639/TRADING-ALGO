import React from 'react';
import { formatPrice, formatUsd, resolveQuote } from '../lib/marketFormat.mjs';

function positionValue(position, markets, quotes) {
  const market = markets.find(entry => entry.symbol === position.symbol);
  const quote = market ? resolveQuote(market, quotes) : null;
  if (!quote) return null;
  return quote.price * position.quantity;
}

export default function PortfolioPanel({ positions, markets, quotes, balance, lockedBalance }) {
  const rows = (positions || []).map(position => {
    const market = markets.find(entry => entry.symbol === position.symbol);
    const quote = market ? resolveQuote(market, quotes) : null;
    const known = position.costBasisStatus !== 'UNKNOWN' && Number.isFinite(position.avgPrice);
    const value = positionValue(position, markets, quotes);
    const pnl = known && quote
      ? (quote.price - position.avgPrice) * position.quantity
      : null;
    return { ...position, quote, known, value, pnl };
  });

  const totalValue = rows.reduce((sum, row) => (row.value === null ? sum : sum + row.value), 0);

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="panel p-4">
          <p className="eyebrow">Cash balance</p>
          <p className="metric mt-1 text-xl text-positive">{formatUsd(balance)}</p>
        </div>
        <div className="panel p-4">
          <p className="eyebrow">Reserved (limit buys)</p>
          <p className="metric mt-1 text-xl text-amber">{formatUsd(lockedBalance)}</p>
        </div>
        <div className="panel p-4">
          <p className="eyebrow">Holdings value</p>
          <p className="metric mt-1 text-xl text-ink-primary">{formatUsd(totalValue)}</p>
        </div>
      </div>

      <div className="panel overflow-hidden">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Portfolio</p>
            <h2 className="font-display text-sm font-semibold">Open positions</h2>
          </div>
          <span className="font-mono text-[10px] text-ink-muted">{rows.length} assets</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-10 text-center font-mono text-xs text-ink-muted">
            No positions yet. Use the trade panel to place your first order.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-left">
              <thead>
                <tr className="border-b border-line-subtle/70 text-[10px] uppercase tracking-wider text-ink-muted">
                  <th className="px-4 py-2 font-medium">Asset</th>
                  <th className="px-4 py-2 text-right font-medium">Quantity</th>
                  <th className="px-4 py-2 text-right font-medium">Avg entry</th>
                  <th className="px-4 py-2 text-right font-medium">Last</th>
                  <th className="px-4 py-2 text-right font-medium">Unrealized</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle/50">
                {rows.map(row => (
                  <tr key={row._id || row.symbol}>
                    <td className="px-4 py-2.5 font-mono text-xs font-semibold">{row.symbol}</td>
                    <td className="metric px-4 py-2.5 text-right text-xs">{row.quantity}</td>
                    <td className="metric px-4 py-2.5 text-right text-xs text-ink-secondary">
                      {row.known ? formatPrice(row.avgPrice) : 'N/A'}
                    </td>
                    <td className="metric px-4 py-2.5 text-right text-xs">
                      {row.quote ? formatPrice(row.quote.price) : '—'}
                    </td>
                    <td className={`metric px-4 py-2.5 text-right text-xs ${
                      row.pnl === null ? 'text-ink-muted' : row.pnl >= 0 ? 'text-positive' : 'text-negative'
                    }`}>
                      {row.pnl === null
                        ? 'Basis unknown'
                        : `${row.pnl >= 0 ? '+' : ''}${formatUsd(row.pnl)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
