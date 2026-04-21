const router = require('express').Router();
const User = require('../models/User'); 
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth'); // 🚀 Make sure this file exists!

// @route    GET api/auth/me
// @desc     Get current user data (The "Refresh Fix")
// @access   Private
router.get('/me', auth, async (req, res) => {
  try {
    // 🚀 We find the user and "populate" their trades so history shows up on refresh
    const user = await User.findById(req.user.id).select('-password');
    
    if (!user) return res.status(404).json({ msg: "User not found" });

    res.json({
      id: user._id,
      username: user.username,
      email: user.email,
      balance: user.balance,
      portfolio: user.portfolio || [],
      trades: user.trades || []
    });
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

    const user = await User.findOne({ email }).populate('trades');
    if (!user) return res.status(400).json({ msg: "No account found with this email." });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid password." });

    const token = jwt.sign(
      { user: { id: user._id } }, // 🚀 Matches the standard middleware format
      process.env.JWT_SECRET || 'NexusTrade_Secret_Key',
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        balance: user.balance,
        portfolio: user.portfolio || [],
        trades: user.trades || []
      }
    });

  } catch (err) {
    console.error("Login Error:", err);
    res.status(500).json({ msg: "Server error during login" });
  }
});

module.exports = router;