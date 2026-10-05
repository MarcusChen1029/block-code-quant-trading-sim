import { describe, it } from 'vitest';
import { Vwap } from './vwap';
import { expectSeries } from './testing';

const NA = NaN;
const DAY = 86_400_000;

describe('Vwap', () => {
  it('accumulates hlc3 * volume and resets at each UTC day', () => {
    const vwap = new Vwap();
    const out = [
      { time: 0, open: 9, high: 10, low: 8, close: 9, volume: 2 }, // hlc3 9 -> 9
      { time: 3_600_000, open: 9, high: 12, low: 9, close: 12, volume: 1 }, // hlc3 11 -> (18+11)/3
      { time: DAY, open: 19, high: 20, low: 18, close: 19, volume: 5 }, // new day -> 19
      { time: 2 * DAY, open: 19, high: 20, low: 18, close: 19, volume: 0 }, // new day, no volume -> na
    ].map((c) => vwap.update(c));
    expectSeries(out, [9, 29 / 3, 19, NA]);
  });
});
