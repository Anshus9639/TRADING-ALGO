================================================================================
                              NEXUSTRADE PRO                                   
================================================================================

An advanced, real-time paper trading terminal equipped with an Agentic AI 
Execution Copilot. NexusTrade Pro bridges live market telemetry via Binance 
WebSockets with a mathematically strict execution engine and a Natural Language 
Processing (NLP) agent, allowing for seamless, autonomous trade routing.

--------------------------------------------------------------------------------
 1. CORE ARCHITECTURE & FEATURES
--------------------------------------------------------------------------------

[ Agentic AI Execution Copilot (Gemini 2.5 Flash) ]
* Natural Language Parsing: Users can type commands like "Buy $50 of SOL if it 
  drops to $130".
* Autonomous Routing: The LLM acts as a strict JSON-extraction engine, 
  translating human intent into machine-readable execution payloads.
* Direct Engine Integration: The AI bypasses manual UI inputs and directly 
  triggers the backend Escrow and Market execution routes.

[ The Execution Engine (Strict Math & Escrow) ]
* Margin & Asset Validation: Bulletproof pre-trade checks prevent execution if 
  wallet balance or crypto assets are insufficient.
* Dynamic AEP Calculation: Mathematically rigorous Average Entry Price (AEP) 
  updates on every partial fill or new position.
* Floating-Point "Dust" Cleanup: Safely liquidates microscopic fractional 
  balances (e.g., 0.000000004) to keep the portfolio and database clean.
* The Escrow System: Limit orders immediately lock required funds/assets in 
  escrow, ensuring liquidity is guaranteed when the market hits the target price.

[ Automated Matching Engine (The Watcher) ]
* RAM-Cached Telemetry: Live Binance order book prices are cached directly in 
  server memory to prevent database bottlenecks.
* Background Cron Loop: An asynchronous engine sweeps the PendingOrders queue 
  every 3 seconds, instantly triggering Limit Buys and Sells the millisecond 
  the market price crosses the user's target.

[ Professional Charting & UI ]
* Lightweight-Charts Integration: High-performance candlestick rendering with 
  dynamic intervals (1m, 5m, 15m, 1h).
* The Data Scrubber: Automatically filters out websocket duplicate timestamps 
  and $0 value glitches to prevent "flat-line" rendering bugs.
* Real-Time Mark-to-Market PnL: Unrealized profit and loss is calculated 
  instantly against the top of the live Order Book (the spread), giving 
  hyper-responsive feedback.
* Activity Ledger: A dedicated dashboard for tracking executed trades and 
  managing/canceling open limit orders in Escrow.

--------------------------------------------------------------------------------
 2. TECH STACK
--------------------------------------------------------------------------------

[ Frontend (The Terminal) ]
* React.js (Hooks, Context, Custom State)
* Tailwind CSS (Custom Dark Mode & Glassmorphism UI)
* Lightweight-Charts (TradingView)
* Socket.io-client
* Axios & Lucide-React

[ Backend (The Engine & Brain) ]
* Node.js & Express.js
* Google Generative AI SDK (gemini-2.5-flash for JSON extraction)
* MongoDB & Mongoose (Strict Schemas)
* Socket.io & ws (Binance WebSocket Bridge)
* JWT Authentication & Bcrypt

--------------------------------------------------------------------------------
 3. INSTALLATION & SETUP
--------------------------------------------------------------------------------

[ Prerequisites ]
* Node.js (v18+)
* MongoDB URI (Local or Atlas)
* Google Gemini API Key (Free tier via Google AI Studio)

[ Step 1: Clone the Repository ]
git clone https://github.com/yourusername/nexustrade-pro.git
cd nexustrade-pro

[ Step 2: Backend Setup ]
cd backend
npm install

Create a `.env` file in the `backend` directory:
PORT=5000
MONGO_URI=your_mongodb_connection_string
JWT_SECRET=your_secure_random_secret
GEMINI_API_KEY=your_gemini_api_key_here

Start the engine:
npm run dev

[ Step 3: Frontend Setup ]
cd ../frontend
npm install

Start the terminal:
npm run dev

--------------------------------------------------------------------------------
 4. DISCLAIMER
--------------------------------------------------------------------------------
This is a Paper Trading platform. No real currency is ever traded or at risk. 
This project was developed as a technical exploration into high-frequency data 
streams, Agentic AI integration, and robust financial system architecture.
