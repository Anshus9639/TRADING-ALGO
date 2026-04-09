const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios'); // Added this
require('dotenv').config();

// Import Models
const User = require('./models/User'); // Ensure this file exists in /models

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// DB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- MULTI-STREAM MARKET DATA BRIDGE ---
// We now subscribe to BOTH ticker (for watchlist) and kline (for chart)
const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];
const tickerStreams = symbols.map(s => `${s}@ticker`).join('/');
const klineStreams = symbols.map(s => `${s}@kline_1m`).join('/');
const depthStreams = symbols.map(s => `${s}@depth5@100ms`).join('/'); // Top 5 bids/asks, updated every 100ms

const binanceConn = new WebSocket(`wss://stream.binance.com:9443/ws/${tickerStreams}/${klineStreams}/${depthStreams}`);

binanceConn.on('message', (data) => {
  try {
    const msg = JSON.parse(data);

    // 1. Handle Ticker Updates (For Watchlist Cards)
    if (msg.e === '24hrTicker') {
      io.emit('marketUpdate', {
        symbol: msg.s,
        price: parseFloat(msg.c).toFixed(2),
        change: msg.P,
      });
    }

    // 2. Handle Candlestick Updates (For the Graph)
    if (msg.e === 'kline') {
      const candle = msg.k;
      io.emit('candleUpdate', {
        symbol: msg.s,
        time: candle.t / 1000,
        open: parseFloat(candle.o),
        high: parseFloat(candle.h),
        low: parseFloat(candle.l),
        close: parseFloat(candle.c),
      });

      // 3. Handle Depth Messages inside binanceConn.on('message'...)
if (msg.e === 'depthUpdate' || !msg.e) { 
  // Binance depth stream sometimes doesn't have an 'e' field if it's a top-level stream
  // We'll simplify: if it has 'b' (bids) and 'a' (asks), it's depth data.
  if (msg.b && msg.a) {
    io.emit('depthUpdate', {
      symbol: msg.s || 'BTCUSDT',
      bids: msg.b.slice(0, 8), // Top 8 buy orders
      asks: msg.a.slice(0, 8)  // Top 8 sell orders
     });
    }
   }
    }
  } catch (err) {
    console.error('❌ Error parsing market data:', err);
  }
});

// --- API ROUTES ---

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

// Fetch User Portfolio
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

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server on http://localhost:${PORT}`));
// Add this to backend/server.js
app.post('/api/trade', async (req, res) => {
  try {
    const { symbol, type, quantity, price } = req.body;
    
    // For now, we'll use a hardcoded user ID since we haven't done Auth yet
    // In a real app, this comes from the JWT token
    const userId = "65f123456789012345678901"; // Replace with a real ID from your Compass if needed

    // 1. Update the User's balance and positions in MongoDB
    // (We will implement the full DB logic once you're ready for the User Model)
    
    console.log(`Order Received: ${type} ${quantity} ${symbol} at $${price}`);
    
    res.json({ success: true, message: "Trade executed successfully" });
  } catch (err) {
    res.status(500).json({ error: "Trade failed" });
  }
});