import { describe, it, expect } from 'vitest';
import { Ema, Rma, Sma, Wma } from './averages';
import { expectSeries, runSeries } from './testing';

const NA = NaN;
const SRC = [2, 4, 6, 8, 10, 6];

describe('Sma', () => {
  it('averages the last N values', () => {
    // (2+4+6)/3=4, (4+6+8)/3=6, (6+8+10)/3=8, (8+10+6)/3=8
    expectSeries(runSeries(new Sma(3), SRC), [NA, NA, 4, 6, 8, 8]);
  });

  it('cancels floating-point drift within one window', () => {
    const out = runSeries(new Sma(2), [1e17, 1, 1, 1, 1]);
    expect(out[4]).toBe(1);
  });

  it('rejects invalid lengths', () => {
    expect(() => new Sma(0)).toThrow('length must be a positive integer');
  });
});

describe('Ema', () => {
  it('is seeded with the SMA of the first N values, then alpha = 2/(N+1)', () => {
    // seed (2+4+6)/3=4; alpha=0.5: 0.5*8+0.5*4=6; 0.5*10+0.5*6=8; 0.5*6+0.5*8=7
    expectSeries(runSeries(new Ema(3), SRC), [NA, NA, 4, 6, 8, 7]);
  });

  it('skips leading na inputs without advancing', () => {
    // seed (1+3)/2=2; alpha=2/3: (2/3)*5+(1/3)*2=4
    expectSeries(runSeries(new Ema(2), [NA, NA, 1, 3, 5]), [NA, NA, NA, 2, 4]);
  });
});

describe('Rma', () => {
  it('is seeded with the SMA, then alpha = 1/N (Wilder)', () => {
    // seed 4; (8+2*4)/3=16/3; (10+2*16/3)/3=62/9; (6+2*62/9)/3=178/27
    expectSeries(runSeries(new Rma(3), SRC), [NA, NA, 4, 16 / 3, 62 / 9, 178 / 27]);
  });
});

describe('Wma', () => {
  it('weights the newest value most', () => {
    // (1*1+2*2+3*3)/6=14/6; (1*2+2*3+3*4)/6=20/6; (1*3+2*4+3*5)/6=26/6
    expectSeries(runSeries(new Wma(3), [1, 2, 3, 4, 5]), [NA, NA, 14 / 6, 20 / 6, 26 / 6]);
  });
});
