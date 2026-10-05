import { describe, it } from 'vitest';
import { Atr } from './volatility';
import { expectSeries } from './testing';

const NA = NaN;

describe('Atr', () => {
  it('is the RMA of true range, first TR = high - low', () => {
    const bars = [
      { high: 10, low: 8, close: 9 }, // TR 2
      { high: 12, low: 9, close: 11 }, // TR 3
      { high: 11, low: 7, close: 8 }, // TR 4
    ];
    const atr = new Atr(2);
    // seed (2+3)/2 = 2.5; then 0.5*4 + 0.5*2.5 = 3.25
    expectSeries(bars.map((b) => atr.update(b)), [NA, 2.5, 3.25]);
  });
});
