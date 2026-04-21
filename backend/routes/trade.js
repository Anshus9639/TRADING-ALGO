const router = require('express').Router();
const User = require('../models/User');
const auth = require('../middleware/auth');

// --- STRICT BUY ROUTE ---
router.post('/buy', auth, async (req, res) => {
  try {
    const { symbol, quantity, price } = req.body;
    
    // Strict casting to prevent JavaScript string math bugs
    const numQty = Number(quantity);
    const numPrice = Number(price);
    const totalCost = numQty * numPrice;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found in database.' });
    }

    // 1. STRICT MARGIN CHECK
    if (user.balance < totalCost) {
      return res.status(400).json({ success: false, message: 'Insufficient USDT Balance.' });
    }

    // 2. Deduct Balance
    user.balance -= totalCost;

    // 3. Update Portfolio & Average Entry Price (AEP)
    const assetIndex = user.portfolio.findIndex(p => p.symbol === symbol);
    
    if (assetIndex > -1) {
      // Asset exists: Calculate new Average Entry Price (AEP)
      const oldQty = user.portfolio[assetIndex].quantity;
      const oldAvg = user.portfolio[assetIndex].avgPrice || 0;
      const newQty = oldQty + numQty;
      
      // AEP Formula: ((OldQty * OldPrice) + (NewQty * NewPrice)) / TotalQty
      user.portfolio[assetIndex].avgPrice = ((oldQty * oldAvg) + totalCost) / newQty;
      user.portfolio[assetIndex].quantity = newQty;
    } else {
      // New Asset
      user.portfolio.push({ symbol, quantity: numQty, avgPrice: numPrice });
    }

    // 4. Log the Transaction
    const newTrade = { symbol, type: 'BUY', quantity: numQty, price: numPrice, timestamp: new Date() };
    user.trades.push(newTrade);
    
    await user.save();

    // 5. Send synchronized data back to frontend
    res.json({ 
      success: true, 
      message: 'Trade Executed Successfully',
      balance: user.balance, 
      portfolio: user.portfolio,
      newTrade: user.trades[user.trades.length - 1] 
    });

  } catch (err) {
    console.error("🔥 BUY ERROR:", err);
    res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
  }
});

// --- STRICT SELL ROUTE ---
router.post('/sell', auth, async (req, res) => {
  try {
    const { symbol, quantity, price } = req.body;
    
    const numQty = Number(quantity);
    const numPrice = Number(price);
    const totalRevenue = numQty * numPrice;

    const user = await User.findById(req.user.id);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found in database.' });
    }

    // 1. Check Crypto Balance Exists
    const assetIndex = user.portfolio.findIndex(p => p.symbol === symbol);
    if (assetIndex === -1) {
      return res.status(400).json({ success: false, message: `You do not own any ${symbol}.` });
    }

    const currentPos = user.portfolio[assetIndex];

    // 2. STRICT ASSET CHECK
    if (currentPos.quantity < numQty) {
      return res.status(400).json({ success: false, message: 'Insufficient Crypto Balance.' });
    }

    // 3. Add to Wallet Balance & Deduct Crypto
    user.balance += totalRevenue;
    currentPos.quantity -= numQty;

    // 4. FLOATING-POINT CLEANUP (The "Dust" Fix)
    // If you sell 0.3 of 0.3, JS might leave 0.00000000004. This deletes the empty asset.
    if (currentPos.quantity <= 0.00001) {
      user.portfolio.splice(assetIndex, 1);
    }

    // 5. Log the Transaction
    const newTrade = { symbol, type: 'SELL', quantity: numQty, price: numPrice, timestamp: new Date() };
    user.trades.push(newTrade);
    
    await user.save();

    // 6. Send synchronized data back to frontend
    res.json({ 
      success: true, 
      message: 'Trade Executed Successfully',
      balance: user.balance, 
      portfolio: user.portfolio,
      newTrade: user.trades[user.trades.length - 1] 
    });

  } catch (err) {
    console.error("🔥 SELL ERROR:", err);
    res.status(500).json({ success: false, message: `Server Error: ${err.message}` });
  }
});

module.exports = router;