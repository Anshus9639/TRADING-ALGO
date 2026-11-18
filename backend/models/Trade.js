const mongoose = require('mongoose');
const { SYMBOL_PATTERN } = require('../lib/symbols');

// Append-only execution ledger. Trades are never updated or deleted by the
// application; the embedded user.trades array is retained only for legacy
// compatibility until it is explicitly migrated and pruned.
const TradeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
  symbol: {
    type: String,
    required: true,
    uppercase: true,
    match: [SYMBOL_PATTERN, 'Symbol must be an uppercase alphanumeric pair.']
  },
  side: { type: String, required: true, enum: ['BUY', 'SELL'] },
  quantity: { type: Number, required: true, min: 0.00001 },
  executionPrice: { type: Number, required: true, min: 0 },
  notional: { type: Number, required: true, min: 0 },
  realizedPnl: { type: Number, default: null },
  clientOrderId: { type: String, default: null, trim: true, maxlength: 100 },
  timestamp: { type: Date, default: Date.now, index: true }
}, {
  timestamps: true
});

TradeSchema.index({ userId: 1, timestamp: 1 });
TradeSchema.index(
  { orderId: 1 },
  { unique: true, partialFilterExpression: { orderId: { $type: 'objectId' } } }
);

module.exports = mongoose.model('Trade', TradeSchema);
