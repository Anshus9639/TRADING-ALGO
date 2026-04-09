import React from 'react';

const OrderBook = ({ data }) => {
  // 1. Check if data exists at all
  if (!data) {
    return <div className="text-gray-600 text-xs p-4 italic text-center">Waiting for market depth...</div>;
  }

  // 2. Ensure asks and bids are arrays before mapping
  // This prevents the ".map is not a function" error
  const asks = Array.isArray(data.asks) ? data.asks : [];
  const bids = Array.isArray(data.bids) ? data.bids : [];

  return (
    <div className="text-[11px] font-mono">
      <div className="grid grid-cols-2 gap-2 mb-2 text-gray-500 uppercase tracking-tighter border-b border-gray-800 pb-1">
        <span>Price (USDT)</span>
        <span className="text-right">Amount</span>
      </div>

      {/* ASKS (Sells) - Red */}
      <div className="flex flex-col-reverse space-y-reverse space-y-1 mb-4">
        {asks.length > 0 ? asks.map((ask, i) => (
          <div key={i} className="flex justify-between text-red-400 hover:bg-red-500/10 px-1 rounded transition-colors">
            <span>{parseFloat(ask[0]).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            <span>{parseFloat(ask[1]).toFixed(4)}</span>
          </div>
        )) : <div className="text-gray-700 italic">No asks</div>}
      </div>

      {/* SPREAD Calculation */}
      {asks.length > 0 && bids.length > 0 && (
        <div className="py-2 border-y border-gray-800/50 text-center text-gray-400 my-2 bg-gray-900/30 rounded">
          <span className="text-[10px] text-gray-600 mr-2 uppercase">Spread:</span>
          {(parseFloat(asks[0][0]) - parseFloat(bids[0][0])).toFixed(2)}
        </div>
      )}

      {/* BIDS (Buys) - Green */}
      <div className="space-y-1">
        {bids.length > 0 ? bids.map((bid, i) => (
          <div key={i} className="flex justify-between text-green-400 hover:bg-green-500/10 px-1 rounded transition-colors">
            <span>{parseFloat(bid[0]).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            <span>{parseFloat(bid[1]).toFixed(4)}</span>
          </div>
        )) : <div className="text-gray-700 italic">No bids</div>}
      </div>
    </div>
  );
};

export default OrderBook;