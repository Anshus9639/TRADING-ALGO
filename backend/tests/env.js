process.env.NODE_ENV = 'test';
// Deterministic, test-only values. Never used outside the test process.
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-outside-tests-0123456789';
process.env.GEMINI_API_KEY = 'test-only-gemini-key';

// Keep unrelated suites from tripping shared-IP limits; rateLimit.test.js
// injects explicit low limits to prove enforcement.
process.env.AUTH_RATE_LIMIT_MAX = '10000';
process.env.AUTH_RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.AUTH_READ_RATE_LIMIT_MAX = '10000';
process.env.AUTH_READ_RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.TRADE_RATE_LIMIT_MAX = '10000';
process.env.TRADE_RATE_LIMIT_WINDOW_SECONDS = '60';
process.env.COPILOT_RATE_LIMIT_MAX = '1000';
process.env.COPILOT_RATE_LIMIT_WINDOW_SECONDS = '60';
