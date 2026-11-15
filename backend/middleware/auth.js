const jwt = require('jsonwebtoken');
const { getJwtSecret } = require('../config/env');

module.exports = function (req, res, next) {
  // Get token from header
  const token = req.header('x-auth-token');

  // Check if no token
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  let secret;
  try {
    secret = getJwtSecret();
  } catch {
    return res.status(500).json({ msg: 'Server authentication is not configured' });
  }

  // Verify token
  try {
    const decoded = jwt.verify(token, secret);
    if (!decoded || !decoded.user || !decoded.user.id) {
      return res.status(401).json({ msg: 'Token is not valid' });
    }
    req.user = decoded.user; // 🚀 This must match the way you signed the token
    next();
  } catch (err) {
    res.status(401).json({ msg: 'Token is not valid' });
  }
};
