const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios'); // Added this
require('dotenv').config();
const User = require('./models/User'); // Ensure this file exists in /models
const authRoutes = require('./routes/auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use('/api/auth', authRoutes);

// DB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(err => console.error('❌ DB Error:', err));

// --- MULTI-STREAM MARKET DATA BRIDGE ---
// We now subscribe to BOTH ticker (for watchlist) and kline (for chart)
const symbols = ['btcusdt', 'ethusdt', 'solusdt', 'bnbusdt'];

// Ensure no trailing slashes or empty strings
const tickerStreams = symbols.map(s => `${s.toLowerCase()}@ticker`).join('/');
const klineStreams = symbols.map(s => `${s.toLowerCase()}@kline_1m`).join('/');
const depthStreams = symbols.map(s => `${s.toLowerCase()}@depth5`).join('/'); // Simplified from @depth5@100ms for stability

const binanceUrl = `wss://stream.binance.com:9443/stream?streams=${tickerStreams}/${klineStreams}/${depthStreams}`;
const binanceConn = new WebSocket(binanceUrl);

console.log("🔗 Connecting to:", binanceUrl); // This helps us see if the URL looks weird

binanceConn.on('message', (data) => {
  try {
    const rawData = JSON.parse(data);
    const streamName = rawData.stream || "";
    const msg = rawData.data || rawData;

    // 1. Tickers (e: 24hrTicker)
    if (msg.e === '24hrTicker') {
      io.emit('marketUpdate', { symbol: msg.s, price: parseFloat(msg.c).toFixed(2), change: msg.P });
    } 
    
    // 2. Klines (e: kline)
    else if (msg.e === 'kline') {
      io.emit('candleUpdate', { symbol: msg.s, time: msg.k.t / 1000, open: parseFloat(msg.k.o), high: parseFloat(msg.k.h), low: parseFloat(msg.k.l), close: parseFloat(msg.k.c) });
    }

    // 3. DEPTH (Order Book)
    // We check for 'bids' or 'b' because depth messages don't have an 'e' field
    else if (msg.b || msg.bids || streamName.includes('depth')) {
      //console.log("🟢 ORDER BOOK DATA ARRIVED for", );
      
      const bids = msg.b || msg.bids || [];
      const asks = msg.a || msg.asks || [];
      const symbol = (msg.s || streamName.split('@')[0] || 'BTCUSDT').toUpperCase();

      io.emit('depthUpdate', {
        symbol: symbol,
        bids: bids.slice(0, 8),
        asks: asks.slice(0, 8)
      });
    }
    
    // 4. Unknown Data (Diagnostic)
    else {
      console.log("❓ Unknown message type from stream:", streamName);
    }

  } catch (err) {
    console.error('❌ Parser Error:', err);
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