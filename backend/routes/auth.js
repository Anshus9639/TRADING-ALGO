const router = require('express').Router();
const User = require('../models/User'); // Makes sure this path points to your User model
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// SIGNUP: Register a new user
router.post('/signup', async (req, res) => {
  try {
    const { username, email, password } = req.body;

    // 1. Validation
    if (!username || !email || !password) {
      return res.status(400).json({ msg: "Please enter all fields" });
    }

    // 2. Check if user already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) return res.status(400).json({ msg: "A user with this email already exists." });

    // 3. Hash the password (Security)
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // 4. Create the User in MongoDB
    const newUser = new User({
      username,
      email,
      password: hashedPassword,
      balance: 10000 // Starting balance from your schema
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
    
    // 1. Find user by email
    const user = await User.findOne({ email });
    if (!user) return res.status(400).json({ msg: "No account found with this email." });

    // 2. Compare passwords
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ msg: "Invalid password." });

    // 3. Create the JWT Token (Your "ID Card")
    const token = jwt.sign(
      { id: user._id }, 
      process.env.JWT_SECRET || 'NexusTrade_Secret_Key', 
      { expiresIn: '24h' }
    );

    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        balance: user.balance
      }
    });

  } catch (err) {
    res.status(500).json({ msg: "Server error during login" });
  }
});

module.exports = router;