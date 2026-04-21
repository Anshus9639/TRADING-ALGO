const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const User = require('./models/User'); 

// --- INITIALIZE EXPRESS & SOCKET.IO ---
const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*", // Allows your Vercel frontend to connect
    methods: ["GET", "POST"]
  } 
});

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- API ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trade', require('./routes/trade'));

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- MULTI-STREAM MARKET DATA BRIDGE (BINANCE) ---
const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];

const tickerStreams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
const klineStreams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
const depthStreams = symbols.map(s => `${s.toLowerCase()}@depth5`).join('/'); 

// 🚀 FIX: Switched to binance.us to avoid regional blocks on Render
const binanceUrl = `wss://stream.binance.us:9443/stream?streams=${tickerStreams}/${klineStreams}/${depthStreams}`;
const binanceConn = new WebSocket(binanceUrl);

console.log("🔗 Connecting to Binance Websocket..."); 

// 🚀 CRITICAL FIX: The Safety Net
// This prevents the "Exit Status 1" crash if Binance rejects the connection
binanceConn.on('error', (err) => {
  console.error("⚠️ BINANCE WS ERROR:", err.message);
  console.log("Server will stay running, but live prices may be unavailable.");
});

binanceConn.on('close', () => {
  console.log("🔌 Binance Connection Closed.");
});

binanceConn.on('message', (data) => {
  try {
    const rawData = JSON.parse(data);
    const streamName = rawData.stream || "";
    const msg = rawData.data || rawData;

    // 1. Tickers (Watchlist Updates)
    if (msg.e === '24hrTicker') {
      io.emit('marketUpdate', { 
        symbol: msg.s, 
        price: parseFloat(msg.c).toFixed(2), 
        change: msg.P 
      });
    }

    // 2. Klines (Live Candlestick Updates)
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

    // 3. Order Book Depth
    else if (msg.b || msg.bids || streamName.includes('depth')) {
      const bids = msg.b || msg.bids || [];
      const asks = msg.a || msg.asks || [];
      const symbol = (msg.s || streamName.split('@')[0] || 'BTCUSDT').toUpperCase();

      io.emit('depthUpdate', {
        symbol: symbol,
        bids: bids.slice(0, 8),
        asks: asks.slice(0, 8)
      });
    }
  } catch (err) {
    console.error('❌ Parser Error:', err);
  }
});

// --- HELPER ROUTES ---

// Health Check for Render
app.get('/', (req, res) => res.send('NexusTrade API is Live and Running...'));

// Historical Data for Chart Initialization
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const response = await axios.get(
      `https://api.binance.us/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=1m&limit=100`
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
    console.error("History fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// Socket Connection Handler
io.on('connection', (socket) => {
  console.log('✅ Socket Client connected:', socket.id);
  socket.on('disconnect', () => console.log('❌ Socket Client disconnected'));
});

// --- START SERVER ---
// 🚀 Render uses process.env.PORT automatically
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});