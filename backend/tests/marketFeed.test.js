const {
  createMarketFeed,
  DEFAULT_MAX_AGE_MS
} = require('../services/marketFeed');
const { shouldExecuteLimitOrder } = require('../services/limitMatcher');

function makeClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => { current += ms; }
  };
}

function makeFeed() {
  const clock = makeClock();
  const feed = createMarketFeed({ now: clock.now });
  return { feed, clock };
}

describe('marketFeed quote storage', () => {
  test('accepts a valid positive price and returns it as fresh', () => {
    const { feed } = makeFeed();

    expect(feed.setQuote('BTCUSDT', 60000)).toBe(true);

    const quote = feed.getQuote('BTCUSDT');
    expect(quote.status).toBe('ok');
    expect(quote.price).toBe(60000);
    expect(Number.isFinite(quote.ts)).toBe(true);
    expect(quote.ageMs).toBe(0);
  });

  test('normalizes symbols before lookup', () => {
    const { feed } = makeFeed();

    expect(feed.setQuote('  btcusdt ', 60000)).toBe(true);

    expect(feed.getQuote('BTCUSDT').status).toBe('ok');
    expect(feed.getQuote('btcusdt').price).toBe(60000);
  });

  test('rejects zero and negative prices', () => {
    const { feed } = makeFeed();

    expect(feed.setQuote('BTCUSDT', 0)).toBe(false);
    expect(feed.setQuote('BTCUSDT', -1)).toBe(false);
    expect(feed.getQuote('BTCUSDT').status).toBe('missing');
  });

  test('rejects NaN and Infinity', () => {
    const { feed } = makeFeed();

    expect(feed.setQuote('BTCUSDT', NaN)).toBe(false);
    expect(feed.setQuote('BTCUSDT', Infinity)).toBe(false);
    expect(feed.setQuote('BTCUSDT', -Infinity)).toBe(false);
    expect(feed.getQuote('BTCUSDT').status).toBe('missing');
  });

  test('rejects non-numeric prices such as strings', () => {
    const { feed } = makeFeed();

    expect(feed.setQuote('BTCUSDT', '60000')).toBe(false);
    expect(feed.setQuote('BTCUSDT', null)).toBe(false);
    expect(feed.getQuote('BTCUSDT').status).toBe('missing');
  });

  test('rejects unsupported and invalid symbols', () => {
    const { feed } = makeFeed();

    expect(feed.setQuote('DOGEUSDT', 1)).toBe(false);
    expect(feed.setQuote('', 1)).toBe(false);
    expect(feed.setQuote(null, 1)).toBe(false);

    expect(feed.getQuote('DOGEUSDT')).toEqual({ status: 'missing', symbol: 'DOGEUSDT' });
    expect(feed.getQuote(null)).toEqual({ status: 'missing', symbol: null });
  });

  test('reports missing for a supported symbol with no quote yet', () => {
    const { feed } = makeFeed();

    expect(feed.getQuote('ETHUSDT')).toEqual({ status: 'missing', symbol: 'ETHUSDT' });
  });

  test('uses a 15000 ms default maximum age', () => {
    expect(DEFAULT_MAX_AGE_MS).toBe(15000);

    const { feed, clock } = makeFeed();
    feed.setQuote('BTCUSDT', 60000);

    clock.advance(DEFAULT_MAX_AGE_MS - 1);
    expect(feed.getQuote('BTCUSDT').status).toBe('ok');

    clock.advance(1);
    expect(feed.getQuote('BTCUSDT').status).toBe('ok');

    clock.advance(1);
    const stale = feed.getQuote('BTCUSDT');
    expect(stale.status).toBe('stale');
    expect(stale.price).toBeUndefined();
  });

  test('respects an explicit maxAgeMs argument', () => {
    const { feed, clock } = makeFeed();
    feed.setQuote('BTCUSDT', 60000);

    clock.advance(500);
    expect(feed.getQuote('BTCUSDT', 500).status).toBe('ok');
    expect(feed.getQuote('BTCUSDT', 499).status).toBe('stale');
  });

  test('advances with the injected clock and never returns an old quote as valid', () => {
    const { feed, clock } = makeFeed();
    feed.setQuote('BTCUSDT', 60000);

    clock.advance(1000);
    const early = feed.getQuote('BTCUSDT');
    expect(early.status).toBe('ok');
    expect(early.ageMs).toBe(1000);

    clock.advance(14000);
    const late = feed.getQuote('BTCUSDT');
    expect(late.status).toBe('ok');
    expect(late.ageMs).toBe(15000);

    clock.advance(1);
    const expired = feed.getQuote('BTCUSDT');
    expect(expired.status).toBe('stale');
    expect(expired.ageMs).toBe(15001);
    expect(expired.price).toBeUndefined();
  });

  test('a new quote resets freshness', () => {
    const { feed, clock } = makeFeed();
    feed.setQuote('BTCUSDT', 60000);

    clock.advance(20000);
    expect(feed.getQuote('BTCUSDT').status).toBe('stale');

    feed.setQuote('BTCUSDT', 61000);
    const refreshed = feed.getQuote('BTCUSDT');
    expect(refreshed.status).toBe('ok');
    expect(refreshed.price).toBe(61000);
    expect(refreshed.ageMs).toBe(0);
  });

  test('a quote dated after the current clock is treated as stale', () => {
    let current = 1_700_000_000_000;
    const feed = createMarketFeed({ now: () => current });
    feed.setQuote('BTCUSDT', 60000);

    // Clock skew must never turn a future timestamp into a negative age that
    // passes the freshness window.
    current -= 1000;

    const quote = feed.getQuote('BTCUSDT');
    expect(quote.status).toBe('stale');
    expect(quote.price).toBeUndefined();
  });
});

describe('limit matcher freshness gating', () => {
  test('skips missing quotes', () => {
    const { feed } = makeFeed();
    const buyOrder = { symbol: 'BTCUSDT', type: 'BUY', limitPrice: 70000 };

    const quote = feed.getQuote('BTCUSDT');
    expect(quote.status).toBe('missing');
    expect(shouldExecuteLimitOrder(buyOrder, quote)).toBe(false);
  });

  test('skips stale quotes for both BUY and SELL', () => {
    const clock = makeClock();
    const feed = createMarketFeed({ now: clock.now });
    feed.setQuote('BTCUSDT', 60000);
    clock.advance(DEFAULT_MAX_AGE_MS + 1);

    const quote = feed.getQuote('BTCUSDT');
    expect(quote.status).toBe('stale');

    const buyOrder = { symbol: 'BTCUSDT', type: 'BUY', limitPrice: 70000 };
    const sellOrder = { symbol: 'BTCUSDT', type: 'SELL', limitPrice: 50000 };

    expect(shouldExecuteLimitOrder(buyOrder, quote)).toBe(false);
    expect(shouldExecuteLimitOrder(sellOrder, quote)).toBe(false);
  });

  test('still matches fresh quotes for BUY and SELL', () => {
    const { feed } = makeFeed();
    feed.setQuote('BTCUSDT', 60000);

    const quote = feed.getQuote('BTCUSDT');
    expect(quote.status).toBe('ok');

    const fillableBuy = { symbol: 'BTCUSDT', type: 'BUY', limitPrice: 65000 };
    const unfillableBuy = { symbol: 'BTCUSDT', type: 'BUY', limitPrice: 55000 };
    const fillableSell = { symbol: 'BTCUSDT', type: 'SELL', limitPrice: 55000 };
    const unfillableSell = { symbol: 'BTCUSDT', type: 'SELL', limitPrice: 65000 };

    expect(shouldExecuteLimitOrder(fillableBuy, quote)).toBe(true);
    expect(shouldExecuteLimitOrder(unfillableBuy, quote)).toBe(false);
    expect(shouldExecuteLimitOrder(fillableSell, quote)).toBe(true);
    expect(shouldExecuteLimitOrder(unfillableSell, quote)).toBe(false);
  });
});
