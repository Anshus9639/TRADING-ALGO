import React, { useState, useEffect, useCallback } from 'react';
import io from 'socket.io-client';
import axios from 'axios';
import { LayoutDashboard, Activity, Clock, CreditCard, TrendingUp, LogOut } from 'lucide-react';

// Components
import Auth from './components/Auth';
import CandleChart from './components/CandleChart';
import OrderBook from './components/OrderBook';
import QuickOrder from './components/QuickOrder';

// Initialize socket outside to prevent multiple connections on re-render
const socket = io('https://trading-algo-nqud.onrender.com');

function App() {
  // --- SESSION STATES ---
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [user, setUser] = useState(null);
  const [isInitializing, setIsInitializing] = useState(true);
  
  // --- UI STATES ---
  const [currentView, setCurrentView] = useState('dashboard'); // 🚀 Makes sidebar clickable
  const [chartInterval, setChartInterval] = useState('5m'); // 🚀 Dynamic Chart Interval
  
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

  // --- 1. PERSISTENCE LOGIC ---
  const fetchUserProfile = useCallback(async (authToken) => {
    try {
      const res = await axios.get('https://trading-algo-nqud.onrender.com/api/auth/me', {
        headers: { 'x-auth-token': authToken }
      });
      setUser(res.data);
      setBalance(res.data.balance || 0);
      setPositions(res.data.portfolio || []);
      setTrades(res.data.trades ? [...res.data.trades].reverse() : []);
    } catch (err) {
      console.error("Session expired or invalid");
      handleLogout();
    } finally {
      setIsInitializing(false);
    }
  }, []);

  useEffect(() => {
    if (token) {
      fetchUserProfile(token);
    } else {
      setIsInitializing(false);
    }
  }, [token, fetchUserProfile]);

  // --- 2. MARKET DATA LOGIC (WITH INTERVAL FIX) ---
  useEffect(() => {
    const fetchHistory = async () => {
      try {
        setHistory([]); 
        // 🚀 Requests the specific interval from your backend
        const res = await axios.get(`https://trading-algo-nqud.onrender.com/api/history/${activeSymbol}?interval=${chartInterval}`);
        setHistory(res.data);
      } catch (err) { 
        console.error("Market history unavailable"); 
      }
    };
    fetchHistory();
  }, [activeSymbol, chartInterval]); // 🚀 Re-runs when symbol OR interval changes

  useEffect(() => {
    socket.on('marketUpdate', (update) => {
      setWatchlist(prev => ({ ...prev, [update.symbol]: update }));
    });

    socket.on('candleUpdate', (candle) => { 
      if (candle.symbol === activeSymbol) setLatestCandle(candle); 
    });

    socket.on('depthUpdate', (depth) => { 
      if (depth.symbol.toUpperCase() === activeSymbol.toUpperCase()) setOrderBook(depth); 
    });

    return () => {
      socket.off('marketUpdate');
      socket.off('candleUpdate');
      socket.off('depthUpdate');
    };
  }, [activeSymbol]);

  // --- 3. HELPER FUNCTIONS ---
  const calculatePnL = () => {
    const position = positions.find(p => p.symbol === activeSymbol);
    if (!position) return "0.00";

    // 1. Default to the standard ticker price
    let livePrice = parseFloat(watchlist[activeSymbol]?.price || 0);

    // 2. 🚀 THE REAL-TIME FIX: Mark-to-Market using the Order Book!
    // The Order Book updates milliseconds faster than the actual traded price.
    if (orderBook && orderBook.symbol === activeSymbol && orderBook.bids && orderBook.bids.length > 0) {
      livePrice = parseFloat(orderBook.bids[0][0]); 
    } 
    // 3. Fallback to the live candle close if order book is syncing
    else if (latestCandle && latestCandle.symbol === activeSymbol) {
      livePrice = latestCandle.close;
    }

    if (livePrice === 0) return "0.00";

    // Calculate real-time profit
    const pnl = (livePrice - position.avgPrice) * position.quantity;
    return pnl.toFixed(2);
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    setBalance(0);
    setPositions([]);
    setTrades([]);
  };

  const handleLoginSuccess = (userData, userToken) => {
    setToken(userToken);
    setUser(userData);
    setBalance(userData.balance || 0);
    setPositions(userData.portfolio || []);
    setTrades(userData.trades ? [...userData.trades].reverse() : []);
  };

  // --- 4. RENDER LOGIC ---
  if (isInitializing) return (
    <div className="h-screen bg-[#0b0e11] flex items-center justify-center font-mono text-yellow-500">
      INITIALIZING SECURE CONNECTION...
    </div>
  );

  if (!token) return <Auth onLogin={handleLoginSuccess} />;

  return (
    <div className="flex h-screen bg-[#0b0e11] text-[#eaecef] overflow-hidden">
      {/* Sidebar */}
      <aside className="w-20 border-r border-gray-800 flex flex-col items-center py-6 bg-[#161a1e] z-10">
        <div className="flex-1 flex flex-col items-center gap-8">
          <div className="text-yellow-500 font-bold text-2xl tracking-tighter">N</div>
          {/* 🚀 Make Icons Clickable */}
          <LayoutDashboard 
            onClick={() => setCurrentView('dashboard')}
            className={`cursor-pointer transition-colors ${currentView === 'dashboard' ? 'text-yellow-500' : 'text-gray-500 hover:text-white'}`} 
            size={20} 
          />
          <Activity 
            onClick={() => setCurrentView('activity')}
            className={`cursor-pointer transition-colors ${currentView === 'activity' ? 'text-yellow-500' : 'text-gray-500 hover:text-white'}`} 
            size={20} 
          />
        </div>
        <button onClick={handleLogout} className="mt-auto p-3 text-gray-500 hover:text-red-500 transition-colors">
          <LogOut size={20} />
        </button>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col h-full">
        {currentView === 'activity' ? (
          <div className="flex-1 flex items-center justify-center font-mono text-gray-600 tracking-widest">
            ACTIVITY MODULE PENDING
          </div>
        ) : (
          <>
            {/* Watchlist Row */}
            <div className="p-4 grid grid-cols-4 gap-4 bg-[#0b0e11]">
              {Object.keys(watchlist).map(sym => (
                <div 
                  key={sym} 
                  onClick={() => setActiveSymbol(sym)}
                  className={`p-3 rounded-lg border transition-all duration-200 cursor-pointer ${
                    activeSymbol === sym ? 'border-yellow-500 bg-[#1e2329]' : 'border-gray-800 bg-[#161a1e] hover:border-gray-600'
                  }`}
                >
                  <p className="text-[10px] text-gray-500 font-bold uppercase mb-1">{sym}</p>
                  <div className="flex justify-between items-baseline">
                    <span className="text-lg font-mono font-bold">${parseFloat(watchlist[sym].price).toLocaleString()}</span>
                    <span className={`text-[11px] font-bold ${parseFloat(watchlist[sym].change) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {parseFloat(watchlist[sym].change) >= 0 ? '+' : ''}{watchlist[sym].change}%
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Scrollable Dashboard Body */}
            <div className="flex-1 overflow-y-auto p-4 pt-0 space-y-4">
              <div className="grid grid-cols-12 gap-4">
                
                {/* Chart Area */}
                <div className="col-span-12 lg:col-span-9 bg-[#161a1e] rounded-xl border border-gray-800 p-4">
                  <div className="flex justify-between items-center mb-4">
                    <h2 className="font-bold text-lg font-mono">{activeSymbol} <span className="text-gray-600 text-sm ml-2">/ USDT</span></h2>
                    
                    <div className="flex items-center gap-4 text-[10px] font-bold uppercase">
                      <span className="flex items-center gap-1.5 text-green-500">
                        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" /> Live
                      </span>
                      
                      {/* 🚀 The New Time Interval Buttons */}
                      <div className="flex bg-[#0b0e11] border border-gray-800 rounded p-0.5">
                        {['1m', '5m', '15m', '1h'].map(int => (
                          <button 
                            key={int}
                            onClick={() => setChartInterval(int)}
                            className={`px-3 py-1 rounded transition-colors ${
                              chartInterval === int ? 'bg-gray-800 text-white' : 'text-gray-500 hover:text-gray-300'
                            }`}
                          >
                            {int}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="h-[450px]">
                    {history.length > 0 ? (
                      <CandleChart initialData={history} candleData={latestCandle} />
                    ) : (
                      <div className="h-full flex items-center justify-center text-gray-700 font-mono text-sm tracking-widest">
                        SYNCING {chartInterval.toUpperCase()} DATA...
                      </div>
                    )}
                  </div>
                </div>

                {/* Trading & Status Panel */}
                <div className="col-span-12 lg:col-span-3 space-y-4">
                  {/* Stats Grid */}
                  <div className="grid grid-cols-2 lg:grid-cols-1 gap-4">
                    <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800">
                      <p className="text-gray-500 text-[10px] uppercase font-bold mb-1">Available Margin</p>
                      <h3 className="text-xl font-mono text-green-400 font-bold">
                        ${balance.toLocaleString(undefined, { minimumFractionDigits: 2 })}
                      </h3>
                    </div>
                    <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800">
                      <p className="text-gray-500 text-[10px] uppercase font-bold mb-1">Unrealized PnL</p>
                      <h3 className={`text-xl font-mono font-bold ${parseFloat(calculatePnL()) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        {parseFloat(calculatePnL()) >= 0 ? '+' : ''}${calculatePnL()}
                      </h3>
                    </div>
                  </div>

                  <QuickOrder 
                    activeSymbol={activeSymbol}
                    currentPrice={watchlist[activeSymbol]?.price}
                    token={token}
                    onTradeComplete={(newBalance, newPortfolio, newTrade) => {
                      setBalance(newBalance);
                      setPositions(newPortfolio);
                      if (newTrade) setTrades(prev => [newTrade, ...prev]);
                    }} 
                  />

                  <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800">
                    <h4 className="text-xs font-bold mb-4 flex items-center gap-2 text-gray-400"><Activity size={14} className="text-yellow-500" /> ORDER BOOK</h4>
                    <OrderBook data={orderBook} />
                  </div>

                  <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800">
                    <h4 className="text-xs font-bold mb-4 flex items-center gap-2 text-gray-400"><Clock size={14} /> RECENT LOGS</h4>
                    <div className="space-y-3 max-h-40 overflow-y-auto custom-scrollbar">
                      {trades.length === 0 ? (
                        <p className="text-[10px] text-gray-600 font-mono tracking-tighter italic">NO ACTIVITY RECORDED</p>
                      ) : trades.map(trade => (
                        <div key={trade._id || Math.random()} className="flex justify-between items-center text-[10px] border-b border-gray-800/50 pb-2">
                          <div className="flex flex-col">
                            <span className={`font-bold ${trade.type === 'BUY' ? 'text-green-500' : 'text-red-500'}`}>{trade.type} {trade.symbol}</span>
                            <span className="text-gray-600 text-[8px]">{new Date(trade.timestamp).toLocaleString()}</span>
                          </div>
                          <span className="font-mono text-gray-300 font-bold">${parseFloat(trade.price).toFixed(2)}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default App;