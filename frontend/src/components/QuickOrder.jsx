import React, { useState, useEffect, useRef } from 'react';
import { api, authHeaders } from '../lib/api';
import { formatPrice, marketTradingBlocked } from '../lib/marketFormat.mjs';
import { createClientOrderId } from '../lib/orderId.mjs';
import { createPendingSubmissionMap, shouldRetirePendingKey } from '../lib/pendingOrders.mjs';

const QuickOrder = ({ activeSymbol, currentPrice, market, token, onTradeComplete }) => {
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
  // The backend refuses new orders for a pair whose exchange filters are not
  // known. Mirror that here so the panel says so before a request is sent.
  const tradingBlocked = marketTradingBlocked(market);

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
        : `Success: ${side} ${quantity} ${activeSymbol} @ $${formatPrice(Number(res.data.executedPrice))}`;
      
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
    <div className="panel-raised space-y-3 p-4">
      {/* Header & Toggle */}
      <div className="flex items-center justify-between border-b border-line-subtle pb-2">
        <h4 className="font-display text-sm font-semibold">Quick Order</h4>
        <div className="flex rounded-md border border-line-subtle bg-void/60 p-0.5">
          <button 
            onClick={() => setOrderType('MARKET')}
            className={`text-[10px] px-3 py-1 rounded uppercase font-semibold tracking-wider transition-all ${orderType === 'MARKET' ? 'bg-violet/25 text-ultraviolet' : 'text-ink-muted hover:text-ink-primary'}`}
          >
            Market
          </button>
          <button 
            onClick={() => setOrderType('LIMIT')}
            className={`text-[10px] px-3 py-1 rounded uppercase font-semibold tracking-wider transition-all ${orderType === 'LIMIT' ? 'bg-violet/25 text-ultraviolet' : 'text-ink-muted hover:text-ink-primary'}`}
          >
            Limit
          </button>
        </div>
      </div>
      
      {/* Dynamic Message Box */}
      {tradingBlocked && (
        <div className="rounded-md border border-amber/25 bg-amber/10 p-2 text-center text-xs font-semibold text-amber">
          Trading is temporarily unavailable for this market: exchange rules could not be verified.
        </div>
      )}

      {message && (
        <div className={`rounded-md border p-2 text-center text-xs font-semibold ${message.type === 'success' ? 'border-positive/25 bg-positive/10 text-positive' : 'border-negative/25 bg-negative/10 text-negative'}`}>
          {message.text}
        </div>
      )}

      {hasUnresolved && (
        <div className="rounded-md border border-amber/25 bg-amber/10 p-2 font-mono text-[10px] text-amber">
          An earlier submission is unresolved. Repeating the same order reuses its original
          idempotency key instead of placing a duplicate.
        </div>
      )}

      <div className="space-y-3">
        {/* Conditional Target Price Input (Only shows if LIMIT is selected) */}
        {orderType === 'LIMIT' && (
          <div>
            <label className="mb-1 block text-xs text-ink-secondary">Target Price (USDT)</label>
            <input 
              type="number" 
              value={limitPrice}
              onChange={(e) => setLimitPrice(e.target.value)}
              step="0.01"
              min="0.01"
              className="control w-full text-sm"
            />
          </div>
        )}

        {/* Quantity Input */}
        <div>
          <label className="mb-1 block text-xs text-ink-secondary">Amount ({activeSymbol?.replace('USDT', '')})</label>
          <input 
            type="number" 
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            step="0.01"
            min="0.01"
            className="control w-full text-sm"
          />
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex gap-2 pt-2">
        <button 
          onClick={() => handleTrade('BUY')}
          disabled={loading || tradingBlocked}
          className="flex-1 rounded-lg bg-positive py-3 text-sm font-semibold text-void transition-colors hover:bg-positive/90 disabled:opacity-50"
        >
          {loading ? 'Processing...' : (orderType === 'LIMIT' ? 'LIMIT BUY' : 'MARKET BUY')}
        </button>
        <button 
          onClick={() => handleTrade('SELL')}
          disabled={loading || tradingBlocked}
          className="flex-1 rounded-lg bg-negative py-3 text-sm font-semibold text-void transition-colors hover:bg-negative/90 disabled:opacity-50"
        >
          {loading ? 'Processing...' : (orderType === 'LIMIT' ? 'LIMIT SELL' : 'MARKET SELL')}
        </button>
      </div>
    </div>
  );
};

export default QuickOrder;