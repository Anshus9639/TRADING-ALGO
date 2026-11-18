import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateEma,
  calculateSma,
  isValidCandle,
  mergeCandle,
  normalizeCandles
} from '../src/lib/chartData.mjs';

function candle(time, close, open = close) {
  return { time, open, high: close + 1, low: open - 1, close, volume: 10 };
}

test('candles are validated, deduplicated by time, and sorted', () => {
  const rows = [
    candle(3, 3),
    candle(1, 1),
    { time: 2, open: 1, high: 1, low: 1, close: 0 },
    { time: 0, open: 1, high: 2, low: 1, close: 1.5 },
    { time: 4, open: '5', high: 6, low: 4, close: 5 },
    { time: 3, open: 30, high: 31, low: 29, close: 30, volume: 99 }
  ];

  const normalized = normalizeCandles(rows);
  assert.deepEqual(normalized.map(entry => entry.time), [1, 3]);
  assert.equal(normalized[1].close, 30);
  assert.equal(normalized[1].volume, 99);
  assert.equal(normalizeCandles(null).length, 0);
});

test('isValidCandle rejects zero and non-finite prices', () => {
  assert.equal(isValidCandle(candle(1, 2)), true);
  assert.equal(isValidCandle({ ...candle(1, 2), close: 0 }), false);
  assert.equal(isValidCandle({ ...candle(1, 2), high: Number.NaN }), false);
  assert.equal(isValidCandle({ ...candle(1, 2), time: 0 }), false);
  assert.equal(isValidCandle(null), false);
});

test('live candles append, replace the open bar, and insert late bars in order', () => {
  const base = [candle(1, 1), candle(2, 2)];

  const appended = mergeCandle(base, candle(3, 3));
  assert.deepEqual(appended.map(entry => entry.time), [1, 2, 3]);

  const replaced = mergeCandle(base, candle(2, 20));
  assert.deepEqual(replaced.map(entry => entry.time), [1, 2]);
  assert.equal(replaced[1].close, 20);

  const inserted = mergeCandle(base, candle(1.5, 1.5));
  assert.deepEqual(inserted.map(entry => entry.time), [1, 1.5, 2]);

  assert.equal(mergeCandle(base, { time: 9, close: 0 }).length, 2);
});

test('SMA uses a rolling window and starts at the period boundary', () => {
  const candles = [1, 2, 3, 4, 5].map((close, index) => candle(index + 1, close));
  assert.deepEqual(calculateSma(candles, 3), [
    { time: 3, value: 2 },
    { time: 4, value: 3 },
    { time: 5, value: 4 }
  ]);
  assert.deepEqual(calculateSma([], 3), []);
  assert.deepEqual(calculateSma(candles, 0), []);
});

test('EMA seeds from the SMA and applies the smoothing multiplier', () => {
  const candles = [1, 2, 3, 4, 5].map((close, index) => candle(index + 1, close));
  const ema = calculateEma(candles, 3);
  assert.deepEqual(ema, [
    { time: 3, value: 2 },
    { time: 4, value: 3 },
    { time: 5, value: 4 }
  ]);
  assert.deepEqual(calculateEma([], 3), []);
});
