import { describe, it } from 'vitest';
import { BollingerBands, Stdev } from './bands';
import { expectSeries, runSeries } from './testing';

const NA = NaN;

describe('Stdev', () => {
  it('is the population standard deviation of the window', () => {
    // [1,2,3]: var=2/3 -> 0.816497; [2,3,4]: same; [3,4,10]: mean 17/3, var=28.666667/3 -> 3.091206
    expectSeries(runSeries(new Stdev(3), [1, 2, 3, 4, 10]), [NA, NA, 0.816497, 0.816497, 3.091206]);
  });
});

describe('BollingerBands', () => {
  it('returns middle ± mult * stdev', () => {
    const bb = new BollingerBands(3, 2);
    const out = [1, 2, 3, 4, 10].map((v) => bb.update(v));
    expectSeries(out.map((o) => o.middle), [NA, NA, 2, 3, 5.666667]);
    expectSeries(out.map((o) => o.upper), [NA, NA, 3.632993, 4.632993, 11.849079]);
    expectSeries(out.map((o) => o.lower), [NA, NA, 0.367007, 1.367007, -0.515746]);
  });
});
