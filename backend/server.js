const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

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

// --- ROUTES ---
app.use('/api/auth', require('./routes/auth'));
app.use('/api/trade', require('./routes/trade'));

// 3. FIXED HISTORY (The "Pattern" Fix)
app.get('/api/history/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const response = await axios.get(
      `https://api.binance.us/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=5m&limit=500`
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