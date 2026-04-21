const router = require('express').Router();
const User = require('../models/User');
const auth = require('../middleware/auth');

// --- BUY ROUTE ---
router.post('/buy', auth, async (req, res) => {
  console.log("🚨 1. BUY ROUTE STARTED!"); 
  
  try {
    const { symbol, quantity, price } = req.body;
    console.log(`📦 2. Data Received: ${quantity} ${symbol} at $${price}`);

    console.log(`🔍 3. Looking for user ID: ${req.user?.id}`);
    const user = await User.findById(req.user.id);
    
    if (!user) {
      console.log("❌ 4. USER NOT FOUND IN DB");
      return res.status(404).json({ message: 'User not found in database.' });
    }
    console.log(`✅ 4. User found! Wallet Balance: $${user.balance}`);

    const totalCost = Number(quantity) * Number(price);
    if (user.balance < totalCost) {
      console.log("❌ 5. INSUFFICIENT BALANCE");
      return res.status(400).json({ message: 'Insufficient Balance.' });
    }

    console.log("💾 6. Updating numbers and saving to database...");
    user.balance -= totalCost;

    const assetIndex = user.portfolio.findIndex(p => p.symbol === symbol);
    if (assetIndex > -1) {
      const oldQty = user.portfolio[assetIndex].quantity;
      const oldAvg = user.portfolio[assetIndex].avgPrice || 0;
      const newQty = oldQty + Number(quantity);
      user.portfolio[assetIndex].avgPrice = ((oldQty * oldAvg) + totalCost) / newQty;
      user.portfolio[assetIndex].quantity = newQty;
    } else {
      user.portfolio.push({ symbol, quantity: Number(quantity), avgPrice: Number(price) });
    }

    user.trades.push({ symbol, type: 'BUY', quantity: Number(quantity), price: Number(price) });
    
    await user.save();
    console.log("🎉 7. TRADE SAVED SUCCESSFULLY!");

    res.json({ 
      success: true, 
      balance: user.balance, 
      portfolio: user.portfolio,
      newTrade: user.trades[user.trades.length - 1] 
    });

  } catch (err) {
    console.error("🔥 CRASH ERROR:", err);
    res.status(500).json({ message: `DB Crash: ${err.message}` });
  }
});

// --- SELL ROUTE ---
router.post('/sell', auth, async (req, res) => {
  try {
    const { symbol, quantity, price } = req.body;
    const totalRevenue = Number(quantity) * Number(price);

    const user = await User.findById(req.user.id);
    if (!user) return res.status(404).json({ message: 'User not found in database.' });

    const assetIndex = user.portfolio.findIndex(p => p.symbol === symbol);

    // Check Crypto Balance
    if (assetIndex === -1 || user.portfolio[assetIndex].quantity < Number(quantity)) {
      return res.status(400).json({ message: 'Insufficient Crypto Balance.' });
    }

    // Add Balance & Deduct Crypto
    user.balance += totalRevenue;
    user.portfolio[assetIndex].quantity -= Number(quantity);

    // Log Trade
    user.trades.push({ symbol, type: 'SELL', quantity: Number(quantity), price: Number(price) });
    
    await user.save();

    res.json({ 
      success: true, 
      balance: user.balance, 
      portfolio: user.portfolio,
      newTrade: user.trades[user.trades.length - 1] 
    });

  } catch (err) {
    console.error("SELL ERROR:", err);
    res.status(500).json({ message: `DB Crash: ${err.message}` });
  }
});

module.exports = router;