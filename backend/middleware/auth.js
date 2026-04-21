const jwt = require('jsonwebtoken');

module.exports = (req, res, next) => {
  // 1. We changed this line to look for 'x-auth-token' to perfectly match your React frontend
  const token = req.header('x-auth-token');
  
  if (!token) return res.status(401).json({ message: 'Access Denied' });

  try {
    // 2. We added the fallback secret here just in case your .env file isn't loading perfectly
    const verified = jwt.verify(token, process.env.JWT_SECRET || 'NexusTrade_Secret_Key');
    req.user = verified;
    next();
  } catch (err) {
    res.status(400).json({ message: 'Invalid Token' });
  }
};