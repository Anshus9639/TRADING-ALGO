import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import { LayoutDashboard, List, CreditCard, Activity, Clock, TrendingUp } from 'lucide-react';
import CandleChart from './components/CandleChart';
import axios from 'axios';

const socket = io('http://localhost:5000');

function App() {
  // --- 1. STATE HOOKS (Must be inside App and at the top) ---
  const [activeSymbol, setActiveSymbol] = useState('BTCUSDT');
  const [watchlist, setWatchlist] = useState({
    BTCUSDT: { price: '0', change: '0' },
    ETHUSDT: { price: '0', change: '0' },
    SOLUSDT: { price: '0', change: '0' },
    BNBUSDT: { price: '0', change: '0' }
  });
  const [history, setHistory] = useState([]);
  const [latestCandle, setLatestCandle] = useState(null);
  const [balance, setBalance] = useState(10000);
  const [trades, setTrades] = useState([]); 
  const [positions, setPositions] = useState([]); // Tracks active buys for PnL

  // --- 2. HELPER FUNCTIONS ---
  const calculatePnL = (symbol) => {
    // Find the most recent buy position for this symbol
    const position = positions.find(p => p.symbol === symbol);
    if (!position || watchlist[symbol].price === '0') return "0.00";
    
    const currentPrice = parseFloat(watchlist[symbol].price);
    const pnl = (currentPrice - position.entryPrice) * position.quantity;
    return pnl.toFixed(2);
  };

  // --- 3. EFFECTS ---
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        const res = await axios.get(`http://localhost:5000/api/history/${activeSymbol}`);
        setHistory(res.data);
      } catch (err) { console.error("History fetch failed"); }
    };
    fetchHistory();
  }, [activeSymbol]);

  useEffect(() => {
    socket.on('marketUpdate', (update) => {
      setWatchlist(prev => ({ ...prev, [update.symbol]: update }));
    });

    socket.on('candleUpdate', (candle) => {
      if (candle.symbol === activeSymbol) {
        setLatestCandle(candle);
      }
    });

    return () => socket.off();
  }, [activeSymbol]);

  // --- 4. EVENT HANDLERS ---
  const handleTrade = async (type) => {
    const price = watchlist[activeSymbol].price;
    const qtyInput = document.getElementById('tradeQty')?.value || 0.01;
    const quantity = parseFloat(qtyInput);

    try {
      // Logic for local simulation
      const newTrade = {
        id: Date.now(),
        symbol: activeSymbol,
        type,
        price,
        time: new Date().toLocaleTimeString(),
        status: 'Filled'
      };

      setTrades(prev => [newTrade, ...prev]);
      
      if (type === 'BUY') {
        // Record position to calculate PnL
        setPositions(prev => [{ symbol: activeSymbol, entryPrice: parseFloat(price), quantity }, ...prev]);
        setBalance(prev => prev - (parseFloat(price) * quantity));
      } else {
        // Simple sell logic: remove position and add to balance
        setBalance(prev => prev + (parseFloat(price) * quantity));
        setPositions(prev => prev.filter(p => p.symbol !== activeSymbol));
      }

      // Optional: Sync with backend
      await axios.post('http://localhost:5000/api/trade', { symbol: activeSymbol, type, quantity, price });

    } catch (err) {
      console.error("Trade failed");
    }
  };

  // --- 5. RENDER UI ---
  return (
    <div className="flex h-screen bg-[#0b0e11] text-[#eaecef]">
      {/* Sidebar */}
      <aside className="w-20 border-r border-gray-800 flex flex-col items-center py-6 gap-8 bg-[#161a1e]">
        <div className="text-yellow-500 font-bold text-2xl">N</div>
        <LayoutDashboard className="text-yellow-500 cursor-pointer" />
        <Activity className="text-gray-500 hover:text-white cursor-pointer" />
      </aside>

      <main className="flex-1 p-4 space-y-4 overflow-y-auto">
        {/* Watchlist Row */}
        <div className="grid grid-cols-4 gap-4">
          {Object.keys(watchlist).map(sym => (
            <div 
              key={sym}
              onClick={() => { setHistory([]); setActiveSymbol(sym); }}
              className={`p-4 rounded-lg border cursor-pointer transition-all ${
                activeSymbol === sym ? 'border-yellow-500 bg-[#1e2329]' : 'border-gray-800 bg-[#161a1e]'
              }`}
            >
              <p className="text-[10px] text-gray-400 font-bold uppercase">{sym}</p>
              <div className="flex justify-between items-end">
                <span className="text-lg font-mono font-bold">${watchlist[sym].price}</span>
                <span className={`text-xs ${watchlist[sym].change >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {watchlist[sym].change}%
                </span>
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-12 gap-4">
          {/* Main Chart Area */}
          <div className="col-span-9 bg-[#161a1e] rounded-xl border border-gray-800 p-4">
             <div className="flex justify-between items-center mb-4">
               <h2 className="font-bold text-lg">{activeSymbol} / USDT</h2>
               <div className="flex gap-2 text-xs">
                 <span className="text-yellow-500 border border-yellow-500/30 px-2 py-0.5 rounded">Live</span>
                 <span className="text-gray-500 px-2 py-0.5">1m Interval</span>
               </div>
             </div>
             <div className="h-[450px]">
                {history.length > 0 ? (
                  <CandleChart initialData={history} candleData={latestCandle} />
                ) : (
                  <div className="h-full flex items-center justify-center text-gray-600 animate-pulse font-mono">
                    LOADING MARKET DATA...
                  </div>
                )}
             </div>
          </div>

          {/* Right Panel */}
          <div className="col-span-3 space-y-4">
            {/* Wallet Card */}
            <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800">
               <div className="flex justify-between items-center mb-2">
                 <p className="text-gray-400 text-xs uppercase tracking-wider">Wallet Balance</p>
                 <CreditCard size={14} className="text-gray-500" />
               </div>
               <h3 className="text-2xl font-mono text-green-400 font-bold">${balance.toLocaleString(undefined, {minimumFractionDigits: 2})}</h3>
            </div>

            {/* PnL Card (Newly Integrated) */}
            <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800">
              <div className="flex justify-between items-center mb-2">
                <p className="text-gray-400 text-xs uppercase tracking-wider">Open PnL</p>
                <TrendingUp size={14} className="text-gray-500" />
              </div>
              <h3 className={`text-2xl font-mono font-bold ${parseFloat(calculatePnL(activeSymbol)) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {parseFloat(calculatePnL(activeSymbol)) >= 0 ? '+' : ''}${calculatePnL(activeSymbol)}
              </h3>
              <p className="text-[10px] text-gray-500 mt-1 uppercase">Active Symbol: {activeSymbol}</p>
            </div>
            
            {/* Order Panel */}
            <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800 space-y-4">
              <h4 className="text-sm font-bold border-b border-gray-800 pb-2">Quick Order</h4>
              <input id="tradeQty" type="number" placeholder="Quantity" defaultValue="0.01" step="0.01" className="w-full bg-[#0b0e11] border border-gray-700 p-3 rounded text-sm focus:border-yellow-500 outline-none transition-all" />
              <div className="flex gap-2">
                <button onClick={() => handleTrade('BUY')} className="flex-1 bg-green-600 hover:bg-green-500 py-3 rounded font-bold text-sm transition-colors text-white">BUY</button>
                <button onClick={() => handleTrade('SELL')} className="flex-1 bg-red-600 hover:bg-red-500 py-3 rounded font-bold text-sm transition-colors text-white">SELL</button>
              </div>
            </div>

            {/* Trade Log */}
            <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800">
              <h4 className="text-sm font-bold mb-4 flex items-center gap-2"><Clock size={14}/> Recent Activity</h4>
              <div className="space-y-3 max-h-40 overflow-y-auto pr-2">
                {trades.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">No trades yet</p>
                ) : trades.map(trade => (
                  <div key={trade.id} className="flex justify-between items-center text-xs border-b border-gray-800/50 pb-2">
                    <span className={trade.type === 'BUY' ? 'text-green-500' : 'text-red-500'}>{trade.type}</span>
                    <div className="text-right">
                      <p className="font-mono text-gray-300">${trade.price}</p>
                      <p className="text-[10px] text-gray-500">{trade.time}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;