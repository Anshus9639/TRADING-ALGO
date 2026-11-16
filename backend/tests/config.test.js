const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  loadConfig,
  loadAppConfig,
  getJwtSecret,
  isGeminiConfigured,
  getRateLimitConfig,
  parseTrustProxy,
  MIN_JWT_SECRET_LENGTH,
  DEFAULT_CORS_ORIGINS,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  DEFAULT_AUTH_READ_RATE_LIMIT_MAX,
  DEFAULT_TRADE_RATE_LIMIT_MAX
} = require('../config/env');

const LOCAL_URI = 'mongodb://127.0.0.1:27017/nexustrade_test';
const REMOTE_URI = 'mongodb+srv://user:pass@cluster0.example.mongodb.net/nexustrade';
const TEST_SECRET = 'b'.repeat(48);

function baseEnv(overrides = {}) {
  return {
    NODE_ENV: 'development',
    MONGO_URI: LOCAL_URI,
    JWT_SECRET: TEST_SECRET,
    ...overrides
  };
}

describe('backend environment configuration', () => {
  test('rejects a missing or blank MONGO_URI', () => {
    expect(() => loadConfig({ JWT_SECRET: TEST_SECRET })).toThrow(/MONGO_URI/);
    expect(() => loadConfig({ ...baseEnv(), MONGO_URI: '   ' })).toThrow(/MONGO_URI/);
  });

  test('rejects a missing JWT_SECRET', () => {
    expect(() => loadConfig({ MONGO_URI: LOCAL_URI })).toThrow(/JWT_SECRET/);
  });

  test('rejects a JWT_SECRET shorter than 32 characters', () => {
    const shortSecret = 'c'.repeat(MIN_JWT_SECRET_LENGTH - 1);
    expect(() => loadConfig(baseEnv({ JWT_SECRET: shortSecret }))).toThrow(/32/);
  });

  test('accepts a valid local development configuration', () => {
    const config = loadConfig(baseEnv());

    expect(config.nodeEnv).toBe('development');
    expect(config.mongoUri).toBe(LOCAL_URI);
    expect(config.jwtSecret).toBe(TEST_SECRET);
    expect(config.port).toBe(5000);
    expect(config.geminiConfigured).toBe(false);
    expect(config.geminiApiKey).toBeNull();
    expect(config.allowRemoteDbInDev).toBe(false);
    expect(config.corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
  });

  test('treats GEMINI_API_KEY as optional', () => {
    expect(() => loadConfig(baseEnv({ GEMINI_API_KEY: '' }))).not.toThrow();
    expect(loadConfig(baseEnv({ GEMINI_API_KEY: '' })).geminiConfigured).toBe(false);

    const configured = loadConfig(baseEnv({ GEMINI_API_KEY: 'test-key' }));
    expect(configured.geminiConfigured).toBe(true);
    expect(isGeminiConfigured(baseEnv({ GEMINI_API_KEY: 'test-key' }))).toBe(true);
  });

  test('rejects a remote database in development', () => {
    expect(() => loadConfig(baseEnv({ MONGO_URI: REMOTE_URI }))).toThrow(/ALLOW_REMOTE_DB_IN_DEV/);
  });

  test('allows a remote development database with an explicit override', () => {
    const config = loadConfig(baseEnv({ MONGO_URI: REMOTE_URI, ALLOW_REMOTE_DB_IN_DEV: 'true' }));
    expect(config.allowRemoteDbInDev).toBe(true);
    expect(config.mongoUri).toBe(REMOTE_URI);
  });

  test('allows a remote database outside development without an override', () => {
    const config = loadConfig(baseEnv({ NODE_ENV: 'production', MONGO_URI: REMOTE_URI }));
    expect(config.isProduction).toBe(true);
  });

  test('loads app-only configuration without database or JWT secrets', () => {
    expect(() => loadAppConfig({})).not.toThrow();
    expect(loadAppConfig({}).corsOrigins).toEqual([...DEFAULT_CORS_ORIGINS]);
    expect(loadAppConfig({}).trustProxy).toBe(false);
    expect(loadAppConfig({ NODE_ENV: 'production' }).trustProxy).toBe(1);

    const custom = loadAppConfig({ CORS_ORIGINS: 'https://app.example.com, https://admin.example.com' });
    expect(custom.corsOrigins).toEqual(['https://app.example.com', 'https://admin.example.com']);
  });

  test('rate limit defaults are bounded and configurable', () => {
    const defaults = getRateLimitConfig({});
    expect(defaults.auth).toEqual({
      max: DEFAULT_AUTH_RATE_LIMIT_MAX,
      windowMs: 15 * 60 * 1000
    });
    expect(defaults.authRead.max).toBe(DEFAULT_AUTH_READ_RATE_LIMIT_MAX);
    expect(defaults.trade).toEqual({
      max: DEFAULT_TRADE_RATE_LIMIT_MAX,
      windowMs: 60 * 1000
    });

    const custom = getRateLimitConfig({
      AUTH_RATE_LIMIT_MAX: '5',
      AUTH_RATE_LIMIT_WINDOW_SECONDS: '30',
      AUTH_READ_RATE_LIMIT_MAX: '60',
      TRADE_RATE_LIMIT_MAX: '20',
      TRADE_RATE_LIMIT_WINDOW_SECONDS: '10'
    });
    expect(custom.auth).toEqual({ max: 5, windowMs: 30000 });
    expect(custom.authRead).toEqual({ max: 60, windowMs: 60 * 1000 });
    expect(custom.trade).toEqual({ max: 20, windowMs: 10000 });
  });

  test('rejects invalid rate limit settings', () => {
    expect(() => getRateLimitConfig({ AUTH_RATE_LIMIT_MAX: 'abc' })).toThrow(/AUTH_RATE_LIMIT_MAX/);
    expect(() => getRateLimitConfig({ TRADE_RATE_LIMIT_WINDOW_SECONDS: '-1' })).toThrow(/TRADE_RATE_LIMIT_WINDOW_SECONDS/);
  });

  test('trust proxy requires an explicit hop count', () => {
    expect(parseTrustProxy(undefined, 'production')).toBe(1);
    expect(parseTrustProxy(undefined, 'test')).toBe(false);
    expect(parseTrustProxy('false', 'production')).toBe(false);
    expect(parseTrustProxy('0', 'development')).toBe(false);
    expect(parseTrustProxy('2', 'production')).toBe(2);
    expect(() => parseTrustProxy('true', 'production')).toThrow(/hop count/);
  });

  test('getJwtSecret never falls back to a default', () => {
    expect(() => getJwtSecret({})).toThrow(/JWT_SECRET/);
    expect(() => getJwtSecret({ JWT_SECRET: 'too-short' })).toThrow(/32/);
    expect(getJwtSecret({ JWT_SECRET: TEST_SECRET })).toBe(TEST_SECRET);
  });

  test('startup exits clearly when JWT_SECRET is missing', () => {
    const result = spawnSync(process.execPath, ['server.js'], {
      cwd: path.join(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        MONGO_URI: LOCAL_URI,
        JWT_SECRET: ''
      },
      encoding: 'utf8',
      timeout: 15000
    });

    expect(result.status).toBe(1);
    expect(`${result.stderr}${result.stdout}`).toMatch(/JWT_SECRET/);
  });

  test('production sources contain no hardcoded JWT fallback', () => {
    const productionFiles = ['config/env.js', 'middleware/auth.js', 'routes/auth.js'];
    const contents = productionFiles
      .map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8'))
      .join('\n');

    expect(contents).not.toMatch(/NexusTrade_Secret_Key/);
  });
});
