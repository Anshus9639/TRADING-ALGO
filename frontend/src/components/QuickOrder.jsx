import React, { useState, useEffect, useRef } from 'react';
import { api, authHeaders } from '../lib/api';
import { createClientOrderId } from '../lib/orderId.mjs';

const QuickOrder = ({ activeSymbol, currentPrice, token, onTradeComplete }) => {
  const [orderType, setOrderType] = useState('MARKET'); // 🚀 New: Tracks Market vs Limit
  const [quantity, setQuantity] = useState(0.1);
  const [limitPrice, setLimitPrice] = useState(''); // 🚀 New: Tracks target price
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null); 
  // Keyed per submission so a retry of an unresolved order reuses its original
  // idempotency key, and a different order cannot overwrite that identity.
  const pendingSubmissions = useRef(new Map());

  // 🚀 Auto-fill limit price with the current live price when switching to LIMIT tab
  useEffect(() => {
    if (orderType === 'LIMIT' && !limitPrice && currentPrice) {
      setLimitPrice(currentPrice);
    }
  }, [orderType, currentPrice, limitPrice]);

  const handleTrade = async (side) => {
    setMessage(null); // Clear old messages

    // Safety Checks
    if (!token) return setMessage({ text: "Error: Please log in.", type: "error" });
    if (quantity <= 0) return setMessage({ text: "Error: Quantity must be > 0.", type: "error" });
    if (orderType === 'LIMIT' && (!limitPrice || limitPrice <= 0)) return setMessage({ text: "Error: Enter a valid target price.", type: "error" });

    setLoading(true);
    let requestKey = null;
    try {
      let endpoint = '';
      const numericQuantity = Number(quantity);
      const numericLimitPrice = Number(limitPrice);
      const payload = { symbol: activeSymbol, quantity: numericQuantity };

      // 🚀 Route the data based on Market vs Limit
      if (orderType === 'MARKET') {
        endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
      } else {
        endpoint = '/api/trade/limit'; // Routes to your Escrow system
        payload.type = side; // 'BUY' or 'SELL'
        payload.limitPrice = numericLimitPrice;
      }

      requestKey = [
        endpoint,
        side,
        activeSymbol,
        numericQuantity,
        orderType === 'LIMIT' ? numericLimitPrice : 'MARKET'
      ].join('|');
      const pending = pendingSubmissions.current.get(requestKey);      if (pending) {
        payload.clientOrderId = pending;
      } else {
        payload.clientOrderId = createClientOrderId();
        pendingSubmissions.current.set(requestKey, payload.clientOrderId);
      }

      const res = await api.post(endpoint, payload, authHeaders(token));
      pendingSubmissions.current.delete(requestKey);

      // Success! Show inline message
      const successText = orderType === 'LIMIT' 
        ? `Success: ${side} Limit placed at $${payload.limitPrice}` 
        : `Success: ${side} ${quantity} ${activeSymbol} @ $${Number(res.data.executedPrice).toFixed(2)}`;
      
      setMessage({ text: successText, type: "success" });
      
      // Update Dashboard UI (Wallet, Portfolio, Trades)
      if (onTradeComplete) {
        onTradeComplete(res.data.balance, res.data.portfolio, res.data.newTrade, res.data.pendingOrders); 
      }
      
    } catch (err) {
      // A definite 4xx/5xx answer below 500 (other than 408) proves the server
      // rejected the request, so its key can be retired. Network failures,
      // timeouts and 5xx responses are uncertain and keep the key so a retry
      // replays the same order instead of placing a duplicate.
      const status = err.response?.status;
      if (requestKey && status && status < 500 && status !== 408) {
        pendingSubmissions.current.delete(requestKey);
      }
      // Error! Show inline message
      const errorMsg = err.response?.data?.message || "Trade failed due to server error.";
      setMessage({ text: `Rejected: ${errorMsg}`, type: "error" });
    } finally {
      setLoading(false);
      // Auto-hide the message after 3 seconds
      setTimeout(() => setMessage(null), 3000);
    }
  };

  return (
    <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800 space-y-4">
      {/* Header & Toggle */}
      <div className="flex justify-between items-center border-b border-gray-800 pb-2">
        <h4 className="text-sm font-bold">Quick Order</h4>
        <div className="flex bg-[#0b0e11] rounded p-0.5 border border-gray-700">
          <button 
            onClick={() => setOrderType('MARKET')}
            className={`text-[10px] px-3 py-1 rounded uppercase font-bold transition-all ${orderType === 'MARKET' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Market
          </button>
          <button 
            onClick={() => setOrderType('LIMIT')}
            className={`text-[10px] px-3 py-1 rounded uppercase font-bold transition-all ${orderType === 'LIMIT' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Limit
          </button>
        </div>
      </div>
      
      {/* Dynamic Message Box */}
      {message && (
        <div className={`p-2 rounded text-xs font-bold text-center ${message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          {message.text}
        </div>
      )}

      <div className="space-y-3">
        {/* Conditional Target Price Input (Only shows if LIMIT is selected) */}
        {orderType === 'LIMIT' && (
          <div>
            <label className="text-gray-400 text-xs mb-1 block">Target Price (USDT)</label>
            <input 
              type="number" 
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              step="0.01"
              min="0.01"
              className="w-full bg-[#0b0e11] text-white p-3 rounded border border-gray-700 outline-none focus:border-yellow-500 transition-colors text-sm"
            />
          </div>
        )}

        {/* Quantity Input */}
        <div>
          <label className="text-gray-400 text-xs mb-1 block">Amount ({activeSymbol?.replace('USDT', '')})</label>
          <input 
            type="number" 
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            step="0.01"
            min="0.01"
            className="w-full bg-[#0b0e11] text-white p-3 rounded border border-gray-700 outline-none focus:border-yellow-500 transition-colors text-sm"
          />
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2">
        <button 
          onClick={() => handleTrade('BUY')}
          disabled={loading}
          className="flex-1 bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Processing...' : (orderType === 'LIMIT' ? 'LIMIT BUY' : 'MARKET BUY')}
        </button>
        <button 
          onClick={() => handleTrade('SELL')}
          disabled={loading}
          className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Processing...' : (orderType === 'LIMIT' ? 'LIMIT SELL' : 'MARKET SELL')}
        </button>
      </div>
    </div>
  );
};

export default QuickOrder;