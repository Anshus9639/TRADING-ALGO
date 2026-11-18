const mongoose = require('mongoose');
const User = require('../models/User');
const Order = require('../models/Order');
const Trade = require('../models/Trade');
const { createMarketFeed } = require('../services/marketFeed');
const { createTradeService } = require('../services/tradeService');
const { createMatcher } = require('../services/matcher');
const { loadAccountView } = require('../services/accountView');
const {
  runMigration,
  verifyMigration,
  auditLegacyData
} = require('../scripts/legacyMigration');
const { strictBlockingIssues } = require('../scripts/verify-migration');
const { startTestDb, stopTestDb, createTestUser } = require('./helpers');

function models() {
  return { User, Order, Trade };
}

describe('unknown historical cost basis', () => {
  let feed;
  let service;
  let orderSeq = 0;

  beforeAll(async () => {
    await startTestDb();
  }, 120000);

  afterAll(async () => {
    await stopTestDb();
  });

  beforeEach(async () => {
    await Promise.all([User.deleteMany({}), Order.deleteMany({}), Trade.deleteMany({})]);
    feed = createMarketFeed();
    service = createTradeService({ feed });
  });

  function orderId() {
    orderSeq += 1;
    return `unknown-basis-${orderSeq}`;
  }

  test('migration marks a missing basis UNKNOWN/null and preserves a known basis', async () => {
    const unknownUser = await createTestUser({
      username: 'unknown-basis',
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 0 }]
    });
    const knownUser = await createTestUser({
      username: 'known-basis',
      portfolio: [{ symbol: 'ETHUSDT', quantity: 2, avgPrice: 1500 }]
    });

    const applied = await runMigration({ ...models(), mongoose, mode: 'apply' });
    expect(applied.usersFailed).toBe(0);
    expect(applied.usersUpdated).toBe(1);

    const unknownAfter = await User.findById(unknownUser._id).lean();
    expect(unknownAfter.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        quantity: 1,
        avgPrice: null,
        costBasisStatus: 'UNKNOWN'
      })
    ]);

    // A known basis is never rounded, replaced, or rewritten.
    const knownAfter = await User.findById(knownUser._id).lean();
    expect(knownAfter.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'ETHUSDT',
        quantity: 2,
        avgPrice: 1500,
        costBasisStatus: 'KNOWN'
      })
    ]);

    const verification = await verifyMigration(models());
    expect(verification.ok).toBe(true);
    expect(verification.costBasis.affectedUsers).toBe(1);
    expect(verification.costBasis.unknownPositions).toEqual([
      { userId: String(unknownUser._id), symbol: 'BTCUSDT', quantity: 1, status: 'UNKNOWN' }
    ]);

    const audit = await auditLegacyData(models());
    expect(audit.legacy.unknownCostBasis).toEqual([
      { userId: String(unknownUser._id), symbol: 'BTCUSDT', quantity: 1 }
    ]);
  });

  test('selling from an unknown basis records null realized PnL, never artificial profit', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 0, costBasisStatus: 'UNKNOWN' }]
    });
    feed.setQuote('BTCUSDT', 50000);

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 1,
      clientOrderId: orderId()
    });

    expect(result.status).toBe(200);
    expect(result.body.newTrade.realizedPnl).toBeNull();
    expect(result.body.balance).toBe(50000);

    const trade = await Trade.findOne({ userId: user._id }).lean();
    expect(trade.realizedPnl).toBeNull();
    // Treating the missing basis as zero would have produced 50000 of profit.
    expect(trade.realizedPnl).not.toBe(50000);
  });

  test('a known basis still produces exact realized PnL', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 40000 }]
    });
    feed.setQuote('BTCUSDT', 50000);

    const result = await service.executeMarketOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 0.5,
      clientOrderId: orderId()
    });

    expect(result.status).toBe(200);
    expect(result.body.newTrade.realizedPnl).toBe(5000);
  });

  test('buying into an unknown basis keeps it unknown instead of blending with zero', async () => {
    const user = await createTestUser({
      balance: 50000,
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 0, costBasisStatus: 'UNKNOWN' }]
    });
    feed.setQuote('BTCUSDT', 40000);

    const buy = await service.executeMarketOrder({
      userId: user._id,
      side: 'BUY',
      symbol: 'BTCUSDT',
      quantity: 1,
      clientOrderId: orderId()
    });
    expect(buy.status).toBe(200);

    const afterBuy = await User.findById(user._id).lean();
    expect(afterBuy.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        quantity: 2,
        avgPrice: null,
        costBasisStatus: 'UNKNOWN'
      })
    ]);

    feed.setQuote('BTCUSDT', 50000);
    const sell = await service.executeMarketOrder({
      userId: user._id,
      side: 'SELL',
      symbol: 'BTCUSDT',
      quantity: 2,
      clientOrderId: orderId()
    });
    expect(sell.body.newTrade.realizedPnl).toBeNull();
  });

  test('a limit SELL fill from an unknown basis records null realized PnL', async () => {
    const user = await createTestUser({
      balance: 0,
      portfolio: [{
        symbol: 'BTCUSDT',
        quantity: 1,
        lockedQuantity: 1,
        avgPrice: 0,
        costBasisStatus: 'UNKNOWN'
      }]
    });
    const order = await Order.create({
      userId: user._id,
      symbol: 'BTCUSDT',
      side: 'SELL',
      orderType: 'LIMIT',
      quantity: 1,
      remainingQuantity: 1,
      limitPrice: 60000,
      status: 'OPEN',
      clientOrderId: orderId()
    });
    feed.setQuote('BTCUSDT', 65000);

    const matcher = createMatcher({ feed, tradeService: service });
    const stats = await matcher.runCycle();
    expect(stats.filled).toBe(1);

    const trade = await Trade.findOne({ orderId: order._id }).lean();
    expect(trade.realizedPnl).toBeNull();
  });

  test('strict verification blocks ambiguity from a real verifyMigration report', async () => {
    const sharedId = new mongoose.Types.ObjectId();
    const user = await createTestUser({
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: 0 }]
    });
    const embedded = {
      _id: sharedId,
      symbol: 'BTCUSDT',
      type: 'BUY',
      quantity: 0.1,
      limitPrice: 5000,
      timestamp: new Date('2026-01-01T00:00:00.000Z')
    };
    await User.collection.updateOne(
      { _id: user._id },
      { $set: { pendingOrders: [embedded, { ...embedded }] } }
    );

    // The producer must expose the same issues the strict consumer inspects.
    const report = await verifyMigration(models());
    expect(report.ok).toBe(false);
    expect(report.ambiguity.issues.map(entry => entry.code)).toEqual(
      expect.arrayContaining(['MISSING_COST_BASIS', 'DUPLICATE_LEGACY_ID'])
    );

    const blocking = strictBlockingIssues(report);
    expect(blocking.map(entry => entry.code).sort()).toEqual([
      'DUPLICATE_LEGACY_ID',
      'MISSING_COST_BASIS'
    ]);
    expect(strictBlockingIssues(report, { acceptUnknownBasis: true })).toEqual([
      expect.objectContaining({ code: 'DUPLICATE_LEGACY_ID' })
    ]);
    expect(strictBlockingIssues({ ambiguity: { issues: [] } })).toEqual([]);
    expect(strictBlockingIssues(null)).toEqual([]);
  });

  test('account view exposes the unknown status instead of a zero basis', async () => {
    const user = await createTestUser({
      portfolio: [{ symbol: 'BTCUSDT', quantity: 1, avgPrice: null, costBasisStatus: 'UNKNOWN' }]
    });

    const view = await loadAccountView(user);
    expect(view.portfolio).toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        quantity: 1,
        avgPrice: null,
        costBasisStatus: 'UNKNOWN'
      })
    ]);
  });
});
