import React, { useState } from 'react';
import { Clock, CheckCircle, Trash2 } from 'lucide-react';
import { api, authHeaders } from '../lib/api';

const ActivityDashboard = ({ trades, pendingOrders, token, refreshData }) => {
  const [cancellingId, setCancellingId] = useState(null);
  const [cancelError, setCancelError] = useState(null);

  const handleCancelOrder = async (orderId) => {
    setCancellingId(orderId);
    setCancelError(null);
    try {
      await api.delete(`/api/trade/cancel/${orderId}`, authHeaders(token));
      // Refresh the account view so the wallet balance reflects released escrow.
      refreshData(token);
    } catch (err) {
      setCancelError(err?.response?.data?.message || 'Could not cancel that order. Try again.');
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Ledger</p>
        <h1 className="font-display text-lg font-semibold">Activity</h1>
      </header>

      {cancelError && (
        <p role="alert" className="rounded-lg border border-negative/25 bg-negative/10 px-3 py-2 text-xs text-negative">
          {cancelError}
        </p>
      )}

      <section className="panel overflow-hidden" aria-label="Open limit orders">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Escrow</p>
            <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
              <Clock size={14} className="text-amber" aria-hidden="true" /> Open limit orders
            </h2>
          </div>
          <span className="font-mono text-[10px] text-ink-muted">
            {(pendingOrders || []).length} open
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left">
            <thead>
              <tr className="border-b border-line-subtle/70 text-[10px] uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Pair</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 text-right font-medium">Target</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle/50 font-mono text-xs">
              {!pendingOrders || pendingOrders.length === 0 ? (
                <tr><td colSpan="6" className="px-4 py-6 text-center text-ink-muted">No open orders.</td></tr>
              ) : pendingOrders.map(order => (
                <tr key={order._id} className="transition-colors hover:bg-panel-2/50">
                  <td className="px-4 py-2.5 text-ink-secondary">{new Date(order.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-2.5 font-semibold text-ink-primary">{order.symbol}</td>
                  <td className={`px-4 py-2.5 font-semibold ${order.type === 'BUY' ? 'text-positive' : 'text-negative'}`}>
                    {order.type}
                  </td>
                  <td className="metric px-4 py-2.5 text-right">{Number(order.limitPrice).toLocaleString()}</td>
                  <td className="metric px-4 py-2.5 text-right">{order.quantity}</td>
                  <td className="px-4 py-2.5 text-right">
                    <button
                      type="button"
                      onClick={() => handleCancelOrder(order._id)}
                      disabled={cancellingId === order._id}
                      className="rounded-md p-1.5 text-ink-muted transition-colors hover:bg-negative/10 hover:text-negative disabled:opacity-40"
                      aria-label={`Cancel ${order.type} order for ${order.symbol}`}
                      title="Cancel order"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel overflow-hidden" aria-label="Executed trades">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Settlement</p>
            <h2 className="flex items-center gap-2 font-display text-sm font-semibold">
              <CheckCircle size={14} className="text-positive" aria-hidden="true" /> Executed trades
            </h2>
          </div>
          <span className="font-mono text-[10px] text-ink-muted">
            {(trades || []).length} fills
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-line-subtle/70 text-[10px] uppercase tracking-wider text-ink-muted">
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="px-4 py-2 font-medium">Pair</th>
                <th className="px-4 py-2 font-medium">Side</th>
                <th className="px-4 py-2 text-right font-medium">Price</th>
                <th className="px-4 py-2 text-right font-medium">Amount</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
                <th className="px-4 py-2 text-right font-medium">Realized PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle/50 font-mono text-xs">
              {!trades || trades.length === 0 ? (
                <tr><td colSpan="7" className="px-4 py-6 text-center text-ink-muted">No trading history.</td></tr>
              ) : trades.map(trade => (
                <tr key={trade._id} className="transition-colors hover:bg-panel-2/50">
                  <td className="px-4 py-2.5 text-ink-secondary">{new Date(trade.timestamp).toLocaleString()}</td>
                  <td className="px-4 py-2.5 font-semibold text-ink-primary">{trade.symbol}</td>
                  <td className={`px-4 py-2.5 font-semibold ${String(trade.type).includes('BUY') ? 'text-positive' : 'text-negative'}`}>
                    {trade.type}
                  </td>
                  <td className="metric px-4 py-2.5 text-right">{Number(trade.price).toLocaleString()}</td>
                  <td className="metric px-4 py-2.5 text-right">{trade.quantity}</td>
                  <td className="metric px-4 py-2.5 text-right font-semibold">
                    {(trade.price * trade.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                  </td>
                  <td className={`metric px-4 py-2.5 text-right font-semibold ${
                    trade.realizedPnl == null ? 'text-ink-muted' : trade.realizedPnl >= 0 ? 'text-positive' : 'text-negative'
                  }`}>
                    {trade.realizedPnl == null
                      ? <span title="Cost basis unavailable">—</span>
                      : `${trade.realizedPnl >= 0 ? '+' : ''}${trade.realizedPnl.toLocaleString(undefined, { minimumFractionDigits: 2 })}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
};

export default ActivityDashboard;
