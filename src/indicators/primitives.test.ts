import { describe, it, expect } from 'vitest';
import { Change, CrossOver, CrossUnder, TrueRange } from './primitives';
import { expectSeries, runSeries } from './testing';

const NA = NaN;

describe('Change', () => {
  it('returns source - source[length]', () => {
    expectSeries(runSeries(new Change(), [1, 3, 6]), [NA, 2, 3]);
    expectSeries(runSeries(new Change(2), [1, 3, 6]), [NA, NA, 5]);
  });
});

describe('TrueRange', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 12, low: 9, close: 11 }, // max(3, |12-9|=3, |9-9|=0) = 3
    { high: 11, low: 7, close: 8 }, //  max(4, |11-11|=0, |7-11|=4) = 4
  ];

  it('is na on the first bar by default (ta.tr)', () => {
    const tr = new TrueRange();
    expectSeries(bars.map((b) => tr.update(b)), [NA, 3, 4]);
  });

  it('uses high - low on the first bar when handleNa is true (ta.tr(true))', () => {
    const tr = new TrueRange(true);
    expectSeries(bars.map((b) => tr.update(b)), [2, 3, 4]);
  });
});

describe('CrossOver / CrossUnder', () => {
  const a = [1, 2, 3, 2, 1];
  const b = [2, 2, 2, 2, 2];

  it('crossover fires when a goes from <= b to > b', () => {
    const x = new CrossOver();
    expect(a.map((v, i) => x.update(v, b[i]))).toEqual([false, false, true, false, false]);
  });

  it('crossunder fires when a goes from >= b to < b', () => {
    const x = new CrossUnder();
    expect(a.map((v, i) => x.update(v, b[i]))).toEqual([false, false, false, false, true]);
  });
});
