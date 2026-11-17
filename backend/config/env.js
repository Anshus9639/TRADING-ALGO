const path = require('path');

// Load backend/.env once. Existing process env values always win, so tests and
// hosts can override without the file leaking values into logs.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const MIN_JWT_SECRET_LENGTH = 32;
const DEFAULT_PORT = 5000;
const DEFAULT_CORS_ORIGINS = Object.freeze([
  'http://localhost:3000',
  'http://localhost:5173',
  'https://trading-algo-oa9r.vercel.app'
]);
const LOCAL_DB_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
const DEFAULT_GEMINI_TIMEOUT_MS = 8000;
const DEFAULT_PROPOSAL_TTL_MS = 120000;
const DEFAULT_MAX_PRICE_DRIFT_PCT = 1.5;
const DEFAULT_COPILOT_RATE_LIMIT_MAX = 10;
const DEFAULT_COPILOT_RATE_LIMIT_WINDOW_MS = 60000;
const DEFAULT_AUTH_RATE_LIMIT_MAX = 10;
const DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_READ_RATE_LIMIT_MAX = 120;
const DEFAULT_AUTH_READ_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DEFAULT_TRADE_RATE_LIMIT_MAX = 60;
const DEFAULT_TRADE_RATE_LIMIT_WINDOW_MS = 60 * 1000;

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readString(env, name) {
  const value = env[name];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value.trim();
}

function normalizeNodeEnv(value) {
  const nodeEnv = readString({ NODE_ENV: value }, 'NODE_ENV');
  return nodeEnv ? nodeEnv.toLowerCase() : 'development';
}

function parsePort(value) {
  if (value === undefined || value === null || String(value).trim() === '') return DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError('PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function parseCorsOrigins(value) {
  if (typeof value !== 'string' || value.trim() === '') return [...DEFAULT_CORS_ORIGINS];

  const origins = value.split(',').map(item => item.trim()).filter(Boolean);
  if (origins.length === 0) return [...DEFAULT_CORS_ORIGINS];

  for (const origin of origins) {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      throw new ConfigError('CORS_ORIGINS must be a comma-separated list of absolute URLs.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ConfigError('CORS_ORIGINS entries must use http or https.');
    }
  }

  return origins;
}

function extractMongoHost(seed) {
  const host = seed.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > -1 ? host.slice(1, end).toLowerCase() : '';
  }
  return host.split(':')[0].toLowerCase();
}

// A replica-set URI may list several seeds. The connection is remote if ANY
// seed is nonlocal: the driver can route operations to that member.
function isRemoteMongoUri(uri) {
  const match = /^mongodb(?:\+srv)?:\/\/(?:[^@/]+@)?([^/?]+)/i.exec(uri);
  if (!match) return false;
  const hosts = match[1]
    .split(',')
    .map(extractMongoHost)
    .filter(Boolean);
  if (hosts.length === 0) return false;
  return hosts.some(host => !LOCAL_DB_HOSTS.has(host));
}

function parseBoundedNumber(value, name, { fallback, min, max, allowZero = false }) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const number = Number(value);
  const lowerBoundOk = allowZero ? number >= min : number > min;
  if (!Number.isFinite(number) || !lowerBoundOk || number > max) {
    throw new ConfigError(`${name} must be a number between ${min} and ${max}.`);
  }
  return number;
}

function readOptionalPositive(value, name, max) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > max) {
    throw new ConfigError(`${name} must be a positive number.`);
  }
  return number;
}

function parseTrustProxy(value, nodeEnv) {
  if (value === undefined || value === null || String(value).trim() === '') {
    // Render terminates TLS at a single proxy hop. Anything else (local, test)
    // must not trust forwarded headers.
    return nodeEnv === 'production' ? 1 : false;
  }

  const raw = String(value).trim().toLowerCase();
  if (raw === 'false') return false;
  if (raw === 'true') {
    throw new ConfigError(
      'TRUST_PROXY must be a hop count (0-5), not true, so arbitrary forwarded headers are never trusted.'
    );
  }

  const hops = Number(raw);
  if (!Number.isInteger(hops) || hops < 0 || hops > 5) {
    throw new ConfigError('TRUST_PROXY must be false or an integer hop count between 0 and 5.');
  }
  return hops === 0 ? false : hops;
}

function getRateLimitConfig(env = process.env) {
  return {
    auth: {
      max: Math.round(parseBoundedNumber(env.AUTH_RATE_LIMIT_MAX, 'AUTH_RATE_LIMIT_MAX', {
        fallback: DEFAULT_AUTH_RATE_LIMIT_MAX,
        min: 0,
        max: 100000,
        allowZero: true
      })),
      windowMs: Math.round(parseBoundedNumber(env.AUTH_RATE_LIMIT_WINDOW_SECONDS, 'AUTH_RATE_LIMIT_WINDOW_SECONDS', {
        fallback: DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS / 1000,
        min: 0,
        max: 86400,
        allowZero: true
      }) * 1000)
    },
    authRead: {
      max: Math.round(parseBoundedNumber(env.AUTH_READ_RATE_LIMIT_MAX, 'AUTH_READ_RATE_LIMIT_MAX', {
        fallback: DEFAULT_AUTH_READ_RATE_LIMIT_MAX,
        min: 0,
        max: 100000,
        allowZero: true
      })),
      windowMs: Math.round(parseBoundedNumber(env.AUTH_READ_RATE_LIMIT_WINDOW_SECONDS, 'AUTH_READ_RATE_LIMIT_WINDOW_SECONDS', {
        fallback: DEFAULT_AUTH_READ_RATE_LIMIT_WINDOW_MS / 1000,
        min: 0,
        max: 86400,
        allowZero: true
      }) * 1000)
    },
    trade: {
      max: Math.round(parseBoundedNumber(env.TRADE_RATE_LIMIT_MAX, 'TRADE_RATE_LIMIT_MAX', {
        fallback: DEFAULT_TRADE_RATE_LIMIT_MAX,
        min: 0,
        max: 100000,
        allowZero: true
      })),
      windowMs: Math.round(parseBoundedNumber(env.TRADE_RATE_LIMIT_WINDOW_SECONDS, 'TRADE_RATE_LIMIT_WINDOW_SECONDS', {
        fallback: DEFAULT_TRADE_RATE_LIMIT_WINDOW_MS / 1000,
        min: 0,
        max: 86400,
        allowZero: true
      }) * 1000)
    }
  };
}

function getCopilotConfig(env = process.env) {
  return {
    geminiModel: readString(env, 'GEMINI_MODEL') || DEFAULT_GEMINI_MODEL,
    geminiTimeoutMs: parseBoundedNumber(env.GEMINI_TIMEOUT_MS, 'GEMINI_TIMEOUT_MS', {
      fallback: DEFAULT_GEMINI_TIMEOUT_MS,
      min: 0,
      max: 120000
    }),
    proposalTtlMs: Math.round(parseBoundedNumber(env.COPILOT_PROPOSAL_TTL_SECONDS, 'COPILOT_PROPOSAL_TTL_SECONDS', {
      fallback: DEFAULT_PROPOSAL_TTL_MS / 1000,
      min: 0,
      max: 3600
    }) * 1000),
    maxPriceDriftPct: parseBoundedNumber(env.COPILOT_MAX_PRICE_DRIFT_PCT, 'COPILOT_MAX_PRICE_DRIFT_PCT', {
      fallback: DEFAULT_MAX_PRICE_DRIFT_PCT,
      min: 0,
      max: 100,
      allowZero: true
    }),
    rateLimit: {
      max: Math.round(parseBoundedNumber(env.COPILOT_RATE_LIMIT_MAX, 'COPILOT_RATE_LIMIT_MAX', {
        fallback: DEFAULT_COPILOT_RATE_LIMIT_MAX,
        min: 0,
        max: 1000
      })),
      windowMs: Math.round(parseBoundedNumber(env.COPILOT_RATE_LIMIT_WINDOW_SECONDS, 'COPILOT_RATE_LIMIT_WINDOW_SECONDS', {
        fallback: DEFAULT_COPILOT_RATE_LIMIT_WINDOW_MS / 1000,
        min: 0,
        max: 3600
      }) * 1000)
    },
    usdInrRate: readOptionalPositive(env.USD_INR_RATE, 'USD_INR_RATE', 1_000_000)
  };
}

function loadAppConfig(env = process.env) {
  const nodeEnv = normalizeNodeEnv(env.NODE_ENV);
  return {
    nodeEnv,
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    trustProxy: parseTrustProxy(env.TRUST_PROXY, nodeEnv)
  };
}

function loadConfig(env = process.env) {
  const nodeEnv = normalizeNodeEnv(env.NODE_ENV);

  const mongoUri = readString(env, 'MONGO_URI');
  if (!mongoUri) {
    throw new ConfigError('MONGO_URI is required and cannot be blank.');
  }
  if (!/^mongodb(?:\+srv)?:\/\//i.test(mongoUri)) {
    throw new ConfigError('MONGO_URI must be a MongoDB connection string.');
  }

  const jwtSecret = readString(env, 'JWT_SECRET');
  if (!jwtSecret) {
    throw new ConfigError('JWT_SECRET is required and cannot be blank.');
  }
  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters long.`);
  }

  const allowRemoteDbInDev = String(env.ALLOW_REMOTE_DB_IN_DEV).toLowerCase() === 'true';
  if (nodeEnv === 'development' && isRemoteMongoUri(mongoUri) && !allowRemoteDbInDev) {
    throw new ConfigError(
      'Refusing to connect to a remote MongoDB in development. ' +
      'Set ALLOW_REMOTE_DB_IN_DEV=true to override.'
    );
  }

  const geminiApiKey = readString(env, 'GEMINI_API_KEY');
  const copilot = getCopilotConfig(env);

  return {
    nodeEnv,
    isProduction: nodeEnv === 'production',
    isDevelopment: nodeEnv === 'development',
    isTest: nodeEnv === 'test',
    port: parsePort(env.PORT),
    mongoUri,
    jwtSecret,
    allowRemoteDbInDev,
    geminiApiKey,
    geminiConfigured: Boolean(geminiApiKey),
    geminiModel: copilot.geminiModel,
    geminiTimeoutMs: copilot.geminiTimeoutMs,
    copilot,
    trustProxy: parseTrustProxy(env.TRUST_PROXY, nodeEnv),
    rateLimit: getRateLimitConfig(env),
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS)
  };
}

function getJwtSecret(env = process.env) {
  const jwtSecret = readString(env, 'JWT_SECRET');
  if (!jwtSecret || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new ConfigError(
      `JWT_SECRET must be configured with at least ${MIN_JWT_SECRET_LENGTH} characters.`
    );
  }
  return jwtSecret;
}

function getGeminiApiKey(env = process.env) {
  return readString(env, 'GEMINI_API_KEY');
}

function isGeminiConfigured(env = process.env) {
  return Boolean(getGeminiApiKey(env));
}

module.exports = {
  ConfigError,
  MIN_JWT_SECRET_LENGTH,
  DEFAULT_PORT,
  DEFAULT_CORS_ORIGINS,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_TIMEOUT_MS,
  DEFAULT_PROPOSAL_TTL_MS,
  DEFAULT_MAX_PRICE_DRIFT_PCT,
  DEFAULT_COPILOT_RATE_LIMIT_MAX,
  DEFAULT_COPILOT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_AUTH_RATE_LIMIT_MAX,
  DEFAULT_AUTH_RATE_LIMIT_WINDOW_MS,
  DEFAULT_AUTH_READ_RATE_LIMIT_MAX,
  DEFAULT_AUTH_READ_RATE_LIMIT_WINDOW_MS,
  DEFAULT_TRADE_RATE_LIMIT_MAX,
  DEFAULT_TRADE_RATE_LIMIT_WINDOW_MS,
  loadAppConfig,
  loadConfig,
  getJwtSecret,
  getGeminiApiKey,
  isGeminiConfigured,
  getCopilotConfig,
  getRateLimitConfig,
  parseTrustProxy,
  isRemoteMongoUri,
  parseCorsOrigins
};
