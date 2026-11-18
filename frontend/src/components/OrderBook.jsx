import React from 'react';
import { formatPrice } from '../lib/marketFormat.mjs';

function levelPrice(level) {
  const value = Number(level && level[0]);
  return Number.isFinite(value) ? formatPrice(value) : '—';
}

function levelAmount(level) {
  const value = Number(level && level[1]);
  return Number.isFinite(value) ? value.toFixed(4) : '—';
}

const OrderBook = ({ data }) => {
  if (!data) {
    return (
      <p className="p-4 text-center font-mono text-[11px] italic text-ink-muted">
        Waiting for market depth…
      </p>
    );
  }

  const asks = Array.isArray(data.asks) ? data.asks : [];
  const bids = Array.isArray(data.bids) ? data.bids : [];
  const bestAsk = Number(asks[0] && asks[0][0]);
  const bestBid = Number(bids[0] && bids[0][0]);
  const spread = Number.isFinite(bestAsk) && Number.isFinite(bestBid) ? bestAsk - bestBid : null;

  return (
    <div className="font-mono text-[11px]">
      <div className="mb-1 grid grid-cols-2 gap-2 border-b border-line-subtle pb-1 text-[10px] uppercase tracking-wider text-ink-muted">
        <span>Price (USDT)</span>
        <span className="text-right">Amount</span>
      </div>

      <div className="mb-3 flex flex-col-reverse gap-y-0.5">
        {asks.length > 0 ? asks.map((ask, index) => (
          <div
            key={`ask-${index}`}
            className="flex justify-between rounded px-1 text-negative transition-colors hover:bg-negative/10"
          >
            <span className="metric">{levelPrice(ask)}</span>
            <span className="metric">{levelAmount(ask)}</span>
          </div>
        )) : <p className="text-ink-muted">No asks</p>}
      </div>

      {spread !== null && (
        <div className="my-2 rounded border-y border-line-subtle/60 bg-panel-2/40 py-1.5 text-center text-ink-secondary">
          <span className="mr-2 text-[10px] uppercase tracking-wider text-ink-muted">Spread</span>
          <span className="metric">{formatPrice(spread)}</span>
        </div>
      )}

      <div className="space-y-0.5">
        {bids.length > 0 ? bids.map((bid, index) => (
          <div
            key={`bid-${index}`}
            className="flex justify-between rounded px-1 text-positive transition-colors hover:bg-positive/10"
          >
            <span className="metric">{levelPrice(bid)}</span>
            <span className="metric">{levelAmount(bid)}</span>
          </div>
        )) : <p className="text-ink-muted">No bids</p>}
      </div>
    </div>
  );
};

export default OrderBook;
