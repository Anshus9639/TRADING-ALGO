import React from 'react';

const OrderBook = ({ data }) => {
  if (!data) return <div className="text-gray-600 text-xs p-4 italic">Waiting for depth data...</div>;

  return (
    <div className="text-[11px] font-mono">
      <div className="grid grid-cols-2 gap-2 mb-2 text-gray-500 uppercase tracking-tighter">
        <span>Price</span>
        <span className="text-right">Amount</span>
      </div>

      {/* ASKS (Sells) - Red */}
      <div className="space-y-1 mb-4">
        {data.asks.map((ask, i) => (
          <div key={i} className="flex justify-between text-red-400 bg-red-500/5 px-1">
            <span>{parseFloat(ask[0]).toFixed(2)}</span>
            <span>{parseFloat(ask[1]).toFixed(4)}</span>
          </div>
        ))}
      </div>

      {/* SPREAD (Difference between highest buy and lowest sell) */}
      <div className="py-2 border-y border-gray-800 text-center text-gray-400 my-2">
        Spread: {(parseFloat(data.asks[0][0]) - parseFloat(data.bids[0][0])).toFixed(2)}
      </div>

      {/* BIDS (Buys) - Green */}
      <div className="space-y-1">
        {data.bids.map((bid, i) => (
          <div key={i} className="flex justify-between text-green-400 bg-green-500/5 px-1">
            <span>{parseFloat(bid[0]).toFixed(2)}</span>
            <span>{parseFloat(bid[1]).toFixed(4)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default OrderBook;