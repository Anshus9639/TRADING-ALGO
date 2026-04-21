import React, { useState } from 'react';
import axios from 'axios';

const QuickOrder = ({ activeSymbol, currentPrice, token, onTradeComplete }) => {
  const [quantity, setQuantity] = useState(0.1);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null); // <--- Replaces the popup alerts!

  const handleTrade = async (type) => {
    setMessage(null); // Clear old messages

    // Safety Checks
    if (!token) return setMessage({ text: "Error: Please log in.", type: "error" });
    if (quantity <= 0) return setMessage({ text: "Error: Quantity must be > 0.", type: "error" });
    if (!currentPrice) return setMessage({ text: "Error: Waiting for live price...", type: "error" });

    setLoading(true);
    try {
      const endpoint = type === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
      
      const res = await axios.post(
        `https://trading-algo-nqud.onrender.com${endpoint}`, 
        {
          symbol: activeSymbol,
          quantity: Number(quantity),
          price: Number(currentPrice)
        },
        { headers: { 'x-auth-token': token } }
      );

      // Success! Show inline message
      setMessage({ text: `Success: ${type} ${quantity} ${activeSymbol}`, type: "success" });
      
      // Update Dashboard UI
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
      <h4 className="text-sm font-bold border-b border-gray-800 pb-2">Quick Order</h4>
      
      {/* Dynamic Message Box (No more popups!) */}
      {message && (
        <div className={`p-2 rounded text-xs font-bold text-center ${message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          {message.text}
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

      {/* Action Buttons */}
      <div className="flex gap-2">
        <button 
          onClick={() => handleTrade('BUY')}
          disabled={loading}
          className="flex-1 bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Processing...' : 'BUY'}
        </button>
        <button 
          onClick={() => handleTrade('SELL')}
          disabled={loading}
          className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Processing...' : 'SELL'}
        </button>
      </div>
    </div>
  );
};

export default QuickOrder;