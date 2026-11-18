const {
  DUST_THRESHOLD,
  MIN_QUANTITY,
  floorTo,
  roundTo
} = require('../lib/numbers');

describe('numeric guards', () => {
  test('the dust threshold stays strictly below the minimum tradable quantity', () => {
    expect(DUST_THRESHOLD).toBeGreaterThan(0);
    expect(DUST_THRESHOLD).toBeLessThan(MIN_QUANTITY);
  });

  test('floorTo never rounds a derived quantity upward', () => {
    expect(floorTo(100 / 600)).toBe(0.16666666);
    expect(roundTo(100 / 600)).toBe(0.16666667);
    expect(floorTo(0.1 + 0.2)).toBe(0.3);
    expect(floorTo(1.999999999)).toBe(1.99999999);
    expect(Number.isNaN(floorTo(Number.NaN))).toBe(true);
  });
});
