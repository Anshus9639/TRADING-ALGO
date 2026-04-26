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
      const parseRes = await axios.post(
        'https://trading-algo-nqud.onrender.com/api/copilot/parse', 
        { prompt }, 
        { headers: { 'x-auth-token': token } }
      );

      const intent = parseRes.data.data;
      setLog({ text: `Agent routing ${intent.orderType} ${intent.side} for ${intent.symbol}...`, status: "loading" });

      let endpoint = '';
      let payload = { symbol: intent.symbol, quantity: Number(intent.quantity) };

      if (intent.orderType === 'LIMIT') {
        endpoint = '/api/trade/limit';
        payload.type = intent.side;
        payload.limitPrice = Number(intent.limitPrice);
      } else {
        endpoint = intent.side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
        const livePrice = parseFloat(watchlist[intent.symbol]?.price || 0);
        
        if (livePrice === 0) throw new Error(`Market price for ${intent.symbol} unavailable.`);
        payload.price = livePrice;
      }

      const execRes = await axios.post(
        `https://trading-algo-nqud.onrender.com${endpoint}`, 
        payload, 
        { headers: { 'x-auth-token': token } }
      );

      setLog({ text: `Success: ${intent.side} ${intent.quantity} ${intent.symbol} executed!`, status: "success" });
      setPrompt('');

      if (onTradeComplete) {
        onTradeComplete(execRes.data.balance, execRes.data.portfolio, execRes.data.newTrade, execRes.data.pendingOrders); 
      }

    } catch (err) {
      console.error(err);
      const errorMsg = err.response?.data?.message || err.message || "Agent failed to execute command.";
      setLog({ text: `Failed: ${errorMsg}`, status: "error" });
    } finally {
      setLoading(false);
      setTimeout(() => setLog(null), 5000); 
    }
  };

  return (
    <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800 relative overflow-hidden group">
      
      {/* --- ANIMATED BACKGROUND ELEMENTS --- */}
      {/* Purple breathing orb */}
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-purple-600/20 rounded-full blur-3xl animate-pulse pointer-events-none" />
      {/* Blue breathing orb (delayed pulse) */}
      <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-blue-600/10 rounded-full blur-3xl animate-pulse pointer-events-none" style={{ animationDelay: '1.5s' }} />
      
      {/* Static grid overlay for that "Terminal" feel */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none" />

      {/* Hover-reactive Bot Icon */}
      <div className="absolute top-2 right-2 opacity-5 group-hover:opacity-20 group-hover:scale-110 transition-all duration-700 pointer-events-none">
        <Bot size={120} className="text-purple-400" />
      </div>
      {/* ------------------------------------ */}

      <h4 className="text-xs font-bold mb-3 flex items-center gap-2 text-purple-400 uppercase tracking-wider relative z-10">
        <Sparkles size={14} className="animate-pulse" /> Bruda Bot
      </h4>

      <form onSubmit={handleCommand} className="relative z-10">
        <div className="flex bg-[#0b0e11]/80 backdrop-blur-sm rounded border border-gray-800 focus-within:border-purple-500 transition-colors shadow-inner">
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
            className="p-3 text-gray-500 hover:text-purple-400 transition-all disabled:opacity-50 hover:scale-110"
          >
            <Send size={18} />
          </button>
        </div>
      </form>

      {/* Dynamic Status Log */}
      {log && (
        <div className={`relative z-10 mt-3 text-[10px] font-mono font-bold px-2 py-1.5 rounded animate-pulse shadow-lg ${
          log.status === 'success' ? 'text-green-400 bg-green-500/10 border border-green-500/20' : 
          log.status === 'error' ? 'text-red-400 bg-red-500/10 border border-red-500/20' : 
          'text-purple-400 bg-purple-500/10 border border-purple-500/20'
        }`}>
          > {log.text}
        </div>
      )}
    </div>
  );
};

export default AICopilot;