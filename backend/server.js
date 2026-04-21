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
const io = new Server(server, { cors: { origin: "*" } });

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- 🔌 REAL API ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trade', require('./routes/trade')); // <--- THE MAGIC LINK!

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- MULTI-STREAM MARKET DATA BRIDGE (BINANCE) ---
const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];

const tickerStreams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
const klineStreams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
const depthStreams = symbols.map(s => `${s.toLowerCase()}@depth5`).join('/'); 

const binanceUrl = `wss://stream.binance.com:9443/stream?streams=${tickerStreams}/${klineStreams}/${depthStreams}`;
const binanceConn = new WebSocket(binanceUrl);

console.log("🔗 Connecting to Binance Websocket..."); 

binanceConn.on('message', (data) => {
  try {
    const rawData = JSON.parse(data);
    const streamName = rawData.stream || "";
    const msg = rawData.data || rawData;

    // 1. Tickers (Watchlist)
    if (msg.e === '24hrTicker') {
      io.emit('marketUpdate', { symbol: msg.s, price: parseFloat(msg.c).toFixed(2), change: msg.P });
    }

    // 2. Klines (Candlestick Chart)
    else if (msg.e === 'kline') {
      io.emit('candleUpdate', { 
        symbol: msg.s, 
        time: msg.k.t / 1000, 
        open: parseFloat(msg.k.o), 
        high: parseFloat(msg.k.h), 
        low: parseFloat(msg.k.l), 
        close: parseFloat(msg.k.c) 
      });
    }

    // 3. DEPTH (Order Book)
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

// Health Check
app.get('/', (req, res) => res.send('Trading API Running...'));

// Historical Data for Chart Initialization
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const response = await axios.get(
      `https://api.binance.com/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=1m&limit=100`
    );

    const formattedData = response.data.map(d => ({
      time: d[0] / 1000,
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

// Fetch User Portfolio (Optional fallback route)
app.get('/api/user/portfolio/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    res.json(user);
  } catch (err) {
    res.status(500).send("Error fetching portfolio");
  }
});

// Socket Connection Handler
io.on('connection', (socket) => {
  console.log('✅ Client connected:', socket.id);
  socket.on('disconnect', () => console.log('❌ Client disconnected'));
});

// --- START SERVER ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));