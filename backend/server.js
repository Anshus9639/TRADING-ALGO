const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const User = require('./models/User');

const app = express();
const server = http.createServer(app);

// 🚀 THE FIX: Unified CORS rules (NO Trailing Slash!)
const corsOptions = {
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://trading-algo-oa9r.vercel.app" // Exact match, no slash at the end!
  ],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true 
};

// Apply to Express
app.use(cors(corsOptions)); 
app.use(express.json());

// Apply to Socket.io
const io = new Server(server, { 
  cors: corsOptions 
});

// --- DATABASE ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- BINANCE WS BRIDGE (SELF-HEALING) ---
const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];
const livePrices = {};
let binanceConn;

const connectBinance = () => {
  const streams = [
    ...SYMBOLS.map(s => `${s.toLowerCase()}@ticker`),
    ...SYMBOLS.map(s => `${s.toLowerCase()}@kline_1m`),
    ...SYMBOLS.map(s => `${s.toLowerCase()}@depth5`)
  ].join('/');

  binanceConn = new WebSocket(`wss://stream.binance.us:9443/stream?streams=${streams}`);

  binanceConn.on('message', (data) => {
    try {
      const rawData = JSON.parse(data);
      const msg = rawData.data || rawData;

      if (msg.e === '24hrTicker') {
        const currentPrice = parseFloat(msg.c);
        livePrices[msg.s] = currentPrice;
        io.emit('marketUpdate', { symbol: msg.s, price: parseFloat(msg.c).toFixed(2), change: msg.P });
      } 
      else if (msg.e === 'kline') {
        io.emit('candleUpdate', { 
          symbol: msg.s, 
          time: Math.floor(msg.k.t / 1000), 
          open: parseFloat(msg.k.o), 
          high: parseFloat(msg.k.h), 
          low: parseFloat(msg.k.l), 
          close: parseFloat(msg.k.c) 
        });
      }
      else if (msg.b || msg.bids) {
        const streamName = rawData.stream || "";
        const symbol = (msg.s || streamName.split('@')[0] || 'BTCUSDT').toUpperCase();
        
        io.emit('depthUpdate', { symbol, bids: (msg.b || msg.bids).slice(0, 8), asks: (msg.a || msg.asks).slice(0, 8) });
      }
    } catch (e) {}
  });

  binanceConn.on('error', (err) => console.error("WS Error:", err.message));
  binanceConn.on('close', () => {
    console.log("🔌 Reconnecting to Binance...");
    setTimeout(connectBinance, 5000);
  });
};
connectBinance();

setInterval(async () => {
  try {
    // 1. Find all users who have at least one pending order
    const usersWithOrders = await User.find({ 'pendingOrders.0': { $exists: true } });

    for (let user of usersWithOrders) {
      let databaseModified = false;

      // 2. Loop backwards so we can safely delete completed orders from the array
      for (let i = user.pendingOrders.length - 1; i >= 0; i--) {
        const order = user.pendingOrders[i];
        const currentPrice = livePrices[order.symbol];

        if (!currentPrice) continue; // Skip if we don't have a price yet

        let shouldExecute = false;
        
        // LIMIT BUY Logic: Execute if live price drops BELOW or EQUAL TO target
        if (order.type === 'BUY' && currentPrice <= order.limitPrice) {
          shouldExecute = true;
        } 
        // LIMIT SELL Logic: Execute if live price rises ABOVE or EQUAL TO target
        else if (order.type === 'SELL' && currentPrice >= order.limitPrice) {
          shouldExecute = true;
        }

        // 3. EXECUTE THE TRADE
        if (shouldExecute) {
          console.log(`⚡ EXECUTING LIMIT ORDER: ${order.type} ${order.symbol} @ $${order.limitPrice}`);

          if (order.type === 'BUY') {
            // Escrow already took their USDT. Now, give them the Crypto!
            const assetIndex = user.portfolio.findIndex(p => p.symbol === order.symbol);
            if (assetIndex > -1) {
              const oldQty = user.portfolio[assetIndex].quantity;
              const oldAvg = user.portfolio[assetIndex].avgPrice || 0;
              const newQty = oldQty + order.quantity;
              
              // Recalculate Average Entry Price (AEP)
              user.portfolio[assetIndex].avgPrice = ((oldQty * oldAvg) + (order.quantity * order.limitPrice)) / newQty;
              user.portfolio[assetIndex].quantity = newQty;
            } else {
              user.portfolio.push({ symbol: order.symbol, quantity: order.quantity, avgPrice: order.limitPrice });
            }
          } 
          else if (order.type === 'SELL') {
            // Escrow already took their Crypto. Now, give them the USDT!
            const revenue = order.quantity * order.limitPrice;
            user.balance += revenue;
          }

          // Log the executed trade
          user.trades.push({
            symbol: order.symbol,
            type: order.type, // Tag it so the UI knows it was an auto-trade
            quantity: order.quantity,
            price: order.limitPrice,
            timestamp: new Date()
          });

          // Remove it from the pending queue
          user.pendingOrders.splice(i, 1);
          databaseModified = true;
        }
      }

      // 4. Save the user only if an order actually triggered
      if (databaseModified) {
        await user.save();
        console.log(`✅ Saved executed orders for user ${user._id}`);
      }
    }
  } catch (err) {
    console.error("⚠️ Order Engine Error:", err.message);
  }
}, 3000);

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trade', require('./routes/trade'));
app.use('/api/copilot', require('./routes/copilot'));

// 3. FIXED HISTORY (The "Pattern" Fix)
 app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    // 🚀 Look for the interval in the URL query, default to 1m
    const interval = req.query.interval || '1m'; 
    
    const response = await axios.get(
      `https://api.binance.us/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${interval}&limit=500`
    );

    const formattedData = response.data.map(d => ({
      time: Math.floor(d[0] / 1000),
      open: parseFloat(d[1]),
      high: parseFloat(d[2]),
      low: parseFloat(d[3]),
      close: parseFloat(d[4]),
    }));

    res.json(formattedData);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

app.get('/', (req, res) => res.send('API LIVE'));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Running on ${PORT}`));