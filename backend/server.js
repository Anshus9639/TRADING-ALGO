const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

// --- CONFIGURATION ---
const PORT = process.env.PORT || 5000;
const BINANCE_WS_URL = "wss://stream.binance.us:9443/stream?streams=";
const SYMBOLS = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];

const app = express();
const server = http.createServer(app);

// Optimized CORS for production
const io = new Server(server, { 
  cors: { 
    origin: ["http://localhost:3000", "https://your-vercel-link.vercel.app"], // Add your actual Vercel link here
    methods: ["GET", "POST"]
  },
  pingTimeout: 60000, // Pro: Keeps socket connections alive longer
});

// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());

// --- DATABASE ---
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- BINANCE WEBSOCKET BRIDGE (Self-Healing) ---
let binanceConn;
let reconnectAttempts = 0;

const connectBinance = () => {
  const streams = [
    ...SYMBOLS.map(s => `${s.toLowerCase()}@ticker`),
    ...SYMBOLS.map(s => `${s.toLowerCase()}@kline_1m`),
    ...SYMBOLS.map(s => `${s.toLowerCase()}@depth5`)
  ].join('/');

  console.log("🔗 Initializing Binance Bridge...");
  binanceConn = new WebSocket(`${BINANCE_WS_URL}${streams}`);

  binanceConn.on('open', () => {
    console.log("🚀 Binance WebSocket Connected");
    reconnectAttempts = 0; // Reset on successful connection
  });

  binanceConn.on('message', (data) => {
    try {
      const rawData = JSON.parse(data);
      const streamName = rawData.stream || "";
      const msg = rawData.data || rawData;

      // 1. Optimized Tickers
      if (msg.e === '24hrTicker') {
        io.emit('marketUpdate', { 
          symbol: msg.s, 
          price: parseFloat(msg.c).toFixed(2), 
          change: msg.P 
        });
      }

      // 2. High-Precision Klines
      else if (msg.e === 'kline') {
        io.emit('candleUpdate', { 
          symbol: msg.s, 
          time: Math.floor(msg.k.t / 1000), 
          open: parseFloat(msg.k.o), 
          high: parseFloat(msg.k.h), 
          low: parseFloat(msg.k.l), 
          close: parseFloat(msg.k.c),
          volume: parseFloat(msg.k.v) // Added volume for advanced charting
        });
      }

      // 3. Order Book Depth
      else if (msg.b || msg.bids || streamName.includes('depth')) {
        const bids = msg.b || msg.bids || [];
        const asks = msg.a || msg.asks || [];
        const symbol = (msg.s || streamName.split('@')[0] || 'BTCUSDT').toUpperCase();

        io.emit('depthUpdate', {
          symbol,
          bids: bids.slice(0, 10), // Increased depth slightly for better patterns
          asks: asks.slice(0, 10)
        });
      }
    } catch (err) {
      // Quiet parser error to avoid log spam
    }
  });

  binanceConn.on('error', (err) => {
    console.error("⚠️ Binance WS Error:", err.message);
  });

  binanceConn.on('close', () => {
    const delay = Math.min(1000 * (2 ** reconnectAttempts), 30000); // Exponential backoff
    console.log(`🔌 Connection closed. Retrying in ${delay/1000}s...`);
    setTimeout(connectBinance, delay);
    reconnectAttempts++;
  });
};

connectBinance();

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trade', require('./routes/trade'));

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    // 🚀 ADVANCED: Increased limit to 500 for better pattern detection
    const response = await axios.get(
      `https://api.binance.us/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=1m&limit=500`
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

app.get('/', (req, res) => res.send('NexusTrade API v2 Live'));

// --- SERVER SAFETY NETS ---
// 🚀 Pro: Prevents the server from crashing on unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

server.listen(PORT, () => console.log(`🚀 Terminal running on port ${PORT}`));