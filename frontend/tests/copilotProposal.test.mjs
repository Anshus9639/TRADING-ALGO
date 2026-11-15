import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROPOSAL_STATUS,
  createProposalState,
  createConfirmLock,
  requestProposal,
  confirmProposal,
  discardProposal,
  canConfirm,
  isExpired,
  formatRemaining
} from '../src/lib/copilotProposal.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOW = 1_700_000_000_000;

function payload(overrides = {}) {
  return {
    success: true,
    proposalId: 'a'.repeat(48),
    intent: { side: 'BUY', symbol: 'BTCUSDT', orderType: 'MARKET', quantity: 0.1 },
    preview: {
      side: 'BUY',
      symbol: 'BTCUSDT',
      orderType: 'MARKET',
      quantity: 0.1,
      quotePrice: 50000,
      estimatedValue: 5000,
      warnings: []
    },
    expiresAt: new Date(NOW + 120000).toISOString(),
    ...overrides
  };
}

function recorder({ parseResponse = payload(), executeResponse, executeRejection } = {}) {
  const calls = [];
  return {
    calls,
    async post(url, body, config) {
      calls.push({ url, body, config });
      if (url === '/api/copilot/parse') return { data: parseResponse };
      if (url.endsWith('/revoke')) return { data: { success: true, revoked: true } };
      if (executeRejection) throw executeRejection;
      return { data: executeResponse || { success: true, balance: 5000, executedPrice: 50000 } };
    }
  };
}

test('parsing displays a proposal without executing anything', async () => {
  const http = recorder();
  const state = await requestProposal({ http, prompt: 'Buy 0.1 BTC', token: 'token-1', now: NOW });

  assert.equal(state.status, PROPOSAL_STATUS.READY);
  assert.equal(state.proposalId, 'a'.repeat(48));
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/api/copilot/parse');
  assert.deepEqual(http.calls[0].body, { prompt: 'Buy 0.1 BTC' });
  assert.equal(http.calls[0].config.headers['x-auth-token'], 'token-1');
});

test('confirm sends only the proposalId and keeps the auth header', async () => {
  const http = recorder();
  const state = createProposalState(payload(), NOW);

  const result = await confirmProposal({ http, state, token: 'token-1', now: NOW });

  assert.equal(result.ok, true);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/api/copilot/execute');
  assert.deepEqual(http.calls[0].body, { proposalId: 'a'.repeat(48) });
  assert.equal(http.calls[0].config.headers['x-auth-token'], 'token-1');
});

test('discard revokes server-side and never sends a trade request', async () => {
  const http = recorder();
  const state = createProposalState(payload(), NOW);

  const result = await discardProposal({ http, state, token: 'token-1' });

  assert.equal(result.ok, true);
  assert.equal(result.state, null);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, `/api/copilot/proposals/${'a'.repeat(48)}/revoke`);
  assert.deepEqual(http.calls[0].body, {});
  assert.equal(http.calls[0].config.headers['x-auth-token'], 'token-1');
  assert.equal(http.calls.some(call => call.url === '/api/copilot/execute'), false);
});

test('discard failure keeps the proposal so the user can retry', async () => {
  const state = createProposalState(payload(), NOW);
  const http = {
    async post() {
      throw Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
    }
  };

  const result = await discardProposal({ http, state, token: 'token-1' });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'REVOKE_FAILED');
  assert.equal(result.state.proposalId, state.proposalId);
});

test('discard clears locally when the proposal can no longer be used', async () => {
  const state = createProposalState(payload(), NOW);
  const http = {
    async post() {
      throw {
        response: {
          status: 409,
          data: { success: false, code: 'PROPOSAL_ALREADY_USED', message: 'Already used.' }
        }
      };
    }
  };

  const result = await discardProposal({ http, state, token: 'token-1' });

  assert.equal(result.ok, true);
  assert.equal(result.state, null);
});

test('expiry disables Confirm and blocks execution without a request', async () => {
  const http = recorder();
  const state = createProposalState(payload(), NOW);
  const later = NOW + 120000;

  assert.equal(isExpired(state, later), true);
  assert.equal(canConfirm(state, later), false);
  assert.equal(formatRemaining(state, later), '0s');

  const result = await confirmProposal({ http, state, token: 'token-1', now: later });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'EXPIRED');
  assert.equal(result.state.status, PROPOSAL_STATUS.EXPIRED);
  assert.equal(http.calls.length, 0);
});

test('double-click cannot create a duplicate execution', async () => {
  const calls = [];
  let resolveExecute;
  const http = {
    async post(url, body, config) {
      calls.push({ url, body, config });
      return new Promise(resolve => {
        resolveExecute = resolve;
      });
    }
  };
  const state = createProposalState(payload(), NOW);
  const lock = createConfirmLock();

  const first = confirmProposal({ http, state, token: 'token-1', now: NOW, lock });
  const second = await confirmProposal({ http, state, token: 'token-1', now: NOW, lock });

  assert.equal(second.ok, false);
  assert.equal(second.reason, 'BUSY');

  resolveExecute({ data: { success: true, balance: 5000 } });
  const firstResult = await first;

  assert.equal(firstResult.ok, true);
  assert.equal(calls.length, 1);
});

test('PRICE_CHANGED discards the proposal and requires a fresh one', async () => {
  const rejection = Object.assign(new Error('Request failed'), {
    response: {
      status: 409,
      data: { success: false, code: 'PRICE_CHANGED', message: 'Price moved.' }
    }
  });
  const http = recorder({ executeRejection: rejection });
  const state = createProposalState(payload(), NOW);

  const result = await confirmProposal({ http, state, token: 'token-1', now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PRICE_CHANGED');
  assert.equal(result.state.status, PROPOSAL_STATUS.PRICE_CHANGED);
  assert.equal(canConfirm(result.state, NOW), false);
  assert.equal(formatRemaining(createProposalState(payload(), NOW), NOW + 55000), '1m 05s');
});

test('invalid proposal payloads are rejected', () => {
  assert.throws(() => createProposalState({}, NOW), /Invalid proposal/);
  assert.throws(
    () => createProposalState(payload({ expiresAt: 'not-a-date' }), NOW),
    /Invalid proposal/
  );
});

test('AICopilot keeps its logs/layout and routes confirmation through the controller', () => {
  const source = fs.readFileSync(
    path.join(here, '..', 'src', 'components', 'AICopilot.jsx'),
    'utf8'
  );

  assert.match(source, /Bruda Bot/);
  assert.match(source, /Thinking\.\.\./);
  assert.match(source, /Success:/);
  assert.match(source, /Trade Proposal/);
  assert.match(source, /Confirm/);
  assert.match(source, /Discard/);
  assert.match(source, /confirmProposal/);
  assert.match(source, /requestProposal/);
  assert.doesNotMatch(source, /api\.post\('\/api\/copilot\/execute'/);
});
