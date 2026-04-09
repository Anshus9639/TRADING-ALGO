const router = require('express').Router();
const User = require('../models/User');
const auth = require('../middleware/auth');

router.post('/buy', auth, async (req, res) => {
  const { symbol, quantity, price } = req.body;
  const totalCost = quantity * price;

  try {
    const user = await User.findById(req.user.id);
    if (user.balance < totalCost) return res.status(400).json({ message: 'Insufficient Balance' });

    // Deduct Balance
    user.balance -= totalCost;

    // Update Portfolio
    const assetIndex = user.portfolio.findIndex(p => p.symbol === symbol);
    if (assetIndex > -1) {
      user.portfolio[assetIndex].quantity += Number(quantity);
    } else {
      user.portfolio.push({ symbol, quantity, avgPrice: price });
    }

    // Log Trade
    user.trades.push({ symbol, type: 'BUY', quantity, price });
    
    await user.save();
    res.json({ success: true, balance: user.balance, portfolio: user.portfolio });
  } catch (err) {
    res.status(500).json({ message: 'Trade Failed' });
  }
});

module.exports = router;