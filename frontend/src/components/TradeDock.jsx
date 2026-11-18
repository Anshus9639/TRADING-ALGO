import React from 'react';
import AICopilot from './AICopilot';
import QuickOrder from './QuickOrder';
import OrderBook from './OrderBook';

export default function TradeDock({
  token,
  activeSymbol,
  currentPrice,
  market,
  quotes,
  depth,
  onTradeComplete
}) {
  return (
    <div className="space-y-3">
      <AICopilot token={token} watchlist={quotes} onTradeComplete={onTradeComplete} />
      <QuickOrder
        activeSymbol={activeSymbol}
        currentPrice={currentPrice}
        market={market}
        token={token}
        onTradeComplete={onTradeComplete}
      />
      <section className="panel p-4" aria-label="Order book">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="eyebrow">Order book</h2>
          <span className="font-mono text-[10px] text-ink-muted">{activeSymbol}</span>
        </header>
        <OrderBook data={depth} />
      </section>
    </div>
  );
}
