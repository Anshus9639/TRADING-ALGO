export const DEFAULT_DEV_API_URL = 'http://localhost:5000';

function normalizeMode(env) {
  return String(env.MODE || env.NODE_ENV || 'development').toLowerCase();
}

export function resolveApiUrl(env = {}) {
  const mode = normalizeMode(env);
  const raw = typeof env.VITE_API_URL === 'string' ? env.VITE_API_URL.trim() : '';

  if (!raw) {
    if (mode === 'production') {
      throw new Error('VITE_API_URL must be set for production builds.');
    }
    return DEFAULT_DEV_API_URL;
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('VITE_API_URL must be a valid absolute URL.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('VITE_API_URL must use http or https.');
  }

  return raw.replace(/\/+$/, '');
}

export function resolveApiOrigin(env = {}) {
  return new URL(resolveApiUrl(env)).origin;
}

export function buildAuthHeaders(token) {
  return { headers: { 'x-auth-token': token } };
}
