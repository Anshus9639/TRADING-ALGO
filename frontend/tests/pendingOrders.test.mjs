import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPendingSubmissionMap,
  readTokenScope
} from '../src/lib/pendingOrders.mjs';
import { createClientOrderId } from '../src/lib/orderId.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function base64Url(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function tokenFor(subject) {
  return [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({ user: { id: subject } }),
    'signature'
  ].join('.');
}

function createStorage() {
  const data = new Map();
  return {
    data,
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    }
  };
}

test('the token subject becomes the storage scope, never the token itself', () => {
  const token = tokenFor('user-123');
  assert.equal(readTokenScope(token), 'user-123');
  assert.equal(readTokenScope('not-a-jwt'), null);
  assert.equal(readTokenScope(`${base64Url({})}.not-json.signature`), null);

  const storage = createStorage();
  const submissions = createPendingSubmissionMap({ token, storage });
  const id = createClientOrderId();
  submissions.set('/api/trade/buy|BUY|BTCUSDT|0.1|MARKET', id);

  assert.match(submissions.storageKey, /user-123$/);
  assert.equal(submissions.storageKey.includes(token), false);
  for (const [key, value] of storage.data) {
    assert.equal(key.includes(token), false);
    assert.equal(value.includes(token), false);
    assert.equal(value.includes('signature'), false);
  }
});

test('an unresolved key survives a refresh for the same user', () => {
  const storage = createStorage();
  const token = tokenFor('user-123');
  const requestKey = '/api/trade/limit|BUY|ETHUSDT|1|2500';
  const id = createClientOrderId();

  const before = createPendingSubmissionMap({ token, storage });
  before.set(requestKey, id);

  // A fresh component instance after a page refresh rehydrates the same key.
  const after = createPendingSubmissionMap({ token, storage });
  assert.equal(after.size(), 1);
  assert.equal(after.get(requestKey), id);

  after.delete(requestKey);
  assert.equal(createPendingSubmissionMap({ token, storage }).size(), 0);
});

test('persisted keys are isolated per user', () => {
  const storage = createStorage();
  const firstToken = tokenFor('user-a');
  const secondToken = tokenFor('user-b');
  const requestKey = '/api/trade/buy|BUY|BTCUSDT|0.1|MARKET';
  const id = createClientOrderId();

  createPendingSubmissionMap({ token: firstToken, storage }).set(requestKey, id);

  const other = createPendingSubmissionMap({ token: secondToken, storage });
  assert.equal(other.size(), 0);
  assert.equal(other.get(requestKey), undefined);

  // Logging out (no token) keeps the map in memory only.
  const anonymous = createPendingSubmissionMap({ token: null, storage });
  anonymous.set(requestKey, createClientOrderId());
  assert.equal(storage.data.size, 1);
});

test('stale, corrupt and malformed entries are discarded on load', () => {
  const storage = createStorage();
  const token = tokenFor('user-123');
  const requestKey = '/api/trade/buy|BUY|BTCUSDT|0.1|MARKET';
  const map = createPendingSubmissionMap({ token, storage, now: () => 1_000_000 });
  map.set(requestKey, createClientOrderId());

  // One day later the entry is stale and must not be reused.
  const later = createPendingSubmissionMap({
    token,
    storage,
    now: () => 1_000_000 + (24 * 60 * 60 * 1000) + 1
  });
  assert.equal(later.size(), 0);

  storage.setItem(map.storageKey, '{not json');
  assert.equal(createPendingSubmissionMap({ token, storage }).size(), 0);

  storage.setItem(map.storageKey, JSON.stringify({
    version: 1,
    entries: {
      [requestKey]: { clientOrderId: 'not-a-uuid', savedAt: Date.now() },
      '/api/trade/buy|SELL|BTCUSDT|0.1|MARKET': { clientOrderId: createClientOrderId() }
    }
  }));
  const filtered = createPendingSubmissionMap({ token, storage });
  assert.equal(filtered.size(), 0);

  assert.throws(
    () => filtered.set(requestKey, 'not-a-uuid'),
    /Invalid client order id/
  );
});

test('QuickOrder persists unresolved keys without persisting the token', () => {
  const source = fs.readFileSync(
    path.join(here, '..', 'src', 'components', 'QuickOrder.jsx'),
    'utf8'
  );

  assert.match(source, /createPendingSubmissionMap\(\{ token \}\)/);
  assert.match(source, /pendingSubmissions\.current\.size\(\)/);
  assert.match(source, /An earlier submission is unresolved/);
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /pendingSubmissions\.current = new Map\(\)/);
});
