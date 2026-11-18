import React, { useState, useEffect, useRef } from 'react';
import { api, authHeaders } from '../lib/api';
import { createClientOrderId } from '../lib/orderId.mjs';
import { createPendingSubmissionMap, shouldRetirePendingKey } from '../lib/pendingOrders.mjs';

const QuickOrder = ({ activeSymbol, currentPrice, token, onTradeComplete }) => {
  const [orderType, setOrderType] = useState('MARKET'); // 🚀 New: Tracks Market vs Limit
  const [quantity, setQuantity] = useState(0.1);
  const [limitPrice, setLimitPrice] = useState(''); // 🚀 New: Tracks target price
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null); 
  // Keyed per submission so a retry of an unresolved order reuses its original
  // idempotency key, and a different order cannot overwrite that identity.
  // The map is user-scoped and survives a page refresh without persisting tokens.
  const pendingSubmissions = useRef(null);
  if (!pendingSubmissions.current) {
    pendingSubmissions.current = createPendingSubmissionMap({ token });
  }
  const [hasUnresolved, setHasUnresolved] = useState(
    () => pendingSubmissions.current.size() > 0
  );
  const tokenRef = useRef(token);
  const mountedRef = useRef(true);

  useEffect(() => {
    tokenRef.current = token;
    pendingSubmissions.current = createPendingSubmissionMap({ token });
    setHasUnresolved(pendingSubmissions.current.size() > 0);
  }, [token]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 🚀 Auto-fill limit price with the current live price when switching to LIMIT tab
  useEffect(() => {
    if (orderType === 'LIMIT' && !limitPrice && currentPrice) {
      setLimitPrice(currentPrice);
    }
  }, [orderType, currentPrice, limitPrice]);

  const handleTrade = async (side) => {
    setMessage(null); // Clear old messages

    // Safety Checks
    if (!token) return setMessage({ text: "Error: Please log in.", type: "error" });
    if (quantity <= 0) return setMessage({ text: "Error: Quantity must be > 0.", type: "error" });
    if (orderType === 'LIMIT' && (!limitPrice || limitPrice <= 0)) return setMessage({ text: "Error: Enter a valid target price.", type: "error" });

    setLoading(true);
    const sessionToken = token;
    // The pending map is captured for this submission: a logout/login during
    // the request must not redirect its storage writes into another scope.
    const submissions = pendingSubmissions.current.refresh();
    const isCurrent = () => mountedRef.current && tokenRef.current === sessionToken;
    let requestKey = null;
    let clientOrderId = null;
    try {
      let endpoint = '';
      const numericQuantity = Number(quantity);
      const numericLimitPrice = Number(limitPrice);
      const payload = { symbol: activeSymbol, quantity: numericQuantity };

      // 🚀 Route the data based on Market vs Limit
      if (orderType === 'MARKET') {
        endpoint = side === 'BUY' ? '/api/trade/buy' : '/api/trade/sell';
      } else {
        endpoint = '/api/trade/limit'; // Routes to your Escrow system
        payload.type = side; // 'BUY' or 'SELL'
        payload.limitPrice = numericLimitPrice;
      }

      requestKey = [
        endpoint,
        side,
        activeSymbol,
        numericQuantity,
        orderType === 'LIMIT' ? numericLimitPrice : 'MARKET'
      ].join('|');
      const pending = submissions.get(requestKey);
      if (pending) {
        clientOrderId = pending;
      } else {
        clientOrderId = createClientOrderId();
        submissions.set(requestKey, clientOrderId);
      }
      payload.clientOrderId = clientOrderId;

      const res = await api.post(endpoint, payload, authHeaders(sessionToken));
      // Only retire the key this request used. A newer unresolved submission
      // created under the same request key keeps its own id.
      submissions.deleteIf(requestKey, clientOrderId);

      if (!isCurrent()) return;
      setHasUnresolved(submissions.size() > 0);

      // Success! Show inline message
      const successText = orderType === 'LIMIT' 
        ? `Success: ${side} Limit placed at $${payload.limitPrice}` 
        : `Success: ${side} ${quantity} ${activeSymbol} @ $${Number(res.data.executedPrice).toFixed(2)}`;
      
      setMessage({ text: successText, type: "success" });
      
      // Update Dashboard UI (Wallet, Portfolio, Trades)
      if (onTradeComplete) {
        onTradeComplete(res.data.balance, res.data.portfolio, res.data.newTrade, res.data.pendingOrders); 
      }
      
    } catch (err) {
      // Only a response produced after the backend looked the key up proves
      // the order was not created. Early 4xx answers (auth, rate limiting,
      // request validation) and uncertain failures keep the key for a retry.
      const status = err.response?.status;
      const code = err.response?.data?.code;
      if (requestKey && clientOrderId && shouldRetirePendingKey(status, code)) {
        submissions.deleteIf(requestKey, clientOrderId);
      }
      if (!isCurrent()) return;
      setHasUnresolved(submissions.size() > 0);
      // Error! Show inline message
      const errorMsg = err.response?.data?.message || "Trade failed due to server error.";
      setMessage({ text: `Rejected: ${errorMsg}`, type: "error" });
    } finally {
      if (isCurrent()) {
        setLoading(false);
        // Auto-hide the message after 3 seconds
        setTimeout(() => {
          if (mountedRef.current) setMessage(null);
        }, 3000);
      }
    }
  };

  return (
    <div className="bg-[#161a1e] p-5 rounded-xl border border-gray-800 space-y-4">
      {/* Header & Toggle */}
      <div className="flex justify-between items-center border-b border-gray-800 pb-2">
        <h4 className="text-sm font-bold">Quick Order</h4>
        <div className="flex bg-[#0b0e11] rounded p-0.5 border border-gray-700">
          <button 
            onClick={() => setOrderType('MARKET')}
            className={`text-[10px] px-3 py-1 rounded uppercase font-bold transition-all ${orderType === 'MARKET' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Market
          </button>
          <button 
            onClick={() => setOrderType('LIMIT')}
            className={`text-[10px] px-3 py-1 rounded uppercase font-bold transition-all ${orderType === 'LIMIT' ? 'bg-gray-700 text-white' : 'text-gray-500 hover:text-gray-300'}`}
          >
            Limit
          </button>
        </div>
      </div>
      
      {/* Dynamic Message Box */}
      {message && (
        <div className={`p-2 rounded text-xs font-bold text-center ${message.type === 'success' ? 'bg-green-500/20 text-green-400' : 'bg-red-500/20 text-red-400'}`}>
          {message.text}
        </div>
      )}

      {hasUnresolved && (
        <div className="p-2 rounded text-[10px] font-mono text-amber-400 bg-amber-500/10 border border-amber-500/20">
          An earlier submission is unresolved. Repeating the same order reuses its original
          idempotency key instead of placing a duplicate.
        </div>
      )}

      <div className="space-y-3">
        {/* Conditional Target Price Input (Only shows if LIMIT is selected) */}
        {orderType === 'LIMIT' && (
          <div>
            <label className="text-gray-400 text-xs mb-1 block">Target Price (USDT)</label>
            <input 
              type="number" 
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              step="0.01"
              min="0.01"
              className="w-full bg-[#0b0e11] text-white p-3 rounded border border-gray-700 outline-none focus:border-yellow-500 transition-colors text-sm"
            />
          </div>
        )}

        {/* Quantity Input */}
        <div>
          <label className="text-gray-400 text-xs mb-1 block">Amount ({activeSymbol?.replace('USDT', '')})</label>
          <input 
            type="number" 
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            step="0.01"
            min="0.01"
            className="w-full bg-[#0b0e11] text-white p-3 rounded border border-gray-700 outline-none focus:border-yellow-500 transition-colors text-sm"
          />
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2">
        <button 
          onClick={() => handleTrade('BUY')}
          disabled={loading}
          className="flex-1 bg-green-600 hover:bg-green-500 text-white font-bold py-3 rounded text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Processing...' : (orderType === 'LIMIT' ? 'LIMIT BUY' : 'MARKET BUY')}
        </button>
        <button 
          onClick={() => handleTrade('SELL')}
          disabled={loading}
          className="flex-1 bg-red-600 hover:bg-red-500 text-white font-bold py-3 rounded text-sm transition-colors disabled:opacity-50"
        >
          {loading ? 'Processing...' : (orderType === 'LIMIT' ? 'LIMIT SELL' : 'MARKET SELL')}
        </button>
      </div>
    </div>
  );
};

export default QuickOrder;