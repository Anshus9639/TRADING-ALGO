// Intervals the charting workspace offers. Anything else is rejected before an
// upstream request is made so the exchange is never used as a proxy.
const CHART_INTERVALS = Object.freeze(['1m', '5m', '15m', '1h', '4h', '1d']);

function normalizeChartInterval(value) {
  if (typeof value !== 'string') return null;
  const interval = value.trim();
  return CHART_INTERVALS.includes(interval) ? interval : null;
}

module.exports = {
  CHART_INTERVALS,
  normalizeChartInterval
};
