const express = require('express');
const { rateLimit } = require('express-rate-limit');
const User = require('../models/User');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const auth = require('../middleware/auth');
const { rateLimitOptions } = require('../middleware/rateLimit');
const { getJwtSecret, getRateLimitConfig } = require('../config/env');
const { loadConsistentAccountView } = require('../services/accountView');
const { validateSymbolFormat } = require('../lib/validate');
const { symbolUniverse } = require('../services/symbolUniverse');

const MAX_EMAIL_LENGTH = 254;
const MAX_USERNAME_LENGTH = 50;
const MAX_WATCHLIST_SYMBOLS = 25;
// bcrypt only considers the first 72 UTF-8 bytes. Enforcing the limit on signup
// prevents silently truncated credentials.
const MAX_PASSWORD_LENGTH = 72;
// Allowlist of the fields the account view reads. The password hash is never
// loaded for session restoration; an exclusion projection would still fetch a
// document the hash analysis treats as password-bearing. `updatedAt` lets the
// view detect an account write that raced its collection reads.
const ACCOUNT_VIEW_FIELDS = 'username email balance lockedBalance portfolio pendingOrders trades watchlist updatedAt';
// New accounts must use a dotted domain. Accounts created before this rule may
// hold a local-only domain (for example "trader@localhost"); login accepts any
// single @ with a non-empty local part so those owners can still authenticate.
const SIGNUP_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LOGIN_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

function readBodyObject(body) {
  return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
}

function normalizeEmail(value, pattern = SIGNUP_EMAIL_PATTERN) {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH || !pattern.test(email)) return null;
  return email;
}

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim();
  if (!username || username.length > MAX_USERNAME_LENGTH) return null;
  return username;
}

function readSignupPassword(value) {
  if (typeof value !== 'string') return null;
  if (!value) return null;
  if (Buffer.byteLength(value, 'utf8') > MAX_PASSWORD_LENGTH) return null;
  return value;
}

// Login has no byte limit so accounts hashed from longer passwords before the
// signup limit existed can still authenticate. bcrypt.compare applies the same
// 72-byte truncation to the input and the stored hash.
function readLoginPassword(value) {
  if (typeof value !== 'string') return null;
  if (!value) return null;
  return value;
}

async function buildUserPayload(user) {
  const view = await loadConsistentAccountView(user);
  return {
    id: view.id,
    username: view.username,
    email: view.email,
    balance: view.balance,
    lockedBalance: view.lockedBalance,
    portfolio: view.portfolio,
    trades: view.trades,
    pendingOrders: view.pendingOrders,
    watchlist: view.watchlist
  };
}

// The watchlist accepts only symbols the catalogue currently trades. Format is
// checked first so a malformed entry reports its own error instead of being
// silently dropped.
function parseWatchlist(input) {
  if (!Array.isArray(input)) {
    return { ok: false, error: 'Watchlist must be an array of symbols.' };
  }
  if (input.length > MAX_WATCHLIST_SYMBOLS) {
    return { ok: false, error: `Watchlist supports at most ${MAX_WATCHLIST_SYMBOLS} symbols.` };
  }

  const symbols = [];
  const seen = new Set();
  for (const entry of input) {
    const formatCheck = validateSymbolFormat(entry);
    if (!formatCheck.ok) return { ok: false, error: formatCheck.error };
    if (!symbolUniverse.isActive(formatCheck.value)) {
      return { ok: false, error: `Unsupported symbol: ${formatCheck.value}.` };
    }
    if (seen.has(formatCheck.value)) continue;
    seen.add(formatCheck.value);
    symbols.push(formatCheck.value);
  }
  return { ok: true, value: symbols };
}

function createAuthRouter({ rateLimits = getRateLimitConfig() } = {}) {
  const router = express.Router();

  const credentialsLimiter = rateLimits.auth.max > 0 && rateLimits.auth.windowMs > 0
    ? rateLimit(rateLimitOptions(rateLimits.auth))
    : (_req, _res, next) => next();
  const readLimiter = rateLimits.authRead.max > 0 && rateLimits.authRead.windowMs > 0
    ? rateLimit(rateLimitOptions(rateLimits.authRead))
    : (_req, _res, next) => next();

  // @route    GET api/auth/me
  // @desc     Get current user data (The "Refresh Fix")
  // @access   Private
  // The read limiter precedes authentication so unauthenticated traffic cannot
  // force unbounded JWT verification. Before `auth` there is no user id, so the
  // limiter keys by client IP.
  router.get('/me', readLimiter, auth, async (req, res) => {
    try {
      // Orders and trades are canonical collections; embedded legacy arrays are
      // still merged until the gated migration is explicitly applied.
      const user = await User.findById(req.user.id, ACCOUNT_VIEW_FIELDS).lean();

      if (!user) return res.status(404).json({ msg: "User not found" });

      res.json(await buildUserPayload(user));
    } catch (err) {
      console.error("Auth Me Error:", err.message);
      res.status(500).send("Server Error");
    }
  });

  // @route    GET api/auth/watchlist
  // @desc     Read the caller's pinned market symbols
  // @access   Private
  router.get('/watchlist', readLimiter, auth, async (req, res) => {
    try {
      const user = await User.findById(req.user.id, 'watchlist').lean();
      if (!user) return res.status(404).json({ msg: 'User not found' });
      res.json({ symbols: (user.watchlist || []).filter(symbol => typeof symbol === 'string') });
    } catch (err) {
      console.error('Watchlist read error:', err.message);
      res.status(500).send('Server Error');
    }
  });

  // @route    PUT api/auth/watchlist
  // @desc     Replace the caller's pinned market symbols
  // @access   Private
  router.put('/watchlist', readLimiter, auth, async (req, res) => {
    try {
      const body = readBodyObject(req.body);
      const parsed = parseWatchlist(body.symbols);
      if (!parsed.ok) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_WATCHLIST',
          message: parsed.error
        });
      }

      const result = await User.updateOne(
        { _id: req.user.id },
        { $set: { watchlist: parsed.value } }
      );
      if (result.matchedCount === 0) return res.status(404).json({ msg: 'User not found' });

      res.json({ symbols: parsed.value });
    } catch (err) {
      console.error('Watchlist update error:', err.message);
      res.status(500).send('Server Error');
    }
  });

  // SIGNUP: Register a new user
  router.post('/signup', credentialsLimiter, async (req, res) => {
    try {
      const body = readBodyObject(req.body);
      const username = normalizeUsername(body.username);
      const email = normalizeEmail(body.email);
      const password = readSignupPassword(body.password);

      if (!username || !email || !password) {
        return res.status(400).json({ msg: "Please enter a valid username, email, and password." });
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
  router.post('/login', credentialsLimiter, async (req, res) => {
    try {
      const body = readBodyObject(req.body);
      const email = normalizeEmail(body.email, LOGIN_EMAIL_PATTERN);
      const password = readLoginPassword(body.password);

      // Reject non-string or malformed credentials before building a query.
      // This prevents NoSQL operator objects such as { "$ne": null } from
      // reaching MongoDB as a query selector.
      if (!email || !password) {
        return res.status(400).json({ msg: "Invalid email or password." });
      }

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

  return router;
}

module.exports = { createAuthRouter };
