import React, { useEffect, useRef, useState } from 'react';
import { Bot, Send, Sparkles, Check, X, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import {
  createConfirmLock,
  requestProposal,
  confirmProposal,
  reconcileProposal,
  discardProposal,
  canConfirm,
  canReconcile,
  blocksNewCommand,
  isExpired,
  formatRemaining
} from '../lib/copilotProposal';

const AICopilot = ({ token, watchlist, onTradeComplete }) => {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [log, setLog] = useState(null);
  const [proposal, setProposal] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const confirmLock = useRef(createConfirmLock());

  // Logout unmounts this panel; also clear any proposal if the token changes.
  useEffect(() => {
    setProposal(null);
    confirmLock.current = createConfirmLock();
  }, [token]);

  useEffect(() => {
    if (!proposal) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [proposal]);

  useEffect(() => {
    if (!log || log.status === 'loading') return undefined;
    const timer = setTimeout(() => setLog(null), 5000);
    return () => clearTimeout(timer);
  }, [log]);

  const handleCommand = async (e) => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;

    // An unconfirmed execution owns its proposal id. Starting a new command
    // would drop that identity and could execute the trade twice.
    if (blocksNewCommand(proposal)) {
      setLog({
        text: 'Execution is still unconfirmed. Retry, reconcile, or discard the original proposal first.',
        status: 'error'
      });
      return;
    }

    setLoading(true);
    setProposal(null);
    setLog({ text: 'Thinking...', status: 'loading' });

    try {
      // Stage 1 only: build a server-side proposal. No trade is sent here.
      const state = await requestProposal({
        http: api,
        prompt: trimmed,
        token,
        now: Date.now()
      });
      setNow(Date.now());
      setProposal(state);
      setPrompt('');

      const preview = state.preview || {};
      setLog({
        text: `Proposal ready: ${preview.side} ${preview.quantity} ${preview.symbol} ${preview.orderType}. Review and confirm.`,
        status: 'loading'
      });
    } catch (err) {
      const data = err.response?.data;
      const text = data?.code === 'CLARIFICATION_REQUIRED'
        ? data.clarification
        : data?.message || err.message || 'Agent failed to understand command.';
      setLog({ text: `Failed: ${text}`, status: 'error' });
    } finally {
      setLoading(false);
    }
  };

  const reportExecutionSuccess = (current, result) => {
    const trade = result.result || {};
    const confirmation = current.intent?.orderType === 'LIMIT'
      ? `${current.intent.side} ${current.intent.quantity} ${current.intent.symbol} limit @ $${current.intent.limitPrice}`
      : `${current.intent?.side} ${current.intent?.quantity} ${current.intent?.symbol} @ $${Number(trade.executedPrice).toFixed(2)}`;

    setLog({ text: `Success: ${confirmation}`, status: 'success' });
    setProposal(null);

    if (onTradeComplete) {
      onTradeComplete(trade.balance, trade.portfolio, trade.newTrade, trade.pendingOrders);
    }
  };

  const handleConfirm = async (reconcile = false) => {
    const current = proposal;
    if (!current || loading) return;

    // Confirm is the normal path; an expired unconfirmed execution can still be
    // reconciled through the same proposal id.
    const asReconcile = reconcile || (isExpired(current, Date.now()) && canReconcile(current));
    if (asReconcile ? !canReconcile(current) : !canConfirm(current, Date.now())) return;

    setLoading(true);
    setLog({
      text: asReconcile ? 'Reconciling the original proposal...' : 'Executing confirmed proposal...',
      status: 'loading'
    });

    const result = asReconcile
      ? await reconcileProposal({
        http: api,
        state: current,
        token,
        now: Date.now(),
        lock: confirmLock.current
      })
      : await confirmProposal({
        http: api,
        state: current,
        token,
        now: Date.now(),
        lock: confirmLock.current
      });

    if (result.ok) {
      reportExecutionSuccess(current, result);
    } else if (result.uncertain) {
      // The outcome is unknown, so the proposal and its id are kept. A retry or
      // reconciliation replays the same id; a new command must not replace it.
      setProposal(result.state);
      setLog({
        text: 'Execution not confirmed. Retry or reconcile the same proposal; do not submit a new command.',
        status: 'error'
      });
    } else if (result.definitive) {
      setProposal(null);
      if (result.reason === 'PRICE_CHANGED') {
        setLog({
          text: 'Price moved beyond tolerance. Proposal discarded; request a fresh one.',
          status: 'error'
        });
      } else if (result.reason === 'EXPIRED' || result.reason === 'PROPOSAL_EXPIRED') {
        setLog({
          text: 'Proposal expired and no execution was found. No trade was created.',
          status: 'error'
        });
      } else {
        setLog({ text: `Failed: ${result.state?.error || 'Execution failed.'}`, status: 'error' });
      }
    } else {
      // BUSY or another unresolved state: never silently drop the proposal.
      setLog({ text: 'Could not resolve the proposal yet. Please retry.', status: 'error' });
    }

    setLoading(false);
  };

  const handleDiscard = async () => {
    const current = proposal;
    if (!current || loading) return;

    setLoading(true);

    if (canReconcile(current)) {
      // Resolve the unknown outcome first. A committed execution must be
      // reported instead of being discarded locally as if nothing happened.
      const resolved = await reconcileProposal({
        http: api,
        state: current,
        token,
        now: Date.now(),
        lock: confirmLock.current
      });

      if (resolved.ok) {
        reportExecutionSuccess(current, resolved);
      } else if (resolved.uncertain) {
        setProposal(resolved.state);
        setLog({
          text: 'Execution still unconfirmed. Discard is blocked until it can be reconciled.',
          status: 'error'
        });
      } else if (resolved.definitive) {
        setProposal(null);
        setLog({
          text: resolved.reason === 'EXPIRED' || resolved.reason === 'PROPOSAL_EXPIRED'
            ? 'No execution was found for the expired proposal; no trade was created.'
            : `Proposal closed without an execution (${resolved.reason}).`,
          status: 'success'
        });
      } else {
        setLog({ text: 'Could not resolve the proposal yet. Please retry.', status: 'error' });
      }

      setLoading(false);
      return;
    }

    // Revoke server-side first so the proposal can never be executed later.
    const result = await discardProposal({ http: api, state: current, token });

    if (result.ok) {
      setProposal(null);
      setLog({ text: 'Proposal discarded. No trade was sent.', status: 'success' });
    } else {
      setLog({ text: `Discard failed: ${result.state?.error || 'Please retry.'}`, status: 'error' });
    }
    setLoading(false);
  };

  const preview = proposal?.preview;
  const expired = proposal ? isExpired(proposal, now) : false;
  const uncertain = Boolean(proposal?.uncertain);
  const confirmEnabled = canConfirm(proposal, now) && !loading;
  const reconcileEnabled = canReconcile(proposal) && !loading;

  return (
    <div className="bg-[#161a1e] p-4 rounded-xl border border-gray-800 relative overflow-hidden group">
      
      {/* --- ANIMATED BACKGROUND ELEMENTS --- */}
      {/* Purple breathing orb */}
      <div className="absolute -top-10 -right-10 w-40 h-40 bg-purple-600/20 rounded-full blur-3xl animate-pulse pointer-events-none" />
      {/* Blue breathing orb (delayed pulse) */}
      <div className="absolute -bottom-10 -left-10 w-40 h-40 bg-blue-600/10 rounded-full blur-3xl animate-pulse pointer-events-none" style={{ animationDelay: '1.5s' }} />
      
      {/* Static grid overlay for that "Terminal" feel */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] bg-[size:20px_20px] pointer-events-none" />

      {/* Hover-reactive Bot Icon */}
      <div className="absolute top-2 right-2 opacity-5 group-hover:opacity-20 group-hover:scale-110 transition-all duration-700 pointer-events-none">
        <Bot size={120} className="text-purple-400" />
      </div>
      {/* ------------------------------------ */}

      <h4 className="text-xs font-bold mb-3 flex items-center gap-2 text-purple-400 uppercase tracking-wider relative z-10">
        <Sparkles size={14} className="animate-pulse" /> Bruda Bot
      </h4>

      <form onSubmit={handleCommand} className="relative z-10">
        <div className="flex bg-[#0b0e11]/80 backdrop-blur-sm rounded border border-gray-800 focus-within:border-purple-500 transition-colors shadow-inner">
          <input 
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={500}
            disabled={loading || uncertain}
            placeholder='e.g., "Buy 0.5 BTC if it drops to $60,000"'
            className="flex-1 bg-transparent text-sm text-white p-3 outline-none placeholder-gray-600 font-mono"
          />
          <button 
            type="submit" 
            disabled={loading || uncertain || !prompt.trim()}
            className="p-3 text-gray-500 hover:text-purple-400 transition-all disabled:opacity-50 hover:scale-110"
          >
            <Send size={18} />
          </button>
        </div>
      </form>

      {/* --- CONFIRMATION CARD: nothing executes until Confirm --- */}
      {proposal && preview && (
        <div className="relative z-10 mt-3 rounded-lg border border-purple-500/40 bg-[#0b0e11]/90 p-3 font-mono text-[10px] text-gray-300 shadow-lg">
          <div className="flex justify-between items-center mb-2">
            <span className="text-purple-300 font-bold uppercase tracking-wider">Trade Proposal</span>
            <span className={`px-2 py-0.5 rounded font-bold ${
              uncertain
                ? 'text-amber-400 bg-amber-500/10'
                : expired ? 'text-red-400 bg-red-500/10' : 'text-yellow-400 bg-yellow-500/10'
            }`}>
              {uncertain ? 'UNCONFIRMED' : expired ? 'EXPIRED' : `Expires in ${formatRemaining(proposal, now)}`}
            </span>
          </div>

          {uncertain && (
            <div className="mb-2 flex gap-1.5 items-start text-amber-400">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                Execution outcome is unknown. Retry with the same proposal, reconcile it after
                expiry, or resolve it before discarding. A new command is blocked until then.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span className="text-gray-500 uppercase">Side</span>
            <span className={`font-bold ${preview.side === 'BUY' ? 'text-green-500' : 'text-red-500'}`}>
              {preview.side}
            </span>
            <span className="text-gray-500 uppercase">Pair</span>
            <span className="font-bold text-white">{preview.symbol}</span>
            <span className="text-gray-500 uppercase">Type</span>
            <span>{preview.orderType}</span>
            <span className="text-gray-500 uppercase">Quantity</span>
            <span>{preview.quantity}</span>
            <span className="text-gray-500 uppercase">
              {preview.orderType === 'LIMIT' ? 'Limit Price' : 'Market Price'}
            </span>
            <span>
              ${preview.orderType === 'LIMIT'
                ? Number(preview.limitPrice).toLocaleString()
                : Number(preview.quotePrice).toLocaleString()}
            </span>
            <span className="text-gray-500 uppercase">Est. Total</span>
            <span className="font-bold">${Number(preview.estimatedValue).toLocaleString()}</span>
            <span className="text-gray-500 uppercase">
              {preview.side === 'BUY' ? 'Available USDT' : `Available ${preview.symbol}`}
            </span>
            <span>
              {preview.side === 'BUY'
                ? `$${Number(preview.balance).toLocaleString()}`
                : Number(preview.availableQuantity).toLocaleString()}
            </span>
          </div>

          {preview.warnings && preview.warnings.length > 0 && (
            <div className="mt-2 space-y-1 text-amber-400">
              {preview.warnings.map((warning, index) => (
                <div key={index} className="flex gap-1.5 items-start">
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            {uncertain && expired ? (
              <button
                type="button"
                onClick={() => handleConfirm(true)}
                disabled={!reconcileEnabled}
                className="flex-1 flex items-center justify-center gap-1 bg-amber-500/20 border border-amber-500/40 text-amber-400 font-bold py-1.5 rounded hover:bg-amber-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <AlertTriangle size={12} /> Reconcile
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleConfirm(false)}
                disabled={!confirmEnabled}
                className="flex-1 flex items-center justify-center gap-1 bg-green-500/20 border border-green-500/40 text-green-400 font-bold py-1.5 rounded hover:bg-green-500/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Check size={12} /> {uncertain ? 'Retry execution' : 'Confirm'}
              </button>
            )}
            <button
              type="button"
              onClick={handleDiscard}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-1 bg-gray-800/60 border border-gray-700 text-gray-400 font-bold py-1.5 rounded hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <X size={12} /> {uncertain ? 'Resolve & discard' : 'Discard'}
            </button>
          </div>
        </div>
      )}

      {/* Dynamic Status Log */}
      {log && (
        <div className={`relative z-10 mt-3 text-[10px] font-mono font-bold px-2 py-1.5 rounded animate-pulse shadow-lg ${
          log.status === 'success' ? 'text-green-400 bg-green-500/10 border border-green-500/20' : 
          log.status === 'error' ? 'text-red-400 bg-red-500/10 border border-red-500/20' : 
          'text-purple-400 bg-purple-500/10 border border-purple-500/20'
        }`}>
           {log.text}
        </div>
      )}
    </div>
  );
};

export default AICopilot;