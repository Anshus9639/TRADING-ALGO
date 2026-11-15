import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_DEV_API_URL,
  resolveApiUrl,
  resolveApiOrigin,
  buildAuthHeaders
} from '../src/lib/apiConfig.mjs';

test('development defaults to localhost', () => {
  assert.equal(DEFAULT_DEV_API_URL, 'http://localhost:5000');
  assert.equal(resolveApiUrl({}), 'http://localhost:5000');
  assert.equal(resolveApiUrl({ MODE: 'development' }), 'http://localhost:5000');
});

test('configured VITE_API_URL is used', () => {
  assert.equal(
    resolveApiUrl({ MODE: 'production', VITE_API_URL: 'https://api.example.com' }),
    'https://api.example.com'
  );
});

test('trailing slashes are removed from the configured URL', () => {
  assert.equal(
    resolveApiUrl({ MODE: 'development', VITE_API_URL: 'http://localhost:5001///' }),
    'http://localhost:5001'
  );
});

test('invalid URLs are rejected', () => {
  assert.throws(
    () => resolveApiUrl({ VITE_API_URL: 'not-a-url' }),
    /valid absolute URL/
  );
  assert.throws(
    () => resolveApiUrl({ VITE_API_URL: 'ftp://example.com' }),
    /http or https/
  );
});

test('production requires an explicit API URL', () => {
  assert.throws(
    () => resolveApiUrl({ MODE: 'production' }),
    /VITE_API_URL must be set/
  );
  assert.throws(
    () => resolveApiUrl({ MODE: 'production', VITE_API_URL: '   ' }),
    /VITE_API_URL must be set/
  );
});

test('production accepts a valid API URL', () => {
  assert.equal(
    resolveApiUrl({ MODE: 'production', VITE_API_URL: 'https://trading.example.com' }),
    'https://trading.example.com'
  );
});

test('authentication headers preserve the x-auth-token contract', () => {
  assert.deepEqual(buildAuthHeaders('token-123'), {
    headers: { 'x-auth-token': 'token-123' }
  });
});

test('socket origin matches the configured API origin', () => {
  assert.equal(
    resolveApiOrigin({ MODE: 'production', VITE_API_URL: 'https://api.example.com/v1' }),
    'https://api.example.com'
  );
  assert.equal(
    resolveApiOrigin({ MODE: 'development', VITE_API_URL: 'http://localhost:5001/api' }),
    'http://localhost:5001'
  );
});

test('frontend sources use the centralized API helpers only', () => {
  const files = [
    '../src/App.jsx',
    '../src/components/Auth.jsx',
    '../src/components/QuickOrder.jsx',
    '../src/components/AICopilot.jsx',
    '../src/components/ActivityDashboard.jsx'
  ];

  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    assert.ok(!source.includes('onrender.com'), `${file} still contains a hardcoded API URL`);
    assert.ok(!source.includes("from 'axios'"), `${file} bypasses the shared axios client`);
  }

  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(appSource, /io\(API_ORIGIN\)/);
});
