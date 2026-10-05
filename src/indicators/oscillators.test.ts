import { describe, it } from 'vitest';
import { Macd, Rsi, Stochastic } from './oscillators';
import { expectSeries, runSeries } from './testing';

const NA = NaN;

describe('Rsi', () => {
  it('matches the Wilder formula with RMA seeding', () => {
    // gains/losses from bar 1: +1, +1, -1, +2. RMA(2) seed at bar 2: up=1, down=0 -> 100.
    // bar 3: up=0.5*0+0.5*1=0.5, down=0.5*1+0.5*0=0.5 -> 50.
    // bar 4: up=0.5*2+0.5*0.5=1.25, down=0.5*0+0.5*0.5=0.25 -> rs=5 -> 100-100/6=83.3333
    expectSeries(runSeries(new Rsi(2), [1, 2, 3, 2, 4]), [NA, NA, 100, 50, 83.333333]);
  });
});

describe('Macd', () => {
  it('computes macd, signal and histogram', () => {
    // EMA2 (alpha 2/3) of [1,2,4,8,16,32]: -,1.5,3.166667,6.388889,12.796296,25.598765
    // EMA3 (alpha 1/2): -,-,2.333333,5.166667,10.583333,21.291667
    // signal = EMA2 of macd, seeded at bar 3 with (0.833333+1.222222)/2
    const m = new Macd(2, 3, 2);
    const out = [1, 2, 4, 8, 16, 32].map((v) => m.update(v));
    expectSeries(out.map((o) => o.macd), [NA, NA, 0.833333, 1.222222, 2.212963, 4.307099], 5);
    expectSeries(out.map((o) => o.signal), [NA, NA, NA, 1.027778, 1.817901, 3.477366], 5);
    expectSeries(out.map((o) => o.hist), [NA, NA, NA, 0.194444, 0.395062, 0.829733], 5);
  });
});

describe('Stochastic', () => {
  it('computes %K and %D', () => {
    const bars = [
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 9, close: 11 },
      { high: 11, low: 7, close: 8 }, // hh=12, ll=7: 100*(8-7)/5 = 20
      { high: 13, low: 10, close: 12 }, // hh=13, ll=7: 100*(12-7)/6 = 83.3333
    ];
    const st = new Stochastic(3, 1, 2);
    const out = bars.map((b) => st.update(b));
    expectSeries(out.map((o) => o.k), [NA, NA, 20, 83.333333]);
    expectSeries(out.map((o) => o.d), [NA, NA, NA, 51.666667]);
  });

  it('returns na when the range is zero', () => {
    const st = new Stochastic(2, 1, 1);
    const flat = { high: 5, low: 5, close: 5 };
    expectSeries([st.update(flat), st.update(flat)].map((o) => o.k), [NA, NA]);
  });
});
