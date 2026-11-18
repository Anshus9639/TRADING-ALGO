import React, { useEffect, useRef, useState } from 'react';
import { Send, Sparkles, Check, X, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api';
import { formatPrice } from '../lib/marketFormat.mjs';
import {
  createConfirmLock,
  requestProposal,
  confirmProposal,
  reconcileProposal,
  resolveDiscard,
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
  const tokenRef = useRef(token);
  const mountedRef = useRef(true);

  // The token at the start of an operation identifies the session its result
  // belongs to. Responses that arrive after a logout or a new login must not
  // apply a previous account's balance or trade to the current one.
  const isSessionCurrent = (sessionToken) => (
    mountedRef.current && tokenRef.current === sessionToken
  );

  // Logout unmounts this panel; also clear any proposal if the token changes.
  useEffect(() => {
    tokenRef.current = token;
    setProposal(null);
    setLog(null);
    setLoading(false);
    confirmLock.current = createConfirmLock();
  }, [token]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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
    const sessionToken = token;

    try {
      // Stage 1 only: build a server-side proposal. No trade is sent here.
      const state = await requestProposal({
        http: api,
        prompt: trimmed,
        token: sessionToken,
        now: Date.now()
      });
      if (!isSessionCurrent(sessionToken)) return;
      setNow(Date.now());
      setProposal(state);
      setPrompt('');

      const preview = state.preview || {};
      setLog({
        text: `Proposal ready: ${preview.side} ${preview.quantity} ${preview.symbol} ${preview.orderType}. Review and confirm.`,
        status: 'loading'
      });
    } catch (err) {
      if (!isSessionCurrent(sessionToken)) return;
      const data = err.response?.data;
      const text = data?.code === 'CLARIFICATION_REQUIRED'
        ? data.clarification
        : data?.message || err.message || 'Agent failed to understand command.';
      setLog({ text: `Failed: ${text}`, status: 'error' });
    } finally {
      if (isSessionCurrent(sessionToken)) setLoading(false);
    }
  };

  const reportExecutionSuccess = (current, result, sessionToken) => {
    if (!isSessionCurrent(sessionToken)) return;
    const trade = result.result || {};
    const confirmation = current.intent?.orderType === 'LIMIT'
      ? `${current.intent.side} ${current.intent.quantity} ${current.intent.symbol} limit @ $${current.intent.limitPrice}`
      : `${current.intent?.side} ${current.intent?.quantity} ${current.intent?.symbol} @ $${formatPrice(Number(trade.executedPrice))}`;

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

    const sessionToken = token;
    const result = asReconcile
      ? await reconcileProposal({
        http: api,
        state: current,
        token: sessionToken,
        now: Date.now(),
        lock: confirmLock.current
      })
      : await confirmProposal({
        http: api,
        state: current,
        token: sessionToken,
        now: Date.now(),
        lock: confirmLock.current
      });

    // The session that started this execution is gone; its outcome belongs to
    // that account and must not be applied to the current one.
    if (!isSessionCurrent(sessionToken)) return;

    if (result.ok) {
      reportExecutionSuccess(current, result, sessionToken);
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

    // Resolve & discard only looks up the outcome and revokes the proposal. It
    // never replays the execution: retrying the same id stays on the explicit
    // Retry/Reconcile path handled by handleConfirm.
    const sessionToken = token;
    const result = await resolveDiscard({ http: api, state: current, token: sessionToken });
    if (!isSessionCurrent(sessionToken)) return;

    if (result.executed) {
      reportExecutionSuccess(current, { result: result.result }, sessionToken);
    } else if (result.ok) {
      setProposal(null);
      setLog({
        text: result.executionKnown
          ? 'No trade was created; the proposal was discarded.'
          : 'Proposal discarded. No trade was sent.',
        status: 'success'
      });
    } else if (result.uncertain) {
      setProposal(result.state);
      setLog({
        text: 'Execution outcome is unknown. Discard is blocked until the outcome can be resolved; retry the same proposal.',
        status: 'error'
      });
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
    <div className="panel relative overflow-hidden p-4">
      <div className="pointer-events-none absolute -right-12 -top-12 h-36 w-36 rounded-full bg-violet/15 blur-3xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-12 -left-12 h-36 w-36 rounded-full bg-cyan/10 blur-3xl" aria-hidden="true" />

      <h4 className="relative z-10 mb-3 flex items-center gap-2 font-display text-xs font-semibold uppercase tracking-[0.16em] text-ultraviolet">
        <Sparkles size={14} aria-hidden="true" /> Bruda Bot
      </h4>

      <form onSubmit={handleCommand} className="relative z-10">
        <div className="flex rounded-lg border border-line-subtle bg-void/70 backdrop-blur-sm transition-colors focus-within:border-violet/60">
          <input 
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={500}
            disabled={loading || uncertain}
            placeholder='e.g., "Buy 0.5 BTC if it drops to $60,000"'
            className="flex-1 bg-transparent p-3 font-mono text-sm text-ink-primary outline-none placeholder:text-ink-muted"
          />
          <button 
            type="submit" 
            disabled={loading || uncertain || !prompt.trim()}
            aria-label="Ask the copilot"
            className="p-3 text-ink-muted transition-colors hover:text-ultraviolet disabled:opacity-50"
          >
            <Send size={18} aria-hidden="true" />
          </button>
        </div>
      </form>

      {/* --- CONFIRMATION CARD: nothing executes until Confirm --- */}
      {proposal && preview && (
        <div className="relative z-10 mt-3 rounded-lg border border-violet/40 bg-void/90 p-3 font-mono text-[10px] text-ink-secondary shadow-panel">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold uppercase tracking-wider text-ultraviolet">Trade Proposal</span>
            <span className={`rounded px-2 py-0.5 font-semibold ${
              uncertain
                ? 'bg-amber/10 text-amber'
                : expired ? 'bg-negative/10 text-negative' : 'bg-violet/15 text-ultraviolet'
            }`}>
              {uncertain ? 'UNCONFIRMED' : expired ? 'EXPIRED' : `Expires in ${formatRemaining(proposal, now)}`}
            </span>
          </div>

          {uncertain && (
            <div className="mb-2 flex items-start gap-1.5 text-amber">
              <AlertTriangle size={11} className="mt-0.5 shrink-0" />
              <span>
                Execution outcome is unknown. Retry with the same proposal, reconcile it after
                expiry, or resolve it before discarding. A new command is blocked until then.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-3 gap-y-1">
            <span className="text-ink-muted uppercase">Side</span>
            <span className={`font-semibold ${preview.side === 'BUY' ? 'text-positive' : 'text-negative'}`}>
              {preview.side}
            </span>
            <span className="text-ink-muted uppercase">Pair</span>
            <span className="font-semibold text-ink-primary">{preview.symbol}</span>
            <span className="text-ink-muted uppercase">Type</span>
            <span>{preview.orderType}</span>
            <span className="text-ink-muted uppercase">Quantity</span>
            <span>{preview.quantity}</span>
            <span className="text-ink-muted uppercase">
              {preview.orderType === 'LIMIT' ? 'Limit Price' : 'Market Price'}
            </span>
            <span>
              ${preview.orderType === 'LIMIT'
                ? Number(preview.limitPrice).toLocaleString()
                : Number(preview.quotePrice).toLocaleString()}
            </span>
            <span className="text-ink-muted uppercase">Est. Total</span>
            <span className="font-bold">${Number(preview.estimatedValue).toLocaleString()}</span>
            <span className="text-ink-muted uppercase">
              {preview.side === 'BUY' ? 'Available USDT' : `Available ${preview.symbol}`}
            </span>
            <span>
              {preview.side === 'BUY'
                ? `$${Number(preview.balance).toLocaleString()}`
                : Number(preview.availableQuantity).toLocaleString()}
            </span>
          </div>

          {preview.warnings && preview.warnings.length > 0 && (
            <div className="mt-2 space-y-1 text-amber">
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
                className="flex-1 flex items-center justify-center gap-1 rounded border border-amber/40 bg-amber/15 py-1.5 font-semibold text-amber transition-colors hover:bg-amber/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <AlertTriangle size={12} /> Reconcile
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleConfirm(false)}
                disabled={!confirmEnabled}
                className="flex-1 flex items-center justify-center gap-1 rounded border border-positive/40 bg-positive/15 py-1.5 font-semibold text-positive transition-colors hover:bg-positive/25 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Check size={12} /> {uncertain ? 'Retry execution' : 'Confirm'}
              </button>
            )}
            <button
              type="button"
              onClick={handleDiscard}
              disabled={loading}
              className="flex-1 flex items-center justify-center gap-1 rounded border border-line-strong bg-panel-2/60 py-1.5 font-semibold text-ink-secondary transition-colors hover:bg-panel-3 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X size={12} /> {uncertain ? 'Resolve & discard' : 'Discard'}
            </button>
          </div>
        </div>
      )}

      {/* Dynamic Status Log */}
      {log && (
        <div className={`relative z-10 mt-3 rounded border px-2 py-1.5 font-mono text-[10px] font-semibold ${
          log.status === 'success' ? 'border-positive/20 bg-positive/10 text-positive' :
          log.status === 'error' ? 'border-negative/20 bg-negative/10 text-negative' :
          'border-violet/20 bg-violet/10 text-ultraviolet'
        }`}>
           {log.text}
        </div>
      )}
    </div>
  );
};

export default AICopilot;