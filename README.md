 NexusTrade Pro 

A mathematically strict, real-time paper trading terminal engineered for precision. NexusTrade Pro bridges live market telemetry via Binance WebSockets with a bulletproof execution engine, ensuring flawless portfolio mathematics, real-time Mark-to-Market PnL, and automated Limit Order matching.

---

##  Core Architecture & Features

### 1. The Execution Engine (Strict Math & Escrow)
* **Margin & Asset Validation:** Bulletproof pre-trade checks prevent execution if wallet balance or crypto assets are insufficient.
* **Dynamic AEP Calculation:** Mathematically rigorous Average Entry Price (AEP) updates on every partial fill or new position.
* **Floating-Point "Dust" Cleanup:** Safely liquidates microscopic fractional balances (`0.000000004`) when positions are fully sold to keep the database optimized.
* **The Escrow System:** Limit orders immediately lock required funds/assets in escrow, ensuring liquidity is guaranteed when the market hits the target price.

### 2. Automated Matching Engine (The Watcher)
* **RAM-Cached Telemetry:** Live Binance order book prices are cached directly in server memory to prevent database bottlenecks.
* **Background Cron Loop:** An asynchronous engine sweeps the `PendingOrders` queue every 3 seconds, instantly triggering Limit Buys and Sells the millisecond the market price crosses the user's target.

### 3. Professional Charting & UI
* **Lightweight-Charts Integration:** High-performance, un-squished candlestick rendering with an overlayed SMA 20 indicator.
* **The Data Scrubber:** Automatically filters out websocket duplicate timestamps and `0` value glitches to prevent "flat-line" rendering bugs when zooming out on low-volume pairs.
* **Mark-to-Market PnL:** Unrealized profit and loss is calculated instantly against the top of the live Order Book (the spread), not just the delayed 24hr ticker, giving hyper-responsive real-time feedback.

---

##  Tech Stack

**Frontend (The Terminal):**
* React.js (Hooks, Context, Custom State)
* Tailwind CSS (Custom Dark Mode UI)
* Lightweight-Charts (TradingView)
* Socket.io-client
* Axios & Lucide-React (Icons)

**Backend (The Engine):**
* Node.js & Express.js
* MongoDB & Mongoose (Strict Schemas & Array manipulation)
* Socket.io & `ws` (Binance WebSocket Bridge)
* JWT Authentication & Bcrypt

---

##  Installation & Setup

### Prerequisites
* Node.js (v16+)
* MongoDB URI (Local or Atlas)

### 1. Clone the Repository
```bash
git clone https://github.com/Anshus9639/TRADING-ALGO.git
cd TRADING-ALGO
```

### 2. Backend Setup
```bash
cd backend
npm install
```
Create a `.env` file in the `backend` directory:
```env
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secure_random_secret
```
Start the engine:
```bash
npm start
```

### 3. Frontend Setup
```bash
cd frontend
npm install
```
Start the terminal:
```bash
npm run dev
```

---

##  Future Roadmap
* **Algorithmic Auto-Trading:** Deploying backend bots that execute trades automatically based on moving average crossovers (e.g., SMA 20).
* **Activity & Portfolio Dashboard:** A dedicated sidebar module to view historical ledger receipts and cancel pending limit orders.
* **Database Indexing:** Optimizing MongoDB queries (`userId` and `symbol` indexing) for sub-50ms execution times as the ledger grows.

---

##  Disclaimer
This is a **Paper Trading** platform. No real currency is ever traded or at risk. This project was developed as a technical exploration into high-frequency data streams and robust financial system architecture.

*Built with a focus on technical curiosity, system optimization, and robust architectural design.*
