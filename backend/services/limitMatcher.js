function shouldExecuteLimitOrder(order, quote) {
  if (!quote || quote.status !== 'ok') return false;
  if (!order) return false;

  if (order.type === 'BUY') return quote.price <= order.limitPrice;
  if (order.type === 'SELL') return quote.price >= order.limitPrice;

  return false;
}

module.exports = { shouldExecuteLimitOrder };
