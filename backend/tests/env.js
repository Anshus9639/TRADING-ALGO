process.env.NODE_ENV = 'test';
// Deterministic, test-only values. Never used outside the test process.
process.env.JWT_SECRET = 'test-only-jwt-secret-not-used-outside-tests-0123456789';
process.env.GEMINI_API_KEY = 'test-only-gemini-key';
