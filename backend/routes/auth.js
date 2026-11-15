const router = require('express').Router();
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const { getJwtSecret } = require('../config/env');
const { loadAccountView } = require('../services/accountView');

async function buildUserPayload(user) {
  const view = await loadAccountView(user);
  return {
    id: view.id,
    username: view.username,
    email: view.email,
    balance: view.balance,
    lockedBalance: view.lockedBalance,
    portfolio: view.portfolio,
    trades: view.trades,
    pendingOrders: view.pendingOrders
  };
}

// @route    GET api/auth/me
// @desc     Get current user data (The "Refresh Fix")
// @access   Private
router.get('/me', auth, async (req, res) => {
  try {
    // Orders and trades are canonical collections; embedded legacy arrays are
    // still merged until the gated migration is explicitly applied.
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) return res.status(404).json({ msg: "User not found" });

    res.json(await buildUserPayload(user));
  } catch (err) {
    console.error("Auth Me Error:", err.message);
    res.status(500).send("Server Error");
  }
});

// SIGNUP: Register a new user
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ msg: "Please enter all fields" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ msg: "A user with this email already exists." });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      balance: 10000 
    });

    await newUser.save();
    res.json({ msg: "Registration successful! You can now log in." });

  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ msg: "Server error during signup" });
  }
});

// LOGIN: Verify user and return a Token
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "No account found with this email." });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid password." });

    const token = jwt.sign(
      { user: { id: user._id } }, // 🚀 Matches the standard middleware format
      getJwtSecret(),
      { expiresIn: '24h' }
    );

    const payload = await buildUserPayload(user);
    delete payload.email;

    res.json({ token, user: payload });

  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ msg: "Server error during login" });
  }
});

module.exports = router;
