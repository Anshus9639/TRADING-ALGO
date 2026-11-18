export const INDICATOR_PERIOD = 20;

export function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

export function isValidCandle(row) {
  return Boolean(row)
    && isFiniteNumber(row.time)
    && row.time > 0
    && isFiniteNumber(row.open)
    && isFiniteNumber(row.high)
    && isFiniteNumber(row.low)
    && isFiniteNumber(row.close)
    && row.close > 0;
}

// Exchange snapshots can repeat a timestamp or arrive out of order. Collapse on
// time and never emit a bar that would make the chart render a zero price.
export function normalizeCandles(rows) {
  if (!Array.isArray(rows)) return [];
  const byTime = new Map();
  for (const row of rows) {
    if (!isValidCandle(row)) continue;
    byTime.set(row.time, {
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: isFiniteNumber(row.volume) && row.volume >= 0 ? row.volume : null
    });
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}

export function mergeCandle(candles, candle) {
  if (!isValidCandle(candle)) return Array.isArray(candles) ? candles : [];
  const next = Array.isArray(candles) ? candles.slice() : [];
  const last = next[next.length - 1];
  if (!last || candle.time > last.time) {
    next.push(candle);
    return next;
  }
  if (candle.time === last.time) {
    next[next.length - 1] = candle;
    return next;
  }
  const index = next.findIndex(entry => entry.time >= candle.time);
  if (index === -1) next.push(candle);
  else if (next[index].time === candle.time) next[index] = candle;
  else next.splice(index, 0, candle);
  return next;
}

export function calculateSma(candles, period = INDICATOR_PERIOD) {
  if (!Array.isArray(candles) || period <= 0) return [];
  const result = [];
  let sum = 0;
  for (let index = 0; index < candles.length; index += 1) {
    sum += candles[index].close;
    if (index >= period) sum -= candles[index - period].close;
    if (index >= period - 1) result.push({ time: candles[index].time, value: sum / period });
  }
  return result;
}

export function calculateEma(candles, period = INDICATOR_PERIOD) {
  if (!Array.isArray(candles) || candles.length === 0 || period <= 0) return [];
  const multiplier = 2 / (period + 1);
  const result = [];
  let ema = null;
  for (let index = 0; index < candles.length; index += 1) {
    if (index < period - 1) continue;
    if (ema === null) {
      let seed = 0;
      for (let cursor = 0; cursor < period; cursor += 1) seed += candles[cursor].close;
      ema = seed / period;
    } else {
      ema = (candles[index].close - ema) * multiplier + ema;
    }
    result.push({ time: candles[index].time, value: ema });
  }
  return result;
}
