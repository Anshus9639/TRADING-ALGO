const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../app');
const { createMarketFeed } = require('../services/marketFeed');
const { createProposalStore, PROPOSAL_ID_PATTERN } = require('../services/ai/proposalStore');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const {
  startTestDb,
  stopTestDb,
  createTestUser,
  authToken,
  snapshotUser
} = require('./helpers');

function modelIntent(overrides = {}) {
  return {
    side: 'BUY',
    symbol: 'BTCUSDT',
    orderType: 'MARKET',
    quantity: 0.1,
    limitPrice: null,
    notional: null,
    allAvailable: null,
    clarification: null,
    ...overrides
  };
}

function fakeAi(intents) {
  return {
    extract: async ({ prompt }) => {
      const intent = intents[prompt.trim().toLowerCase()];
      if (!intent) throw new Error('Unexpected prompt in test.');
      return intent;
    }
  };
}

describe('copilot proposal and confirmation flow', () => {
  let clock;
  let feed;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(() => {
    clock = 1_700_000_000_000;
    feed = createMarketFeed({ now: () => clock });
    feed.setQuote('BTCUSDT', 50000);
    feed.setQuote('ETHUSDT', 3000);
    feed.setQuote('SOLUSDT', 150);
    feed.setQuote('BNBUSDT', 600);
  });

  function makeApp({ intents = {}, feed: feedOverride, ...overrides } = {}) {
    const proposalStore = overrides.proposalStore
      || createProposalStore({ now: () => clock });

    const app = createApp({
      feed: feedOverride || feed,
      copilot: {
        ai: fakeAi(intents),
        proposalStore,
        now: () => clock,
        rateLimit: { max: 100, windowMs: 60000 },
        usdInrRate: 83,
        maxPriceDriftPct: 1.5,
        ...overrides
      }
    });

    return { app, proposalStore };
  }

  function parse(app, token, prompt) {
    return request(app)
      .post('/api/copilot/parse')
      .set('x-auth-token', token)
      .send({ prompt });
  }

  function execute(app, token, proposalId, extra = {}) {
    return request(app)
      .post('/api/copilot/execute')
      .set('x-auth-token', token)
      .send({ proposalId, ...extra });
  }

  function revoke(app, token, proposalId) {
    return request(app)
      .post(`/api/copilot/proposals/${encodeURIComponent(proposalId)}/revoke`)
      .set('x-auth-token', token)
      .send({});
  }

  test('parsing returns a preview and performs zero account mutations', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const before = await snapshotUser(user._id);

    const res = await parse(app, token, 'Buy 0.1 BTC');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.proposalId).toMatch(PROPOSAL_ID_PATTERN);
    expect(res.body.intent).toMatchObject({
      side: 'BUY',
      symbol: 'BTCUSDT',
      orderType: 'MARKET',
      quantity: 0.1
    });
    expect(res.body.preview).toMatchObject({
      side: 'BUY',
      symbol: 'BTCUSDT',
      orderType: 'MARKET',
      quantity: 0.1,
      quotePrice: 50000,
      estimatedValue: 5000,
      balance: 10000
    });
    expect(res.body.preview.warnings.join(' ')).toMatch(/fresh server quote/);
    expect(Number.isNaN(Date.parse(res.body.expiresAt))).toBe(false);
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('ambiguous instructions return a clarification instead of a proposal', async () => {
    const { app } = makeApp({
      intents: {
        'trade some crypto': modelIntent({
          side: null,
          symbol: null,
          orderType: null,
          quantity: null,
          clarification: 'Which asset and how much?'
        })
      }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const res = await parse(app, token, 'Trade some crypto');

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('CLARIFICATION_REQUIRED');
    expect(res.body.clarification).toBe('Which asset and how much?');
  });

  test('rejects invalid model output and prompt formats', async () => {
    const invalidIntents = {
      'hold btc': modelIntent({ side: 'HOLD' }),
      'buy doge': modelIntent({ symbol: 'DOGEUSDT' }),
      'buy for free': modelIntent({ quantity: 0 }),
      'buy with price': modelIntent({ price: 1 }),
      'buy with executed price': modelIntent({ executedPrice: 1 }),
      'buy string quantity': modelIntent({ quantity: '0.1' }),
      'buy market with limit': modelIntent({ limitPrice: 40000 }),
      'limit without price': modelIntent({ orderType: 'LIMIT', limitPrice: null })
    };

    for (const [prompt, intent] of Object.entries(invalidIntents)) {
      const { app } = makeApp({ intents: { [prompt]: intent } });
      const user = await createTestUser({ balance: 10000 });
      const token = authToken(user);
      const before = await snapshotUser(user._id);

      const res = await parse(app, token, prompt);

      expect([400, 422]).toContain(res.status);
      expect(['INVALID_INTENT', 'CLARIFICATION_REQUIRED']).toContain(res.body.code);
      expect(await snapshotUser(user._id)).toEqual(before);
    }
  });

  test('validates prompt size and format without calling the model', async () => {
    const { app } = makeApp({ intents: {} });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    for (const payload of [{ prompt: '' }, { prompt: '   ' }, { prompt: 42 }, { prompt: 'x'.repeat(501) }]) {
      const res = await request(app)
        .post('/api/copilot/parse')
        .set('x-auth-token', token)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_PROMPT');
    }
  });

  test('reports AI failures without leaking internals', async () => {
    const app = createApp({
      feed,
      copilot: {
        ai: { extract: async () => { throw new Error('raw upstream detail'); } },
        now: () => clock,
        rateLimit: { max: 100, windowMs: 60000 }
      }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const res = await parse(app, token, 'Buy 0.1 BTC');

    expect(res.status).toBe(502);
    expect(res.body.code).toBe('AI_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toMatch(/raw upstream detail/);
  });

  test('enforces a per-user copilot rate limit', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() },
      rateLimit: { max: 2, windowMs: 60000 }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    expect((await parse(app, token, 'Buy 0.1 BTC')).status).toBe(200);
    expect((await parse(app, token, 'Buy 0.1 BTC')).status).toBe(200);

    const limited = await parse(app, token, 'Buy 0.1 BTC');
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeTruthy();
  });

  test('market BUY executes through the trade service and ignores tampered body fields', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    const res = await execute(app, token, parsed.body.proposalId, {
      side: 'SELL',
      symbol: 'ETHUSDT',
      quantity: 5,
      price: 1,
      limitPrice: 1
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.executedPrice).toBe(50000);
    expect(res.body.balance).toBe(5000);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50000 }]);
    expect(after.trades).toEqual([
      { symbol: 'BTCUSDT', type: 'BUY', quantity: 0.1, price: 50000 }
    ]);
  });

  test('market SELL executes through the trade service', async () => {
    const { app } = makeApp({
      intents: { 'sell 0.1 btc': modelIntent({ side: 'SELL' }) }
    });
    const user = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]
    });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Sell 0.1 BTC');
    const res = await execute(app, token, parsed.body.proposalId);

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(50000);
    expect(res.body.balance).toBe(15000);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 45000 }]);
    expect(after.trades).toEqual([
      { symbol: 'BTCUSDT', type: 'SELL', quantity: 0.1, price: 50000 }
    ]);
  });

  test('limit BUY and SELL use the shared limit-order escrow execution', async () => {
    const { app } = makeApp({
      intents: {
        'limit buy btc': modelIntent({ orderType: 'LIMIT', limitPrice: 40000 }),
        'limit sell btc': modelIntent({ side: 'SELL', orderType: 'LIMIT', limitPrice: 60000 })
      }
    });
    const buyer = await createTestUser({ balance: 10000 });
    const buyerToken = authToken(buyer);

    const buyParse = await parse(app, buyerToken, 'Limit buy BTC');
    expect(buyParse.status).toBe(200);
    expect(buyParse.body.preview.limitPrice).toBe(40000);
    expect(buyParse.body.preview.estimatedValue).toBe(4000);

    const buyExec = await execute(app, buyerToken, buyParse.body.proposalId);
    expect(buyExec.status).toBe(200);
    expect(buyExec.body.balance).toBe(6000);
    expect(buyExec.body.pendingOrders).toHaveLength(1);
    expect(buyExec.body.pendingOrders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.1,
      limitPrice: 40000
    });

    const seller = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]
    });
    const sellerToken = authToken(seller);

    const sellParse = await parse(app, sellerToken, 'Limit sell BTC');
    const sellExec = await execute(app, sellerToken, sellParse.body.proposalId);

    expect(sellExec.status).toBe(200);
    expect(sellExec.body.pendingOrders[0]).toMatchObject({
      symbol: 'BTCUSDT',
      type: 'SELL',
      quantity: 0.1,
      limitPrice: 60000
    });
    const sellerAfter = await snapshotUser(seller._id);
    // SELL limits lock available units but never reduce total holdings until
    // the fill actually settles.
    expect(sellerAfter.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.2, avgPrice: 45000 }]);
    expect(sellerAfter.lockedQuantities).toEqual({ BTCUSDT: 0.1 });
  });

  test('the copilot route delegates execution instead of mutating accounts itself', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'copilot.js'), 'utf8');

    expect(source).toMatch(/tradeService\.executeMarketOrder/);
    expect(source).toMatch(/tradeService\.placeLimitOrder/);
    expect(source).not.toMatch(/user\.balance\s*[-+]=/);
    expect(source).not.toMatch(/pendingOrders\.push/);
  });

  test('another user cannot execute a proposal, and the owner still can', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const owner = await createTestUser({ balance: 10000 });
    const attacker = await createTestUser({ balance: 10000 });
    const ownerToken = authToken(owner);
    const attackerToken = authToken(attacker);

    const parsed = await parse(app, ownerToken, 'Buy 0.1 BTC');
    const attackerBefore = await snapshotUser(attacker._id);

    const stolen = await execute(app, attackerToken, parsed.body.proposalId);
    expect(stolen.status).toBe(400);
    expect(stolen.body.code).toBe('INVALID_PROPOSAL');
    expect(await snapshotUser(attacker._id)).toEqual(attackerBefore);

    const ownerExec = await execute(app, ownerToken, parsed.body.proposalId);
    expect(ownerExec.status).toBe(200);
  });

  test('expired proposals are rejected without executing', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    clock += 120001;

    const before = await snapshotUser(user._id);
    const res = await execute(app, token, parsed.body.proposalId);

    expect(res.status).toBe(410);
    expect(res.body.code).toBe('PROPOSAL_EXPIRED');
    expect(await snapshotUser(user._id)).toEqual(before);
  });

  test('replayed proposals return the original execution result without trading twice', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    const first = await execute(app, token, parsed.body.proposalId);
    expect(first.status).toBe(200);

    // A client retry after a successful execution (for example, a lost HTTP
    // response) replays the stored result instead of trading again.
    const replay = await execute(app, token, parsed.body.proposalId);
    expect(replay.status).toBe(200);
    expect(replay.body.success).toBe(true);
    expect(replay.body.idempotent).toBe(true);
    expect(replay.body.executedPrice).toBe(first.body.executedPrice);
    expect(replay.body.balance).toBe(5000);

    const after = await snapshotUser(user._id);
    expect(after.trades).toHaveLength(1);
    expect(after.balance).toBe(5000);
  });

  test('material price drift returns PRICE_CHANGED without executing', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    const before = await snapshotUser(user._id);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    clock += 1000;
    feed.setQuote('BTCUSDT', 60000);

    const res = await execute(app, token, parsed.body.proposalId);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRICE_CHANGED');
    expect(res.body.previewPrice).toBe(50000);
    expect(res.body.currentPrice).toBe(60000);
    expect(res.body.driftPct).toBe(20);
    expect(await snapshotUser(user._id)).toEqual(before);

    const replay = await execute(app, token, parsed.body.proposalId);
    expect(replay.body.code).toBe('PROPOSAL_ALREADY_USED');
  });

  test('price movement within tolerance executes at the fresh server quote', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    clock += 1000;
    feed.setQuote('BTCUSDT', 50500);

    const res = await execute(app, token, parsed.body.proposalId);

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(50500);
    expect(res.body.balance).toBe(4950);
  });

  test('missing or stale quotes at execution are rejected without mutation', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    feed.reset();
    const before = await snapshotUser(user._id);
    const missing = await execute(app, token, parsed.body.proposalId);
    expect(missing.status).toBe(503);
    expect(missing.body.code).toBe('PRICE_UNAVAILABLE');
    expect(await snapshotUser(user._id)).toEqual(before);

    feed.setQuote('BTCUSDT', 50000);
    const fresh = await parse(app, token, 'Buy 0.1 BTC');
    expect(fresh.status).toBe(200);
    clock += 15001;
    const staleBefore = await snapshotUser(user._id);
    const stale = await execute(app, token, fresh.body.proposalId);
    expect(stale.status).toBe(503);
    expect(stale.body.code).toBe('PRICE_UNAVAILABLE');
    expect(await snapshotUser(user._id)).toEqual(staleBefore);
  });

  test('insufficient balance and holdings are surfaced, then rejected at execution', async () => {
    const { app } = makeApp({
      intents: {
        'buy 0.1 btc': modelIntent(),
        'sell 0.1 btc': modelIntent({ side: 'SELL' })
      }
    });

    const poorBuyer = await createTestUser({ balance: 100 });
    const buyerToken = authToken(poorBuyer);
    const buyParsed = await parse(app, buyerToken, 'Buy 0.1 BTC');
    expect(buyParsed.status).toBe(200);
    expect(buyParsed.body.preview.warnings.join(' ')).toMatch(/Insufficient USDT balance/);

    const buyBefore = await snapshotUser(poorBuyer._id);
    const buyExec = await execute(app, buyerToken, buyParsed.body.proposalId);
    expect(buyExec.status).toBe(400);
    expect(buyExec.body.code).toBe('INSUFFICIENT_BALANCE');
    expect(await snapshotUser(poorBuyer._id)).toEqual(buyBefore);

    const smallSeller = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 0.05, avgPrice: 50000 }]
    });
    const sellerToken = authToken(smallSeller);
    const sellParsed = await parse(app, sellerToken, 'Sell 0.1 BTC');
    expect(sellParsed.status).toBe(200);
    expect(sellParsed.body.preview.warnings.join(' ')).toMatch(/Insufficient BTCUSDT/);

    const sellBefore = await snapshotUser(smallSeller._id);
    const sellExec = await execute(app, sellerToken, sellParsed.body.proposalId);
    expect(sellExec.status).toBe(400);
    expect(sellExec.body.code).toBe('INSUFFICIENT_ASSET');
    expect(await snapshotUser(smallSeller._id)).toEqual(sellBefore);
  });

  test('notional USD amounts are sized server-side from the live quote', async () => {
    const { app } = makeApp({
      intents: {
        'buy $100 worth of btc': modelIntent({
          quantity: null,
          notional: { amount: 100, currency: 'USD' }
        })
      }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy $100 worth of BTC');
    expect(parsed.status).toBe(200);
    expect(parsed.body.preview.quantity).toBe(0.002);
    expect(parsed.body.preview.estimatedValue).toBe(100);

    const res = await execute(app, token, parsed.body.proposalId);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(9900);

    const after = await snapshotUser(user._id);
    expect(after.portfolio).toEqual([{ symbol: 'BTCUSDT', quantity: 0.002, avgPrice: 50000 }]);
  });

  test('INR notional requires an explicit configured rate', async () => {
    const intent = modelIntent({
      quantity: null,
      notional: { amount: 8300, currency: 'INR' }
    });

    const withoutRate = makeApp({
      intents: { 'buy inr 8300 of btc': intent },
      usdInrRate: null
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const clarified = await parse(withoutRate.app, token, 'Buy INR 8300 of BTC');
    expect(clarified.status).toBe(422);
    expect(clarified.body.code).toBe('CLARIFICATION_REQUIRED');
    expect(clarified.body.clarification).toMatch(/USD\/INR/);

    const withRate = makeApp({
      intents: { 'buy inr 8300 of btc': intent },
      usdInrRate: 83
    });
    const parsed = await parse(withRate.app, token, 'Buy INR 8300 of BTC');
    expect(parsed.status).toBe(200);
    expect(parsed.body.preview.quantity).toBe(0.002);
    expect(parsed.body.preview.warnings.join(' ')).toMatch(/INR/);
  });

  test('SELL ALL resolves holdings and rejects empty holdings', async () => {
    const { app } = makeApp({
      intents: {
        'sell all sol': modelIntent({
          side: 'SELL',
          symbol: 'SOLUSDT',
          quantity: null,
          allAvailable: true
        })
      }
    });

    const holder = await createTestUser({
      balance: 10000,
      portfolio: [{ symbol: 'SOLUSDT', quantity: 2, avgPrice: 100 }]
    });
    const holderToken = authToken(holder);

    const parsed = await parse(app, holderToken, 'Sell all SOL');
    expect(parsed.status).toBe(200);
    expect(parsed.body.preview.quantity).toBe(2);

    const res = await execute(app, holderToken, parsed.body.proposalId);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(10300);
    expect((await snapshotUser(holder._id)).portfolio).toEqual([]);

    const empty = await createTestUser({ balance: 10000 });
    const emptyToken = authToken(empty);
    const emptyParse = await parse(app, emptyToken, 'Sell all SOL');
    expect(emptyParse.status).toBe(400);
    expect(emptyParse.body.code).toBe('INSUFFICIENT_ASSET');
  });

  test('proposals cannot be built when the market quote is unavailable', async () => {
    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() }
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);
    feed.reset();

    const res = await parse(app, token, 'Buy 0.1 BTC');

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('PRICE_UNAVAILABLE');
  });

  test('revocation is owner-only and blocks execution without touching the account', async () => {
    const { app } = makeApp({ intents: { 'buy 0.1 btc': modelIntent() } });
    const owner = await createTestUser({ balance: 10000 });
    const ownerToken = authToken(owner);
    const stranger = await createTestUser({ balance: 10000 });
    const strangerToken = authToken(stranger);

    const parsed = await parse(app, ownerToken, 'Buy 0.1 BTC');
    expect(parsed.status).toBe(200);

    const foreign = await revoke(app, strangerToken, parsed.body.proposalId);
    expect(foreign.status).toBe(400);
    expect(foreign.body.code).toBe('INVALID_PROPOSAL');

    const before = await snapshotUser(owner._id);

    const revoked = await revoke(app, ownerToken, parsed.body.proposalId);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ success: true, revoked: true, alreadyRevoked: false });

    const again = await revoke(app, ownerToken, parsed.body.proposalId);
    expect(again.status).toBe(200);
    expect(again.body.alreadyRevoked).toBe(true);

    const executed = await execute(app, ownerToken, parsed.body.proposalId);
    expect(executed.status).toBe(409);
    expect(executed.body.code).toBe('PROPOSAL_REVOKED');
    expect(await snapshotUser(owner._id)).toEqual(before);
  });

  test('a proposal cannot be revoked after it has executed', async () => {
    const { app } = makeApp({ intents: { 'buy 0.1 btc': modelIntent() } });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    expect(parsed.status).toBe(200);

    const executed = await execute(app, token, parsed.body.proposalId);
    expect(executed.status).toBe(200);

    const late = await revoke(app, token, parsed.body.proposalId);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('PROPOSAL_ALREADY_USED');
  });

  test('execution settles at the drift-checked quote and never refetches a price', async () => {
    let sequence = null;
    const shiftingFeed = {
      getQuote(symbol) {
        if (sequence && sequence.length > 0 && symbol === 'BTCUSDT') {
          return { status: 'ok', price: sequence.shift(), ts: clock };
        }
        return feed.getQuote(symbol);
      }
    };

    const { app } = makeApp({
      intents: { 'buy 0.1 btc': modelIntent() },
      feed: shiftingFeed
    });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    expect(parsed.status).toBe(200);
    expect(parsed.body.preview.quotePrice).toBe(50000);

    // First execution-time quote passes the 1.5% drift check; the second is
    // wildly different and must never be used for settlement.
    sequence = [50500, 90000];
    const res = await execute(app, token, parsed.body.proposalId);

    expect(res.status).toBe(200);
    expect(res.body.executedPrice).toBe(50500);
    expect(res.body.balance).toBe(4950);
    expect((await snapshotUser(user._id)).portfolio).toEqual([
      { symbol: 'BTCUSDT', quantity: 0.1, avgPrice: 50500 }
    ]);
  });

  test('AI execution stays recoverable after a backend restart', async () => {
    const { app } = makeApp({ intents: { 'buy 0.1 btc': modelIntent() } });
    const user = await createTestUser({ balance: 10000 });
    const token = authToken(user);

    const parsed = await parse(app, token, 'Buy 0.1 BTC');
    expect(parsed.status).toBe(200);

    const first = await execute(app, token, parsed.body.proposalId);
    expect(first.status).toBe(200);
    expect(first.body.newTrade._id).toBeDefined();

    const afterFirst = await snapshotUser(user._id);
    expect(afterFirst.balance).toBe(5000);
    expect(afterFirst.trades).toHaveLength(1);
    const orderCount = await Order.countDocuments({ userId: user._id });
    const tradeCount = await Trade.countDocuments({ userId: user._id });
    expect(orderCount).toBe(1);
    expect(tradeCount).toBe(1);

    // A restart loses the in-memory proposal store. The persisted order is now
    // the only source of truth, so the retry must resolve through it.
    const restarted = makeApp({
      proposalStore: createProposalStore({ now: () => clock })
    });
    expect(restarted.proposalStore.size()).toBe(0);

    const retry = await execute(restarted.app, token, parsed.body.proposalId);

    expect(retry.status).toBe(200);
    expect(retry.body.idempotent).toBe(true);
    expect(retry.body.executedPrice).toBe(first.body.executedPrice);
    expect(retry.body.balance).toBe(first.body.balance);
    expect(retry.body.newTrade._id).toEqual(first.body.newTrade._id);

    expect(await snapshotUser(user._id)).toEqual(afterFirst);
    expect(await Order.countDocuments({ userId: user._id })).toBe(orderCount);
    expect(await Trade.countDocuments({ userId: user._id })).toBe(tradeCount);
    expect(restarted.proposalStore.size()).toBe(0);
  });
});
