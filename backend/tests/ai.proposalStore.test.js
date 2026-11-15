const { createProposalStore, PROPOSAL_ID_PATTERN } = require('../services/ai/proposalStore');

const INTENT = {
  side: 'BUY',
  symbol: 'BTCUSDT',
  orderType: 'MARKET',
  quantity: 0.1,
  limitPrice: null,
  referencePrice: 50000
};
const PREVIEW = {
  side: 'BUY',
  symbol: 'BTCUSDT',
  orderType: 'MARKET',
  quantity: 0.1,
  quotePrice: 50000,
  estimatedValue: 5000,
  warnings: []
};

function makeStore(clock, ttlMs = 120000) {
  return createProposalStore({ ttlMs, now: () => clock.now });
}

describe('AI proposal store', () => {
  test('creates cryptographically random proposal ids with ownership and expiry', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);

    const proposal = store.create({
      userId: 'user-a',
      intent: INTENT,
      preview: PREVIEW,
      quote: { price: 50000, ts: clock.now }
    });

    expect(proposal.id).toMatch(PROPOSAL_ID_PATTERN);
    expect(proposal.id).toHaveLength(48);
    expect(proposal.expiresAt).toBe(clock.now + 120000);

    const other = store.create({ userId: 'user-a', intent: INTENT, preview: PREVIEW });
    expect(other.id).not.toBe(proposal.id);
  });

  test('a proposal can only be consumed by its owning user', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);
    const proposal = store.create({ userId: 'user-a', intent: INTENT, preview: PREVIEW });

    const foreign = store.consume({ proposalId: proposal.id, userId: 'user-b' });
    expect(foreign.ok).toBe(false);
    expect(foreign.code).toBe('INVALID_PROPOSAL');

    const owner = store.consume({ proposalId: proposal.id, userId: 'user-a' });
    expect(owner.ok).toBe(true);
    expect(owner.proposal.intent).toEqual(INTENT);
  });

  test('a proposal is single-use', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);
    const proposal = store.create({ userId: 'user-a', intent: INTENT, preview: PREVIEW });

    expect(store.consume({ proposalId: proposal.id, userId: 'user-a' }).ok).toBe(true);

    const replay = store.consume({ proposalId: proposal.id, userId: 'user-a' });
    expect(replay.ok).toBe(false);
    expect(replay.code).toBe('PROPOSAL_ALREADY_USED');
  });

  test('rejects expired proposals', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);
    const proposal = store.create({ userId: 'user-a', intent: INTENT, preview: PREVIEW });

    clock.now += 120000;

    const expired = store.consume({ proposalId: proposal.id, userId: 'user-a' });
    expect(expired.ok).toBe(false);
    expect(expired.code).toBe('PROPOSAL_EXPIRED');
    expect(store.size()).toBe(0);
  });

  test('rejects malformed and unknown proposal ids', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);

    expect(store.consume({ proposalId: 'not-a-real-id', userId: 'user-a' }).code)
      .toBe('INVALID_PROPOSAL');
    expect(store.consume({ proposalId: { id: 'x' }, userId: 'user-a' }).code)
      .toBe('INVALID_PROPOSAL');

    const unknown = 'a'.repeat(48);
    expect(store.consume({ proposalId: unknown, userId: 'user-a' }).code)
      .toBe('PROPOSAL_NOT_FOUND');
  });

  test('stores a server-side copy that callers cannot tamper with', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);
    const intent = { ...INTENT };
    const proposal = store.create({ userId: 'user-a', intent, preview: PREVIEW });

    intent.quantity = 999;
    proposal.intent.quantity = 999;

    const consumed = store.consume({ proposalId: proposal.id, userId: 'user-a' });
    expect(consumed.proposal.intent.quantity).toBe(0.1);
  });

  test('expired records are swept when new proposals are created', () => {
    const clock = { now: 1_700_000_000_000 };
    const store = makeStore(clock);

    store.create({ userId: 'user-a', intent: INTENT, preview: PREVIEW });
    store.create({ userId: 'user-b', intent: INTENT, preview: PREVIEW });
    expect(store.size()).toBe(2);

    clock.now += 120001;
    store.create({ userId: 'user-c', intent: INTENT, preview: PREVIEW });

    expect(store.size()).toBe(1);
  });
});
