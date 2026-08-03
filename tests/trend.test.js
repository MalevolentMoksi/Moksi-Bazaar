// tests/trend.test.js - the unified sentiment trend classifier.
const { trendDirection, TREND_THRESHOLD } = require('../src/utils/trend');

describe('trendDirection', () => {
  test('threshold is the canonical 0.15 (checkrelationship semantics)', () => {
    expect(TREND_THRESHOLD).toBe(0.15);
  });

  describe('too little history', () => {
    test('empty history returns null', () => {
      expect(trendDirection([])).toBeNull();
    });

    test('single point returns null', () => {
      expect(trendDirection([0.9])).toBeNull();
    });

    test('two points return null', () => {
      expect(trendDirection([-0.5, 0.5])).toBeNull();
    });

    test('non-array input returns null', () => {
      expect(trendDirection(undefined)).toBeNull();
      expect(trendDirection(null)).toBeNull();
    });
  });

  describe('direction across the 0.15 threshold', () => {
    test('recent average clearly above older average is rising', () => {
      // older avg 0, recent avg 0.2, delta 0.2 > 0.15
      expect(trendDirection([0, 0, 0, 0.2, 0.2, 0.2])).toBe('rising');
    });

    test('recent average clearly below older average is falling', () => {
      expect(trendDirection([0.2, 0.2, 0.2, 0, 0, 0])).toBe('falling');
    });

    test('delta of exactly +0.15 is still stable (strict inequality)', () => {
      expect(trendDirection([0, 0, 0, 0.15, 0.15, 0.15])).toBe('stable');
    });

    test('delta of exactly -0.15 is still stable', () => {
      expect(trendDirection([0.15, 0.15, 0.15, 0, 0, 0])).toBe('stable');
    });

    test('delta just past the threshold flips the label', () => {
      expect(trendDirection([0, 0, 0, 0.16, 0.16, 0.16])).toBe('rising');
      expect(trendDirection([0.16, 0.16, 0.16, 0, 0, 0])).toBe('falling');
    });

    test('a 0.1 delta (the old embedBuilder threshold) now reads stable', () => {
      expect(trendDirection([0, 0, 0, 0.1, 0.1, 0.1])).toBe('stable');
    });
  });

  test('exactly three points have no older baseline, so always stable', () => {
    expect(trendDirection([-1, 0, 1])).toBe('stable');
  });
});
