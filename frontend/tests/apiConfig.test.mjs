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

test('production requires an explicit API URL regardless of the selected mode', () => {
  assert.throws(
    () => resolveApiUrl({ MODE: 'production' }),
    /VITE_API_URL must be set/
  );
  assert.throws(
    () => resolveApiUrl({ MODE: 'production', VITE_API_URL: '   ' }),
    /VITE_API_URL must be set/
  );
  // `vite build --mode staging` still produces a production bundle.
  assert.throws(
    () => resolveApiUrl({ MODE: 'staging', PROD: true }),
    /VITE_API_URL must be set/
  );
  assert.throws(
    () => resolveApiUrl({ MODE: 'staging', NODE_ENV: 'production' }),
    /VITE_API_URL must be set/
  );
  // A dev server keeps the localhost default even when MODE is custom.
  assert.equal(resolveApiUrl({ MODE: 'staging', PROD: false }), DEFAULT_DEV_API_URL);
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

const RENDER_DOMAIN = 'onrender.com';
const URL_PATTERN = /https?:\/\/[^\s'"`)]+/g;

// Compare the parsed hostname exactly or at a dot boundary. Substring checks
// would accept evil-onrender.com and trusted.onrender.com.attacker.example.
function isRenderDeploymentUrl(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === RENDER_DOMAIN || hostname.endsWith(`.${RENDER_DOMAIN}`);
}

function renderDeploymentUrlsInSource(source) {
  return (source.match(URL_PATTERN) || []).filter(candidate => {
    try {
      return isRenderDeploymentUrl(candidate);
    } catch {
      return false;
    }
  });
}

test('Render hostname detection respects domain boundaries', () => {
  assert.equal(isRenderDeploymentUrl('https://service.onrender.com'), true);
  assert.equal(isRenderDeploymentUrl('https://api.service.onrender.com:443/v1'), true);
  assert.equal(isRenderDeploymentUrl('https://onrender.com'), true);
  assert.equal(isRenderDeploymentUrl('https://evil-onrender.com'), false);
  assert.equal(isRenderDeploymentUrl('https://trusted.onrender.com.attacker.example'), false);
  assert.equal(isRenderDeploymentUrl('https://service.onrender.com.attacker.example'), false);
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
    assert.deepEqual(
      renderDeploymentUrlsInSource(source),
      [],
      `${file} still contains a hardcoded Render API URL`
    );
    assert.ok(!source.includes("from 'axios'"), `${file} bypasses the shared axios client`);
  }

  const appSource = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
  assert.match(appSource, /io\(API_ORIGIN\)/);
});
