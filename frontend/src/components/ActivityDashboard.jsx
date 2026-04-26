import React, { useState } from 'react';
import axios from 'axios';
import { Clock, CheckCircle, Trash2 } from 'lucide-react';

const ActivityDashboard = ({ trades, pendingOrders, token, refreshData }) => {
  const [cancellingId, setCancellingId] = useState(null);

  // Function to cancel a pending limit order
  const handleCancelOrder = async (orderId) => {
    setCancellingId(orderId);
    try {
      await axios.delete(`https://trading-algo-nqud.onrender.com/api/trade/cancel/${orderId}`, {
        headers: { 'x-auth-token': token }
      });
      // Ping App.jsx to refresh the user data so the wallet balance updates
      refreshData(token); 
    } catch (err) {
      console.error("Failed to cancel order");
    } finally {
      setCancellingId(null);
    }
  };

  return (
    <div className="p-6 h-full overflow-y-auto custom-scrollbar">
      <h2 className="text-2xl font-bold font-mono mb-6 text-white">Activity & Ledger</h2>

      {/* --- PENDING LIMIT ORDERS --- */}
      <div className="mb-8">
        <h3 className="text-sm font-bold text-gray-400 mb-3 flex items-center gap-2 uppercase tracking-wider">
          <Clock size={16} className="text-yellow-500" /> Open Limit Orders
        </h3>
        <div className="bg-[#161a1e] rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0b0e11] text-gray-500 text-[10px] uppercase font-bold">
              <tr>
                <th className="p-4">Time</th>
                <th className="p-4">Pair</th>
                <th className="p-4">Type</th>
                <th className="p-4">Target Price</th>
                <th className="p-4">Amount</th>
                <th className="p-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300 font-mono text-xs">
              {!pendingOrders || pendingOrders.length === 0 ? (
                <tr><td colSpan="6" className="p-6 text-center text-gray-600 italic">No open orders.</td></tr>
              ) : pendingOrders.map(order => (
                <tr key={order._id} className="hover:bg-[#1e2329] transition-colors">
                  <td className="p-4">{new Date(order.timestamp).toLocaleString()}</td>
                  <td className="p-4 font-bold">{order.symbol}</td>
                  <td className={`p-4 font-bold ${order.type === 'BUY' ? 'text-green-500' : 'text-red-500'}`}>{order.type}</td>
                  <td className="p-4">${order.limitPrice.toLocaleString()}</td>
                  <td className="p-4">{order.quantity}</td>
                  <td className="p-4 text-right">
                    <button 
                      onClick={() => handleCancelOrder(order._id)}
                      disabled={cancellingId === order._id}
                      className="text-gray-500 hover:text-red-500 transition-colors disabled:opacity-50"
                      title="Cancel Order"
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- TRADE HISTORY LEDGER --- */}
      <div>
        <h3 className="text-sm font-bold text-gray-400 mb-3 flex items-center gap-2 uppercase tracking-wider">
          <CheckCircle size={16} className="text-green-500" /> Executed Trades
        </h3>
        <div className="bg-[#161a1e] rounded-xl border border-gray-800 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-[#0b0e11] text-gray-500 text-[10px] uppercase font-bold">
              <tr>
                <th className="p-4">Time</th>
                <th className="p-4">Pair</th>
                <th className="p-4">Type</th>
                <th className="p-4">Executed Price</th>
                <th className="p-4">Amount</th>
                <th className="p-4">Total Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800 text-gray-300 font-mono text-xs">
              {!trades || trades.length === 0 ? (
                <tr><td colSpan="6" className="p-6 text-center text-gray-600 italic">No trading history.</td></tr>
              ) : trades.map(trade => (
                <tr key={trade._id} className="hover:bg-[#1e2329] transition-colors">
                  <td className="p-4 text-gray-500">{new Date(trade.timestamp).toLocaleString()}</td>
                  <td className="p-4 font-bold text-white">{trade.symbol}</td>
                  <td className={`p-4 font-bold ${trade.type.includes('BUY') ? 'text-green-500' : 'text-red-500'}`}>{trade.type}</td>
                  <td className="p-4">${trade.price.toLocaleString()}</td>
                  <td className="p-4">{trade.quantity}</td>
                  <td className="p-4 font-bold">${(trade.price * trade.quantity).toLocaleString(undefined, { minimumFractionDigits: 2 })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default ActivityDashboard;