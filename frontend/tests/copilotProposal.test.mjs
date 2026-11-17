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
  reconcileProposal,
  discardProposal,
  canConfirm,
  canReconcile,
  blocksNewCommand,
  isExpired,
  isUncertainFailure,
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

test('network failures keep the proposal confirmable so a retry reuses its id', async () => {
  const networkError = Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });
  const http = recorder({ executeRejection: networkError });
  const state = createProposalState(payload(), NOW);

  const result = await confirmProposal({ http, state, token: 'token-1', now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.reason, 'EXECUTION_UNCONFIRMED');
  assert.equal(result.state.status, PROPOSAL_STATUS.READY);
  assert.equal(result.state.proposalId, state.proposalId);
  assert.equal(isExpired(result.state, NOW), false);
  assert.equal(canConfirm(result.state, NOW), true);
  assert.equal(http.calls.length, 1);
  assert.deepEqual(http.calls[0].body, { proposalId: 'a'.repeat(48) });
});

test('an uncertain 5xx keeps the proposal instead of discarding it', async () => {
  const failure = Object.assign(new Error('Request failed'), {
    response: {
      status: 500,
      data: { success: false, code: 'COPILOT_ERROR', message: 'Copilot request failed.' }
    }
  });
  const http = recorder({ executeRejection: failure });
  const state = createProposalState(payload(), NOW);

  const result = await confirmProposal({ http, state, token: 'token-1', now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.state.status, PROPOSAL_STATUS.READY);
  assert.equal(canConfirm(result.state, NOW), true);
  assert.equal(isUncertainFailure(failure), true);
  assert.equal(isUncertainFailure(Object.assign(new Error('timeout'), {
    response: { status: 408, data: {} }
  })), true);
});

test('a definitive 4xx rejection discards the proposal and never retries', async () => {
  const failure = Object.assign(new Error('Request failed'), {
    response: {
      status: 409,
      data: { success: false, code: 'PROPOSAL_ALREADY_USED', message: 'Already used.' }
    }
  });
  const http = recorder({ executeRejection: failure });
  const state = createProposalState(payload(), NOW);

  const result = await confirmProposal({ http, state, token: 'token-1', now: NOW });

  assert.equal(result.ok, false);
  assert.equal(result.uncertain, undefined);
  assert.equal(result.reason, 'PROPOSAL_ALREADY_USED');
  assert.equal(result.state.status, PROPOSAL_STATUS.ERROR);
  assert.equal(canConfirm(result.state, NOW), false);
  assert.equal(isUncertainFailure(failure), false);
  // An explicit success:false body is definitive even without a status code.
  const inline = Object.assign(new Error('Rejected'), { code: 'TRADE_REJECTED', definite: true });
  assert.equal(isUncertainFailure(inline), false);
});

test('an unconfirmed execution can be reconciled with the same id after local expiry', async () => {
  const state = { ...createProposalState(payload(), NOW), uncertain: true };
  const later = NOW + 120001;

  assert.equal(isExpired(state, later), true);
  assert.equal(canConfirm(state, later), false);
  assert.equal(canReconcile(state), true);

  const http = recorder({
    executeResponse: { success: true, balance: 5000, executedPrice: 50000, idempotent: true }
  });
  const result = await reconcileProposal({ http, state, token: 'token-1', now: later });

  assert.equal(result.ok, true);
  assert.equal(result.state.status, PROPOSAL_STATUS.EXECUTED);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, '/api/copilot/execute');
  assert.deepEqual(http.calls[0].body, { proposalId: 'a'.repeat(48) });
});

test('reconciling an expired proposal with no execution reports the definitive outcome', async () => {
  const state = { ...createProposalState(payload(), NOW), uncertain: true };
  const failure = Object.assign(new Error('Request failed'), {
    response: {
      status: 410,
      data: { success: false, code: 'PROPOSAL_EXPIRED', message: 'Proposal expired.' }
    }
  });
  const http = recorder({ executeRejection: failure });

  const result = await reconcileProposal({ http, state, token: 'token-1', now: NOW + 120001 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'PROPOSAL_EXPIRED');
  assert.equal(result.definitive, true);
  assert.equal(result.uncertain, undefined);
  assert.equal(result.state.status, PROPOSAL_STATUS.EXPIRED);
  assert.equal(http.calls.length, 1);
  assert.deepEqual(http.calls[0].body, { proposalId: 'a'.repeat(48) });
});

test('reconciliation keeps the proposal when the outcome is still uncertain', async () => {
  const state = { ...createProposalState(payload(), NOW), uncertain: true };
  const http = recorder({
    executeRejection: Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })
  });

  const result = await reconcileProposal({ http, state, token: 'token-1', now: NOW + 1000 });

  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.definitive, false);
  assert.equal(result.state.proposalId, state.proposalId);
  assert.equal(canReconcile(result.state), true);
});

test('retrying after an uncertain failure reuses the original proposal id', async () => {
  const firstHttp = recorder({
    executeRejection: Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' })
  });
  const state = createProposalState(payload(), NOW);

  const first = await confirmProposal({ http: firstHttp, state, token: 'token-1', now: NOW });
  assert.equal(first.uncertain, true);
  assert.equal(first.definitive, false);

  const retryHttp = recorder();
  const retry = await confirmProposal({
    http: retryHttp,
    state: first.state,
    token: 'token-1',
    now: NOW + 1000
  });

  assert.equal(retry.ok, true);
  assert.equal(retryHttp.calls.length, 1);
  assert.deepEqual(retryHttp.calls[0].body, { proposalId: state.proposalId });
});

test('a new command is blocked while an execution remains uncertain', () => {
  assert.equal(blocksNewCommand({ uncertain: true }), true);
  assert.equal(blocksNewCommand({ uncertain: false }), false);
  assert.equal(blocksNewCommand(null), false);
  assert.equal(canReconcile(null), false);
  assert.equal(canReconcile({ status: PROPOSAL_STATUS.READY }), false);

  const source = fs.readFileSync(
    path.join(here, '..', 'src', 'components', 'AICopilot.jsx'),
    'utf8'
  );
  const commandSection = source.slice(
    source.indexOf('const handleCommand'),
    source.indexOf('const reportExecutionSuccess')
  );
  assert.match(commandSection, /blocksNewCommand\(proposal\)/);
  // The guard must run before the proposal is cleared.
  assert.ok(
    commandSection.indexOf('blocksNewCommand(proposal)') < commandSection.indexOf('setProposal(null)')
  );
  assert.match(source, /canReconcile\(current\)/);
  assert.match(source, /reconcileProposal/);
  assert.match(source, /UNCONFIRMED/);
  assert.match(source, /Execution outcome is unknown/);
  assert.match(source, /Resolve & discard/);
  assert.match(source, /No trade was created/);
});

test('AICopilot keeps an unconfirmed proposal and routes confirmation through the controller', () => {
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
  assert.match(source, /result\.uncertain/);
  assert.match(source, /setProposal\(result\.state\)/);
  assert.doesNotMatch(source, /api\.post\('\/api\/copilot\/execute'/);
});
