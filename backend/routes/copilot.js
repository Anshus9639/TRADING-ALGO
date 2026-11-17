const express = require('express');
const { rateLimit: expressRateLimit } = require('express-rate-limit');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { rateLimitOptions } = require('../middleware/rateLimit');
const { getGeminiApiKey, getCopilotConfig } = require('../config/env');
const { createTradeService } = require('../services/tradeService');
const { createProposalStore } = require('../services/ai/proposalStore');
const { createGeminiIntentExtractor } = require('../services/ai/gemini');
const {
  validateModelIntent,
  resolveIntent,
  revalidateStoredIntent
} = require('../services/ai/intent');
const { SUPPORTED_SYMBOLS } = require('../lib/validate');
const { roundTo } = require('../lib/numbers');

const MAX_PROMPT_LENGTH = 500;

const CODE_MESSAGES = Object.freeze({
  INVALID_PROPOSAL: 'Proposal is invalid.',
  PROPOSAL_NOT_FOUND: 'Proposal not found.',
  PROPOSAL_EXPIRED: 'Proposal has expired. Request a fresh proposal.',
  PROPOSAL_ALREADY_USED: 'Proposal was already used. Request a fresh proposal.',
  PROPOSAL_REVOKED: 'Proposal was discarded. Request a fresh proposal.',
  PRICE_CHANGED: 'Price moved beyond the allowed tolerance. Request a fresh proposal.',
  INSUFFICIENT_BALANCE: 'Insufficient USDT balance.',
  INSUFFICIENT_ASSET: 'Insufficient asset balance.'
});

const PROPOSAL_ERROR_STATUS = Object.freeze({
  INVALID_PROPOSAL: 400,
  PROPOSAL_NOT_FOUND: 404,
  PROPOSAL_EXPIRED: 410,
  PROPOSAL_ALREADY_USED: 409,
  PROPOSAL_REVOKED: 409
});

function readPrompt(prompt, maxLength) {
  if (typeof prompt !== 'string') {
    return { ok: false, message: 'Prompt must be a string.' };
  }
  const trimmed = prompt.trim();
  if (!trimmed) return { ok: false, message: 'Prompt is required.' };
  if (trimmed.length > maxLength) {
    return { ok: false, message: `Prompt must be at most ${maxLength} characters.` };
  }
  return { ok: true, value: trimmed };
}

function inferTradeErrorCode(message = '') {
  if (/insufficient crypto|do not own|insufficient .* for limit sell/i.test(message)) {
    return 'INSUFFICIENT_ASSET';
  }
  if (/insufficient usdt|insufficient.*balance/i.test(message)) return 'INSUFFICIENT_BALANCE';
  return 'TRADE_REJECTED';
}

function sendTradeResult(res, result) {
  if (result.body.success) {
    return res.status(result.status).json(result.body);
  }

  // Preserve an explicit service code (e.g. MATCHER_NOT_READY) instead of
  // collapsing every 503 into PRICE_UNAVAILABLE.
  const code = result.body.code
    || (result.status === 503
      ? 'PRICE_UNAVAILABLE'
      : result.status === 400
        ? inferTradeErrorCode(result.body.message)
        : 'TRADE_REJECTED');

  return res.status(result.status).json({
    success: false,
    code,
    message: result.body.message
  });
}

function createCopilotRouter({
  feed,
  runtimeStatus = null,
  ai = null,
  proposalStore = null,
  now = Date.now,
  User: UserModel = User,
  rateLimit = null,
  usdInrRate,
  maxPriceDriftPct,
  geminiModel,
  geminiTimeoutMs,
  maxPromptLength = MAX_PROMPT_LENGTH
} = {}) {
  if (!feed || typeof feed.getQuote !== 'function') {
    throw new TypeError('createCopilotRouter requires a market feed instance.');
  }

  const runtime = getCopilotConfig();
  const driftThreshold = Number.isFinite(maxPriceDriftPct)
    ? maxPriceDriftPct
    : runtime.maxPriceDriftPct;
  const configuredInrRate = usdInrRate === undefined
    ? runtime.usdInrRate
    : (Number.isFinite(usdInrRate) && usdInrRate > 0 ? usdInrRate : null);
  const store = proposalStore || createProposalStore({ now, ttlMs: runtime.proposalTtlMs });
  // Share the router clock so settlement-time quote-age checks use the same
  // timeline as the proposal store and market feed.
  const tradeService = createTradeService({ feed, User: UserModel, runtimeStatus, now });

  const limits = rateLimit || runtime.rateLimit;
  const copilotLimiter = limits.max > 0 && limits.windowMs > 0
    ? expressRateLimit(rateLimitOptions({
      ...limits,
      message: 'Too many copilot requests. Please wait and retry.'
    }))
    : (_req, _res, next) => next();

  let cachedExtractor = ai || null;

  function getExtractor() {
    if (cachedExtractor) return cachedExtractor;
    const apiKey = getGeminiApiKey();
    if (!apiKey) return null;
    cachedExtractor = createGeminiIntentExtractor({
      apiKey,
      model: geminiModel || runtime.geminiModel,
      timeoutMs: geminiTimeoutMs || runtime.geminiTimeoutMs
    });
    return cachedExtractor;
  }

  const router = express.Router();

  // Stage 1: extract and validate intent, build a server-side proposal, and
  // return a preview. This route never mutates the account. The limiter runs
  // before authentication so it also bounds JWT verification work.
  router.post('/parse', copilotLimiter, auth, async (req, res) => {
    try {
      const promptCheck = readPrompt(req.body?.prompt, maxPromptLength);
      if (!promptCheck.ok) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PROMPT',
          message: promptCheck.message
        });
      }

      const extractor = getExtractor();
      if (!extractor) {
        return res.status(503).json({
          success: false,
          code: 'AI_UNAVAILABLE',
          message: 'AI copilot is not configured.'
        });
      }

      const user = await UserModel.findById(req.user.id);
      if (!user) {
        return res.status(404).json({
          success: false,
          code: 'INVALID_USER',
          message: 'User not found.'
        });
      }

      const holdings = Object.fromEntries(
        (user.portfolio || []).map(position => [
          position.symbol,
          Math.max(0, roundTo(position.quantity - (position.lockedQuantity || 0)))
        ])
      );
      const quotes = {};
      for (const symbol of SUPPORTED_SYMBOLS) {
        const quote = feed.getQuote(symbol);
        if (quote.status === 'ok') quotes[symbol] = { price: quote.price, ts: quote.ts };
      }

      let rawIntent;
      try {
        rawIntent = await extractor.extract({
          prompt: promptCheck.value,
          context: { balance: user.balance, holdings, quotes }
        });
      } catch {
        return res.status(502).json({
          success: false,
          code: 'AI_UNAVAILABLE',
          message: 'AI copilot is temporarily unavailable.'
        });
      }

      const intentCheck = validateModelIntent(rawIntent);
      if (!intentCheck.ok) {
        if (intentCheck.code === 'CLARIFICATION_REQUIRED') {
          return res.status(422).json({
            success: false,
            code: 'CLARIFICATION_REQUIRED',
            clarification: intentCheck.clarification
          });
        }
        return res.status(400).json({
          success: false,
          code: 'INVALID_INTENT',
          message: intentCheck.message
        });
      }

      const resolved = resolveIntent({
        modelIntent: intentCheck.value,
        context: {
          balance: user.balance,
          holdings,
          quoteFor: symbol => feed.getQuote(symbol),
          usdInrRate: configuredInrRate,
          maxPriceDriftPct: driftThreshold
        }
      });

      if (!resolved.ok) {
        if (resolved.code === 'CLARIFICATION_REQUIRED') {
          return res.status(422).json({
            success: false,
            code: 'CLARIFICATION_REQUIRED',
            clarification: resolved.clarification
          });
        }
        if (resolved.code === 'PRICE_UNAVAILABLE') {
          return res.status(503).json({
            success: false,
            code: 'PRICE_UNAVAILABLE',
            message: resolved.message
          });
        }
        if (resolved.code === 'INSUFFICIENT_ASSET') {
          return res.status(400).json({
            success: false,
            code: 'INSUFFICIENT_ASSET',
            message: resolved.message
          });
        }
        return res.status(400).json({
          success: false,
          code: 'INVALID_INTENT',
          message: resolved.message
        });
      }

      const { intent, preview } = resolved.value;
      const quote = intent.orderType === 'MARKET' && Number.isFinite(preview.quotePrice)
        ? { price: preview.quotePrice, ts: preview.quoteTs }
        : null;

      const proposal = store.create({
        userId: req.user.id,
        intent,
        preview,
        quote
      });

      return res.json({
        success: true,
        proposalId: proposal.id,
        intent,
        preview,
        expiresAt: new Date(proposal.expiresAt).toISOString()
      });
    } catch (err) {
      console.error('Copilot parse error:', err.message);
      return res.status(500).json({
        success: false,
        code: 'COPILOT_ERROR',
        message: 'Copilot request failed.'
      });
    }
  });

  // Stage 2: consume the server-side proposal exactly once and execute its
  // stored intent through the same trade service used by manual orders.
  router.post('/execute', copilotLimiter, auth, async (req, res) => {
    try {
      const proposalId = typeof req.body?.proposalId === 'string'
        ? req.body.proposalId.trim()
        : '';

      if (!proposalId) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PROPOSAL',
          message: CODE_MESSAGES.INVALID_PROPOSAL
        });
      }

      // The proposal id is the execution idempotency key. If this proposal
      // already produced an order, a network retry returns that same result
      // instead of reporting the proposal as merely consumed.
      const priorResult = await tradeService.getExecutionResult({
        userId: req.user.id,
        clientOrderId: proposalId
      });
      if (priorResult) {
        return res.status(priorResult.status).json(priorResult.body);
      }

      const consumed = store.consume({ proposalId, userId: req.user.id });
      if (!consumed.ok) {
        if (consumed.code === 'PROPOSAL_ALREADY_USED') {
          const retried = await tradeService.getExecutionResult({
            userId: req.user.id,
            clientOrderId: proposalId
          });
          if (retried) return res.status(retried.status).json(retried.body);
        }
        return res.status(PROPOSAL_ERROR_STATUS[consumed.code] || 400).json({
          success: false,
          code: consumed.code,
          message: CODE_MESSAGES[consumed.code] || 'Proposal rejected.'
        });
      }

      const { intent, quote } = consumed.proposal;
      const revalidated = revalidateStoredIntent(intent);
      if (!revalidated.ok) {
        return res.status(400).json({
          success: false,
          code: 'INVALID_PROPOSAL',
          message: revalidated.message
        });
      }
      const storedIntent = revalidated.value;

      if (storedIntent.orderType === 'MARKET') {
        const freshQuote = feed.getQuote(storedIntent.symbol);
        if (freshQuote.status !== 'ok') {
          return res.status(503).json({
            success: false,
            code: 'PRICE_UNAVAILABLE',
            message: 'Market price unavailable. Please retry.'
          });
        }

        if (!quote || !Number.isFinite(quote.price) || quote.price <= 0) {
          return res.status(400).json({
            success: false,
            code: 'INVALID_PROPOSAL',
            message: CODE_MESSAGES.INVALID_PROPOSAL
          });
        }

        const driftPct = (Math.abs(freshQuote.price - quote.price) / quote.price) * 100;
        if (driftPct > driftThreshold) {
          return res.status(409).json({
            success: false,
            code: 'PRICE_CHANGED',
            message: CODE_MESSAGES.PRICE_CHANGED,
            previewPrice: quote.price,
            currentPrice: freshQuote.price,
            driftPct: roundTo(driftPct, 4)
          });
        }

        const result = await tradeService.executeMarketOrder({
          userId: req.user.id,
          side: storedIntent.side,
          symbol: storedIntent.symbol,
          quantity: storedIntent.quantity,
          clientOrderId: proposalId,
          // The quote that passed the drift check is the quote used for
          // settlement; no second, different quote is fetched.
          executionQuote: {
            symbol: storedIntent.symbol,
            price: freshQuote.price,
            ts: freshQuote.ts
          }
        });
        return sendTradeResult(res, result);
      }

      const result = await tradeService.placeLimitOrder({
        userId: req.user.id,
        side: storedIntent.side,
        symbol: storedIntent.symbol,
        quantity: storedIntent.quantity,
        limitPrice: storedIntent.limitPrice,
        clientOrderId: proposalId
      });
      return sendTradeResult(res, result);
    } catch (err) {
      console.error('Copilot execute error:', err.message);
      return res.status(500).json({
        success: false,
        code: 'COPILOT_ERROR',
        message: 'Copilot request failed.'
      });
    }
  });

  // Stage 1b: owner-only server-side discard. Revocation never trades or
  // reserves anything; a revoked proposal is never executable.
  router.post('/proposals/:proposalId/revoke', copilotLimiter, auth, async (req, res) => {
    try {
      const result = store.revoke({
        proposalId: req.params.proposalId,
        userId: req.user.id
      });

      if (!result.ok) {
        return res.status(PROPOSAL_ERROR_STATUS[result.code] || 400).json({
          success: false,
          code: result.code,
          message: CODE_MESSAGES[result.code] || 'Proposal rejected.'
        });
      }

      return res.json({
        success: true,
        revoked: true,
        alreadyRevoked: result.alreadyRevoked === true,
        expiresAt: new Date(result.expiresAt).toISOString()
      });
    } catch (err) {
      console.error('Copilot revoke error:', err.message);
      return res.status(500).json({
        success: false,
        code: 'COPILOT_ERROR',
        message: 'Copilot request failed.'
      });
    }
  });

  return router;
}

module.exports = {
  createCopilotRouter,
  inferTradeErrorCode,
  MAX_PROMPT_LENGTH
};
