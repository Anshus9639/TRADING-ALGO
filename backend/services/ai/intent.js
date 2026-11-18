const {
  validateSymbol,
  validateSide,
  validateQuantity,
  validateLimitPrice,
  validateNotional
} = require('../../lib/validate');
const { roundTo, floorTo, MIN_QUANTITY, DECIMALS } = require('../../lib/numbers');

// The LLM is an untrusted extractor. This is the complete set of properties it
// may return; anything else (urls, endpoints, prices, user ids) is rejected.
const ALLOWED_MODEL_FIELDS = Object.freeze([
  'side',
  'symbol',
  'orderType',
  'quantity',
  'limitPrice',
  'notional',
  'allAvailable',
  'clarification'
]);
const ALLOWED_NOTIONAL_FIELDS = Object.freeze(['amount', 'currency']);
const ORDER_TYPES = Object.freeze(['MARKET', 'LIMIT']);
const NOTIONAL_CURRENCIES = Object.freeze(['USD', 'USDT', 'INR']);
const MAX_CLARIFICATION_LENGTH = 300;

function invalid(code, message) {
  return { ok: false, code, message };
}

function clarification(message) {
  return { ok: false, code: 'CLARIFICATION_REQUIRED', clarification: message };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unexpectedKeys(object, allowed) {
  return Object.keys(object).filter(key => !allowed.includes(key));
}

function validateNotionalInput(raw) {
  if (!isPlainObject(raw)) return invalid('INVALID_INTENT', 'Notional must be an object with amount and currency.');
  const extra = unexpectedKeys(raw, ALLOWED_NOTIONAL_FIELDS);
  if (extra.length > 0) {
    return invalid('INVALID_INTENT', `Notional contained unexpected properties: ${extra.join(', ')}.`);
  }

  const amount = raw.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
    return invalid('INVALID_INTENT', 'Notional amount must be a positive JSON number.');
  }

  const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : null;
  if (!currency || !NOTIONAL_CURRENCIES.includes(currency)) {
    return clarification('Specify the amount in USD, USDT, or INR.');
  }

  return { ok: true, value: { amount, currency } };
}

function validateModelIntent(raw) {
  if (!isPlainObject(raw)) {
    return invalid('INVALID_INTENT', 'AI response must be a JSON object.');
  }

  const extra = unexpectedKeys(raw, ALLOWED_MODEL_FIELDS);
  if (extra.length > 0) {
    return invalid('INVALID_INTENT', `AI response contained unexpected properties: ${extra.join(', ')}.`);
  }

  // Any clarification means the model did not produce an actionable trade.
  if (raw.clarification !== undefined && raw.clarification !== null) {
    if (typeof raw.clarification !== 'string' || raw.clarification.trim() === '') {
      return invalid('INVALID_INTENT', 'Clarification must be a non-empty string.');
    }
    return clarification(raw.clarification.trim().slice(0, MAX_CLARIFICATION_LENGTH));
  }

  if (typeof raw.side !== 'string') {
    return invalid('INVALID_INTENT', 'Side must be BUY or SELL.');
  }
  const side = raw.side.trim().toUpperCase();
  const sideCheck = validateSide(side);
  if (!sideCheck.ok) return invalid('INVALID_INTENT', sideCheck.error);

  const symbolCheck = validateSymbol(raw.symbol);
  if (!symbolCheck.ok) return invalid('INVALID_INTENT', symbolCheck.error);

  const orderType = typeof raw.orderType === 'string' ? raw.orderType.trim().toUpperCase() : null;
  if (!orderType || !ORDER_TYPES.includes(orderType)) {
    return invalid('INVALID_INTENT', 'Order type must be MARKET or LIMIT.');
  }

  let limitPrice = null;
  if (raw.limitPrice !== undefined && raw.limitPrice !== null) {
    if (orderType === 'MARKET') {
      return invalid('INVALID_INTENT', 'Market orders must not include a limit price.');
    }
    const priceCheck = validateLimitPrice(raw.limitPrice);
    if (!priceCheck.ok) return invalid('INVALID_INTENT', priceCheck.error);
    limitPrice = priceCheck.value;
  }
  if (orderType === 'LIMIT' && limitPrice === null) {
    return clarification('What limit price should the order use?');
  }

  let quantity = null;
  if (raw.quantity !== undefined && raw.quantity !== null) {
    const quantityCheck = validateQuantity(raw.quantity);
    if (!quantityCheck.ok) return invalid('INVALID_INTENT', quantityCheck.error);
    quantity = quantityCheck.value;
  }

  let notional = null;
  if (raw.notional !== undefined && raw.notional !== null) {
    const notionalCheck = validateNotionalInput(raw.notional);
    if (!notionalCheck.ok) return notionalCheck;
    notional = notionalCheck.value;
  }

  let allAvailable = false;
  if (raw.allAvailable !== undefined && raw.allAvailable !== null) {
    if (typeof raw.allAvailable !== 'boolean') {
      return invalid('INVALID_INTENT', 'allAvailable must be a boolean.');
    }
    allAvailable = raw.allAvailable;
  }

  if (allAvailable) {
    if (sideCheck.value !== 'SELL') {
      return invalid('INVALID_INTENT', 'allAvailable is only valid for SELL orders.');
    }
    if (quantity !== null || notional !== null) {
      return invalid('INVALID_INTENT', 'allAvailable cannot be combined with a quantity or notional amount.');
    }
  } else {
    const sizingMethods = [quantity !== null, notional !== null].filter(Boolean).length;
    if (sizingMethods === 0) {
      return clarification(
        sideCheck.value === 'SELL'
          ? 'How much should be sold? Provide a quantity, a notional amount, or "all available".'
          : 'How much should be bought? Provide a quantity or a notional amount.'
      );
    }
    if (sizingMethods > 1) {
      return invalid('INVALID_INTENT', 'Provide either a quantity or a notional amount, not both.');
    }
  }

  return {
    ok: true,
    value: {
      side: sideCheck.value,
      symbol: symbolCheck.value,
      orderType,
      quantity,
      notional,
      allAvailable,
      limitPrice
    }
  };
}

function resolveIntent({ modelIntent, context } = {}) {
  if (!modelIntent || !context) {
    return invalid('INVALID_INTENT', 'Intent and market context are required.');
  }
  const { symbol, side, orderType } = modelIntent;

  let referencePrice = null;
  let quoteTs = null;
  let priceForSizing = null;

  if (orderType === 'MARKET') {
    const quote = context.quoteFor(symbol);
    if (!quote || quote.status !== 'ok') {
      return invalid('PRICE_UNAVAILABLE', 'Market price unavailable. Please retry.');
    }
    referencePrice = quote.price;
    quoteTs = quote.ts;
    priceForSizing = quote.price;
  } else {
    priceForSizing = modelIntent.limitPrice;
  }

  const warnings = [];
  let quantity = modelIntent.quantity;

  if (modelIntent.allAvailable) {
    const available = Number(context.holdings?.[symbol]) || 0;
    if (available <= 0) {
      return invalid('INSUFFICIENT_ASSET', `No available ${symbol} to sell.`);
    }
    quantity = roundTo(available);
  } else if (quantity === null) {
    const { amount, currency } = modelIntent.notional;
    let amountInQuote = amount;

    if (currency === 'INR') {
      const rate = context.usdInrRate;
      if (!Number.isFinite(rate) || rate <= 0) {
        return clarification(
          'INR amounts require an explicit USD/INR rate. Specify the trade in USD/USDT or ask the operator to configure USD_INR_RATE.'
        );
      }
      amountInQuote = amount / rate;
      warnings.push(
        `Converted ${amount} INR to ${roundTo(amountInQuote, 2)} USD using the configured USD_INR_RATE (${rate}).`
      );
    } else if (currency === 'USD') {
      warnings.push('USD is treated as 1:1 with USDT for this paper-trading account.');
    }

    // A spend amount must never be exceeded. Rounding to the nearest supported
    // precision can overshoot (100 USDT / 600 USDT -> 0.16666667 costs
    // 100.000002), so floor instead and correct any float drift downward once.
    quantity = floorTo(amountInQuote / priceForSizing);
    if (quantity > 0 && quantity * priceForSizing > amountInQuote) {
      quantity = floorTo(quantity - 10 ** -DECIMALS);
    }
  }

  const quantityCheck = validateQuantity(quantity);
  if (!quantityCheck.ok) {
    return invalid(
      'INVALID_INTENT',
      quantity < MIN_QUANTITY
        ? `Resolved quantity is below the minimum of ${MIN_QUANTITY}.`
        : quantityCheck.error
    );
  }
  quantity = quantityCheck.value;

  const notionalCheck = validateNotional(quantity, priceForSizing);
  if (!notionalCheck.ok) return invalid('INVALID_INTENT', notionalCheck.error);
  const estimatedValue = notionalCheck.value;

  const balance = Number(context.balance) || 0;
  const availableQuantity = Number(context.holdings?.[symbol]) || 0;

  if (side === 'BUY' && estimatedValue > balance) {
    warnings.push(
      `Insufficient USDT balance: order needs ${estimatedValue} but available is ${roundTo(balance)}.`
    );
  }
  if (side === 'SELL' && quantity > availableQuantity) {
    warnings.push(
      `Insufficient ${symbol}: order needs ${quantity} but available is ${roundTo(availableQuantity)}.`
    );
  }
  if (orderType === 'MARKET') {
    warnings.push(
      `Execution uses a fresh server quote; the price may move within ${context.maxPriceDriftPct}% of this preview.`
    );
  }

  return {
    ok: true,
    value: {
      intent: {
        side,
        symbol,
        orderType,
        quantity,
        limitPrice: orderType === 'LIMIT' ? modelIntent.limitPrice : null,
        referencePrice
      },
      preview: {
        side,
        symbol,
        orderType,
        quantity,
        quotePrice: referencePrice,
        quoteTs,
        limitPrice: orderType === 'LIMIT' ? modelIntent.limitPrice : null,
        estimatedValue,
        currency: 'USDT',
        balance,
        availableQuantity,
        warnings
      }
    }
  };
}

const STORED_INTENT_FIELDS = Object.freeze([
  'side',
  'symbol',
  'orderType',
  'quantity',
  'limitPrice',
  'referencePrice'
]);

function revalidateStoredIntent(intent) {
  if (!isPlainObject(intent)) {
    return invalid('INVALID_PROPOSAL', 'Stored proposal intent is invalid.');
  }
  const extra = unexpectedKeys(intent, STORED_INTENT_FIELDS);
  if (extra.length > 0) {
    return invalid('INVALID_PROPOSAL', 'Stored proposal intent is invalid.');
  }

  const sideCheck = validateSide(intent.side);
  if (!sideCheck.ok) return invalid('INVALID_PROPOSAL', sideCheck.error);

  const symbolCheck = validateSymbol(intent.symbol);
  if (!symbolCheck.ok) return invalid('INVALID_PROPOSAL', symbolCheck.error);

  const quantityCheck = validateQuantity(intent.quantity);
  if (!quantityCheck.ok) return invalid('INVALID_PROPOSAL', quantityCheck.error);

  const orderType = typeof intent.orderType === 'string' ? intent.orderType.trim().toUpperCase() : null;
  if (!orderType || !ORDER_TYPES.includes(orderType)) {
    return invalid('INVALID_PROPOSAL', 'Stored proposal order type is invalid.');
  }

  let limitPrice = null;
  if (orderType === 'LIMIT') {
    const priceCheck = validateLimitPrice(intent.limitPrice);
    if (!priceCheck.ok) return invalid('INVALID_PROPOSAL', priceCheck.error);
    limitPrice = priceCheck.value;

    const notionalCheck = validateNotional(quantityCheck.value, limitPrice);
    if (!notionalCheck.ok) return invalid('INVALID_PROPOSAL', notionalCheck.error);
  } else if (intent.limitPrice !== null && intent.limitPrice !== undefined) {
    return invalid('INVALID_PROPOSAL', 'Market proposals cannot carry a limit price.');
  }

  return {
    ok: true,
    value: {
      side: sideCheck.value,
      symbol: symbolCheck.value,
      orderType,
      quantity: quantityCheck.value,
      limitPrice
    }
  };
}

module.exports = {
  ALLOWED_MODEL_FIELDS,
  ALLOWED_NOTIONAL_FIELDS,
  ORDER_TYPES,
  NOTIONAL_CURRENCIES,
  validateModelIntent,
  resolveIntent,
  revalidateStoredIntent
};
