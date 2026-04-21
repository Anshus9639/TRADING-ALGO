import React, { useState, useEffect } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { LayoutDashboard, Activity, Clock, CreditCard, TrendingUp, LogOut } from 'lucide-react';

// Components
import Auth from './components/Auth';
import CandleChart from './components/CandleChart';
import OrderBook from './components/OrderBook';
import QuickOrder from './components/QuickOrder';

const socket = io('http://localhost:5000');

function App() {
  // --- SESSION STATES ---
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  
  // --- MARKET STATES ---
  const [activeSymbol, setActiveSymbol] = useState('BTCUSDT');
  const [watchlist, setWatchlist] = useState({
    BTCUSDT: { price: '0', change: '0' },
    ETHUSDT: { price: '0', change: '0' },
    SOLUSDT: { price: '0', change: '0' },
    BNBUSDT: { price: '0', change: '0' }
  });
  const [history, setHistory] = useState([]);
  const [latestCandle, setLatestCandle] = useState(null);
  const [orderBook, setOrderBook] = useState(null);

  // --- USER DATA STATES ---
  const [balance, setBalance] = useState(0);
  const [positions, setPositions] = useState([]); 
  const [trades, setTrades] = useState([]);

  // --- HELPER FUNCTIONS ---
  const calculatePnL = (symbol) => {
    const position = positions.find(p => p.symbol === symbol);
    if (!position || watchlist[symbol].price === '0') return "0.00";

    const currentPrice = parseFloat(watchlist[symbol].price);
    // Uses the avgPrice from MongoDB to calculate real profit/loss!
    const pnl = (currentPrice - position.avgPrice) * position.quantity;
    return pnl.toFixed(2);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  // --- EFFECTS ---
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
    socket.on('marketUpdate', (update) => setWatchlist(prev => ({ ...prev, [update.symbol]: update })));
    socket.on('candleUpdate', (candle) => { if (candle.symbol === activeSymbol) setLatestCandle(candle); });
    socket.on('depthUpdate', (depth) => { if (depth.symbol.toUpperCase() === activeSymbol.toUpperCase()) setOrderBook(depth); });

    return () => socket.off();
  }, [activeSymbol]);

  // --- AUTHENTICATION GATEKEEPER ---
  if (!token) {
    return (
      <Auth
        onLogin={(userData) => {
          setToken(localStorage.getItem('token'));
          setUser(userData);
          // Load real database info on login!
          setBalance(userData.balance || 0);
          setPositions(userData.portfolio || []);
          setTrades(userData.trades ? userData.trades.reverse() : []);
        }}
      />
    );
  }

  // --- RENDER UI ---
  return (
    <div className="flex h-screen bg-[#0b0e11] text-[#eaecef]">
      {/* Sidebar */}
      <aside className="w-20 border-r border-gray-800 flex flex-col items-center py-6 bg-[#161a1e]">
        <div className="flex-1 flex flex-col items-center gap-8">
          <div className="text-yellow-500 font-bold text-2xl">N</div>
          <LayoutDashboard className="text-yellow-500 cursor-pointer" />
          <Activity className="text-gray-500 hover:text-white cursor-pointer" />
        </div>
        <button onClick={handleLogout} className="mt-auto p-3 text-gray-500 hover:text-red-500 transition-colors" title="Logout">
          <LogOut size={24} />
        </button>
      </aside>

      <main className="flex-1 p-4 space-y-4 overflow-y-auto">
        {/* Watchlist Row */}
        <div className="grid grid-cols-4 gap-4">
          {Object.keys(watchlist).map(sym => (
            <div key={sym} onClick={() => { setHistory([]); setActiveSymbol(sym); }}
              className={`p-4 rounded-lg border cursor-pointer transition-all ${activeSymbol === sym ? 'border-yellow-500 bg-[#1e2329]' : 'border-gray-800 bg-[#161a1e]'}`}
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
              <h3 className="text-2xl font-mono text-green-400 font-bold">
                ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </h3>
            </div>

            {/* PnL Card */}
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

            {/* Market Depth */}
            <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800 min-h-[300px]">
              <h4 className="text-sm font-bold mb-4 flex items-center gap-2 uppercase tracking-wider text-gray-400">
                <Activity size={14} className="text-yellow-500" /> Market Depth
              </h4>
              <OrderBook data={orderBook} />
            </div>

            {/* Quick Order Panel (WITH THE CRASH-PROOF FIX) */}
            <QuickOrder 
              activeSymbol={activeSymbol}
              currentPrice={watchlist[activeSymbol]?.price}
              token={token}
              onTradeComplete={(newBalance, newPortfolio, newTrade) => {
                setBalance(newBalance);
                setPositions(newPortfolio);

                if (newTrade) {
                  setTrades(prevTrades => Array.isArray(prevTrades) ? [newTrade, ...prevTrades] : [newTrade]);
                }
              }} 
            />

            {/* Trade Log */}
            <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800">
              <h4 className="text-sm font-bold mb-4 flex items-center gap-2"><Clock size={14} /> Recent Activity</h4>
              <div className="space-y-3 max-h-40 overflow-y-auto pr-2">
                {trades.length === 0 ? (
                  <p className="text-xs text-gray-600 italic">No trades yet</p>
                ) : trades.map(trade => (
                  <div key={trade._id || Math.random()} className="flex justify-between items-center text-xs border-b border-gray-800/50 pb-2">
                    <span className={trade.type === 'BUY' ? 'text-green-500' : 'text-red-500'}>{trade.type}</span>
                    <div className="text-right">
                      <p className="font-mono text-gray-300">${trade.price}</p>
                      <p className="text-[10px] text-gray-500">{new Date(trade.timestamp).toLocaleTimeString()}</p>
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