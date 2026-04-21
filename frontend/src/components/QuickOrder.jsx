import React, { useState, useEffect } from 'react';
import axios from 'axios';

const QuickOrder = ({ activeSymbol, currentPrice, token, onTradeComplete }) => {
  const [orderType, setOrderType] = useState('MARKET'); // 🚀 New: Tracks Market vs Limit
  const [quantity, setQuantity] = useState(0.1);
  const [limitPrice, setLimitPrice] = useState(''); // 🚀 New: Tracks target price
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null); 

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
    if (orderType === 'MARKET' && !currentPrice) return setMessage({ text: "Error: Waiting for live price...", type: "error" });
    if (orderType === 'LIMIT' && (!limitPrice || limitPrice <= 0)) return setMessage({ text: "Error: Enter a valid target price.", type: "error" });

    setLoading(true);
    try {
      let endpoint = '';
      let payload = { symbol: activeSymbol, quantity: Number(quantity) };

      // 🚀 Route the data based on Market vs Limit
      if (orderType === 'MARKET') {
        endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
        payload.price = Number(currentPrice);
      } else {
        endpoint = '/api/trade/limit'; // Routes to your Escrow system
        payload.type = side; // 'BUY' or 'SELL'
        payload.limitPrice = Number(limitPrice);
      }

      const res = await axios.post(
        `https://trading-algo-nqud.onrender.com${endpoint}`, 
        payload,
        { headers: { 'x-auth-token': token } }
      );

      // Success! Show inline message
      const successText = orderType === 'LIMIT' 
        ? `Success: ${side} Limit placed at $${payload.limitPrice}` 
        : `Success: ${side} ${quantity} ${activeSymbol}`;
      
      setMessage({ text: successText, type: "success" });
      
      // Update Dashboard UI (Wallet, Portfolio, Trades)
      if (onTradeComplete) {
        onTradeComplete(res.data.balance, res.data.portfolio, res.data.newTrade); 
      }
      
    } catch (err) {
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