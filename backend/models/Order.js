const mongoose = require('mongoose');
const { SUPPORTED_SYMBOLS } = require('../lib/validate');
const { ORDER_STATUSES } = require('../lib/orderState');

// Canonical order records for every submission (market orders are recorded as
// FILLED orders). clientOrderId is the idempotency key: a unique compound index
// prevents duplicate execution of the same client submission.
const OrderSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true, uppercase: true, enum: SUPPORTED_SYMBOLS },
  side: { type: String, required: true, enum: ['BUY', 'SELL'] },
  orderType: { type: String, required: true, enum: ['MARKET', 'LIMIT'] },
  quantity: { type: Number, required: true, min: 0.00001 },
  remainingQuantity: { type: Number, required: true, min: 0 },
  limitPrice: {
    type: Number,
    default: null,
    min: [0.00000001, 'Limit price must be positive.'],
    validate: {
      validator(value) {
        return this.orderType === 'LIMIT' ? Number.isFinite(value) && value > 0 : value === null || value === undefined;
      },
      message: 'Limit price is required for LIMIT orders and forbidden for MARKET orders.'
    }
  },
  status: { type: String, required: true, enum: ORDER_STATUSES, default: 'OPEN', index: true },
  clientOrderId: { type: String, required: true, trim: true, maxlength: 100 },
  filledPrice: { type: Number, default: null, min: 0 },
  filledAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  attempts: { type: Number, default: 0, min: 0 },
  lastError: { type: String, default: null },
  claimedBy: { type: String, default: null },
  claimedAt: { type: Date, default: null },
  leaseExpiresAt: { type: Date, default: null }
}, {
  timestamps: true
});

OrderSchema.index({ userId: 1, clientOrderId: 1 }, { unique: true });
OrderSchema.index({ status: 1, symbol: 1 });
OrderSchema.index({ userId: 1, status: 1, createdAt: 1 });
OrderSchema.index({ status: 1, leaseExpiresAt: 1 });

module.exports = mongoose.model('Order', OrderSchema);
