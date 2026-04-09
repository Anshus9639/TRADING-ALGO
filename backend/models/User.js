const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 10000 }, // $10,000 USD virtual credit
  portfolio: [
    {
      symbol: { type: String, default: 'BTCUSDT' },
      quantity: { type: Number, default: 0 },
      avgPrice: { type: Number, default: 0 }
    }
  ],
  trades: [
    {
      symbol: String,
      type: String, // 'BUY' or 'SELL'
      quantity: Number,
      price: Number,
      timestamp: { type: Date, default: Date.now }
    }
  ]
});

module.exports = mongoose.model('User', UserSchema);