const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { 
    type: String, 
    required: true, 
    trim: true // Removes accidental spaces ("Anshu " becomes "Anshu")
  },
  email: { 
    type: String, 
    required: true, 
    unique: true, 
    lowercase: true // Prevents duplicate accounts like "Email@.." vs "email@.."
  },
  password: { type: String, required: true },
  
  // Spendable USDT only. Reserved BUY-limit funds live in lockedBalance.
  balance: { 
    type: Number, 
    default: 10000,
    min: [0, 'Critical Error: Balance cannot drop below zero.'] // 🛡️ Database-level protection
  },

  // USDT reserved by open BUY limit orders. available = balance (already net).
  lockedBalance: {
    type: Number,
    default: 0,
    min: [0, 'Locked balance cannot be negative.']
  },
  
  portfolio: [
    {
      symbol: { type: String, required: true, uppercase: true }, // Forces "btcusdt" to "BTCUSDT"
      // Total quantity owned. Available quantity is quantity - lockedQuantity.
      quantity: { type: Number, default: 0, min: [0, 'Cannot own negative crypto'] },
      // Quantity reserved by open SELL limit orders.
      lockedQuantity: { type: Number, default: 0, min: [0, 'Locked quantity cannot be negative'] },
      // Historical legacy holdings may have no recoverable purchase price.
      // Storing null + UNKNOWN is deliberate: a missing basis must never be
      // interpreted as a real zero-cost purchase.
      avgPrice: { type: Number, default: null, min: 0 },
      costBasisStatus: { type: String, enum: ['KNOWN', 'UNKNOWN'], default: 'KNOWN' }
    }
  ],
  pendingOrders: [
    {
      symbol: String,
      type: { type: String, enum: ['BUY', 'SELL'] }, // Must be exactly 'BUY' or 'SELL'
      quantity: Number,
      limitPrice: Number,
      timestamp: { type: Date, default: Date.now }
    }
  ],
  
  trades: [
    {
      symbol: { type: String, uppercase: true, required: true },
      type: { 
        type: String, 
        enum: ['BUY', 'SELL'], // 🛡️ Rejects typos. Only these two exact words are allowed.
        required: true 
      },
      quantity: { type: Number, required: true, min: 0.00001 }, // Prevents buying 0 or negative amounts
      price: { type: Number, required: true, min: 0 },
      timestamp: { type: Date, default: Date.now }
    }
  ]
}, { 
  timestamps: true // 🪄 Automatically adds 'createdAt' and 'updatedAt' for the whole user account
});

module.exports = mongoose.model('User', UserSchema);