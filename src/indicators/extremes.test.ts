import { describe, it, expect } from 'vitest';
import { Highest, Lowest } from './extremes';
import { expectSeries, runSeries } from './testing';

const NA = NaN;
const SRC = [3, 1, 4, 1, 5, 9, 2, 6];

describe('Highest', () => {
  it('returns the max of the last N values', () => {
    expectSeries(runSeries(new Highest(3), SRC), [NA, NA, 4, 4, 5, 9, 9, 9]);
  });
});

describe('Lowest', () => {
  it('returns the min of the last N values', () => {
    expectSeries(runSeries(new Lowest(3), SRC), [NA, NA, 1, 1, 1, 1, 2, 2]);
  });

  it('stays correct after internal compaction on long runs', () => {
    const values = Array.from({ length: 5000 }, (_, i) => i);
    const out = runSeries(new Lowest(3), values);
    expect(out[4999]).toBe(4997);
  });
});
