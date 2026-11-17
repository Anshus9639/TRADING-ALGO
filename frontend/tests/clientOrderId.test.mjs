import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClientOrderId, isClientOrderId } from '../src/lib/orderId.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('client order ids are unique and accepted by the backend UUID contract', () => {
  const ids = new Set();
  for (let index = 0; index < 100; index += 1) {
    const id = createClientOrderId();
    assert.equal(isClientOrderId(id), true);
    ids.add(id);
  }
  assert.equal(ids.size, 100);
});

test('client order ids reject malformed values', () => {
  assert.equal(isClientOrderId(''), false);
  assert.equal(isClientOrderId(null), false);
  assert.equal(isClientOrderId('has spaces'), false);
  assert.equal(isClientOrderId('x'.repeat(101)), false);
  assert.equal(isClientOrderId('order-123'), false);
  assert.equal(isClientOrderId('123e4567-e89b-12d3-a456-426614174000'), true);
});

test('QuickOrder sends a clientOrderId and reuses it after network failures', () => {
  const source = fs.readFileSync(
    path.join(here, '..', 'src', 'components', 'QuickOrder.jsx'),
    'utf8'
  );

  assert.match(source, /createClientOrderId/);
  assert.match(source, /payload\.clientOrderId/);
  assert.match(source, /pendingSubmissions\.current\.get\(requestKey\)/);
  assert.match(source, /pendingSubmissions\.current\.set\(requestKey, payload\.clientOrderId\)/);
  // Keys are only retired once the server definitively refused the order.
  assert.match(source, /shouldRetirePendingKey\(status\)/);
  assert.doesNotMatch(source, /status < 500/);
  assert.doesNotMatch(source, /if \(err\.response\) pendingSubmission\.current = null/);
  // A new submission cannot overwrite another unresolved submission's id.
  assert.doesNotMatch(source, /pendingSubmissions\.current = new Map\(\)/);
});

test('AICopilot discard goes through the server-side revocation controller', () => {
  const component = fs.readFileSync(
    path.join(here, '..', 'src', 'components', 'AICopilot.jsx'),
    'utf8'
  );
  const controller = fs.readFileSync(
    path.join(here, '..', 'src', 'lib', 'copilotProposal.js'),
    'utf8'
  );

  assert.match(component, /resolveDiscard\(\{ http: api, state: current, token \}\)/);
  assert.match(controller, /\/api\/copilot\/proposals\/\$\{encodeURIComponent\(state\.proposalId\)\}\/revoke/);
  const discardSection = controller.slice(
    controller.indexOf('export async function discardProposal'),
    controller.indexOf('export function createConfirmLock')
  );
  assert.doesNotMatch(discardSection, /\/api\/copilot\/execute/);
});
