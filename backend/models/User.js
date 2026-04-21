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
  
  balance: { 
    type: Number, 
    default: 10000,
    min: [0, 'Critical Error: Balance cannot drop below zero.'] // 🛡️ Database-level protection
  },
  
  portfolio: [
    {
      symbol: { type: String, required: true, uppercase: true }, // Forces "btcusdt" to "BTCUSDT"
      quantity: { type: Number, default: 0, min: [0, 'Cannot own negative crypto'] },
      avgPrice: { type: Number, default: 0, min: 0 }
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