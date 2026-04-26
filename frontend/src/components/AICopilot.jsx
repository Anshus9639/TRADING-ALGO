import React, { useState } from 'react';
import axios from 'axios';
import { Bot, Send, Sparkles } from 'lucide-react';

const AICopilot = ({ token, watchlist, onTradeComplete }) => {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState(null);

  const handleCommand = async (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;

    setLoading(true);
    setLog({ text: "Thinking...", status: "loading" });

    try {
      // 1. Send natural text to Gemini API for parsing
      const parseRes = await axios.post(
        'https://trading-algo-nqud.onrender.com/api/copilot/parse', 
        { prompt }, 
        { headers: { 'x-auth-token': token } }
      );

      const intent = parseRes.data.data;
      setLog({ text: `Agent routing ${intent.orderType} ${intent.side} for ${intent.symbol}...`, status: "loading" });

      // 2. Prepare the execution payload
      let endpoint = '';
      let payload = { symbol: intent.symbol, quantity: Number(intent.quantity) };

      if (intent.orderType === 'LIMIT') {
        endpoint = '/api/trade/limit';
        payload.type = intent.side;
        payload.limitPrice = Number(intent.limitPrice);
      } else {
        // For MARKET orders, we need the live price from your watchlist
        endpoint = intent.side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
        const livePrice = parseFloat(watchlist[intent.symbol]?.price || 0);
        
        if (livePrice === 0) throw new Error(`Market price for ${intent.symbol} unavailable.`);
        payload.price = livePrice;
      }

      // 3. Autonomously execute the trade!
      const execRes = await axios.post(
        `https://trading-algo-nqud.onrender.com${endpoint}`, 
        payload, 
        { headers: { 'x-auth-token': token } }
      );

      setLog({ text: `Success: ${intent.side} ${intent.quantity} ${intent.symbol} executed!`, status: "success" });
      setPrompt(''); // Clear input

      // Update Dashboard UI instantly
      if (onTradeComplete) {
        onTradeComplete(execRes.data.balance, execRes.data.portfolio, execRes.data.newTrade, execRes.data.pendingOrders); 
      }

    } catch (err) {
      console.error(err);
      const errorMsg = err.response?.data?.message || err.message || "Agent failed to execute command.";
      setLog({ text: `Failed: ${errorMsg}`, status: "error" });
    } finally {
      setLoading(false);
      setTimeout(() => setLog(null), 5000); // Hide log after 5s
    }
  };

  return (
    <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800 relative overflow-hidden group">
      {/* Background glow effect */}
      <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
        <Bot size={100} className="text-purple-500" />
      </div>

      <h4 className="text-xs font-bold mb-3 flex items-center gap-2 text-purple-400 uppercase tracking-wider relative z-10">
        <Sparkles size={14} /> AI Execution Copilot
      </h4>

      <form onSubmit={handleCommand} className="relative z-10">
        <div className="flex bg-[#0b0e11] rounded border border-gray-800 focus-within:border-purple-500 transition-colors">
          <input 
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={loading}
            placeholder='e.g., "Buy 0.5 BTC if it drops to $60,000"'
            className="flex-1 bg-transparent text-sm text-white p-3 outline-none placeholder-gray-600 font-mono"
          />
          <button 
            type="submit" 
            disabled={loading || !prompt.trim()}
            className="p-3 text-gray-500 hover:text-purple-400 transition-colors disabled:opacity-50"
          >
            <Send size={18} />
          </button>
        </div>
      </form>

      {/* Dynamic Status Log */}
      {log && (
        <div className={`mt-3 text-[10px] font-mono font-bold px-2 py-1.5 rounded animate-pulse ${
          log.status === 'success' ? 'text-green-400 bg-green-500/10' : 
          log.status === 'error' ? 'text-red-400 bg-red-500/10' : 
          'text-purple-400 bg-purple-500/10'
        }`}>
           {log.text}
        </div>
      )}
    </div>
  );
};

export default AICopilot;