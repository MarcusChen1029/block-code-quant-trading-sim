import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Ema, Rma, Sma, Wma } from '../indicators/averages';
import { BollingerBands } from '../indicators/bands';
import { Highest, Lowest } from '../indicators/extremes';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Change } from '../indicators/primitives';
import type { SeriesIndicator } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { expectSeriesEqual, fixture, plots } from './testing';

/**
 * PARITY: each indicator computed by a Pine script equals src/indicators per bar (≤ 1e-9, identical na warm-up),
 * both through the ta.* call and through a hand-written Pine re-implementation of the formula (var, history,
 * for loops, if/else), which exercises the compiler rather than the reused classes.
 */
const CANDLES: Candle[] = fixture(400);
const closes = CANDLES.map((c) => c.close);
const series = (ind: SeriesIndicator, values = closes) => values.map((v) => ind.update(v));

describe('Pine parity with src/indicators (400-bar fixture)', () => {
  it('fixture is long enough and has a flat stretch', () => {
    expect(CANDLES.length).toBeGreaterThanOrEqual(300);
    expect(CANDLES.some((c) => c.high === c.low)).toBe(true);
  });

  it('sma', () => {
    const out = plots(`
len = input.int(14, "Length", minval=1, maxval=100)
s = 0.0
for i = 0 to len - 1
    s := s + close[i]
plot(bar_index >= len - 1 ? s / len : na, "manual")
plot(ta.sma(close, len), "ta")
`);
    const ref = series(new Sma(14));
    expectSeriesEqual(out.manual, ref, 1e-9, 'manual');
    expectSeriesEqual(out.ta, ref, 1e-9, 'ta');
  });

  for (const [name, alpha, make] of [
    ['ema', '2.0 / (len + 1)', (n: number) => new Ema(n)],
    ['rma', '1.0 / len', (n: number) => new Rma(n)],
  ] as const) {
    it(`${name} (SMA-seeded)`, () => {
      const out = plots(`
len = 10
alpha = ${alpha}
var float e = na
if na(e)
    if bar_index >= len - 1
        s = 0.0
        for i = 0 to len - 1
            s += close[i]
        e := s / len
else
    e := alpha * close + (1 - alpha) * e
plot(e, "manual")
plot(ta.${name}(close, len), "ta")
`);
      const ref = series(make(10));
      expectSeriesEqual(out.manual, ref, 1e-9, 'manual');
      expectSeriesEqual(out.ta, ref, 1e-9, 'ta');
    });
  }

  it('wma', () => {
    const out = plots(`
len = 9
num = 0.0
den = 0.0
for i = 0 to len - 1
    w = len - i
    num += close[i] * w
    den += w
plot(bar_index >= len - 1 ? num / den : na, "manual")
plot(ta.wma(close, len), "ta")
`);
    const ref = series(new Wma(9));
    expectSeriesEqual(out.manual, ref, 1e-9, 'manual');
    expectSeriesEqual(out.ta, ref, 1e-9, 'ta');
  });

  it('rsi (Wilder RMA of gains and losses)', () => {
    const out = plots(`
len = 14
alpha = 1.0 / len
u = math.max(close - close[1], 0)
d = math.max(close[1] - close, 0)
var float au = na
var float ad = na
var float su = 0.0
var float sd = 0.0
var int n = 0
if not na(close[1])
    n += 1
    if n <= len
        su += u
        sd += d
        if n == len
            au := su / len
            ad := sd / len
    else
        au := alpha * u + (1 - alpha) * au
        ad := alpha * d + (1 - alpha) * ad
manual = na(au) ? na : ad == 0 ? 100 : au == 0 ? 0 : 100 - 100 / (1 + au / ad)
plot(manual, "manual")
plot(ta.rsi(close, len), "ta")
`);
    const ref = series(new Rsi(14));
    expectSeriesEqual(out.manual, ref, 1e-9, 'manual');
    expectSeriesEqual(out.ta, ref, 1e-9, 'ta');
  });

  it('atr (true range + RMA)', () => {
    const out = plots(`
len = 14
tr = na(close[1]) ? high - low : math.max(high - low, math.abs(high - close[1]), math.abs(low - close[1]))
var float a = na
var float s = 0.0
s += bar_index < len ? tr : 0
if bar_index == len - 1
    a := s / len
else if bar_index >= len
    a := (1.0 / len) * tr + (1 - 1.0 / len) * a
plot(a, "manual")
plot(ta.atr(len), "ta")
`);
    const atr = new Atr(14);
    const ref = CANDLES.map((c) => atr.update(c));
    expectSeriesEqual(out.manual, ref, 1e-9, 'manual');
    expectSeriesEqual(out.ta, ref, 1e-9, 'ta');
  });

  it('macd (composed from ta.ema, and the ta.macd tuple)', () => {
    const out = plots(`
m = ta.ema(close, 12) - ta.ema(close, 26)
sig = ta.ema(m, 9)
[a, b, c] = ta.macd(close, 12, 26, 9)
plot(m, "m")
plot(sig, "s")
plot(m - sig, "h")
plot(a, "ta_m")
plot(b, "ta_s")
plot(c, "ta_h")
`);
    const macd = new Macd(12, 26, 9);
    const ref = closes.map((v) => macd.update(v));
    for (const [key, field] of [['m', 'macd'], ['s', 'signal'], ['h', 'hist']] as const) {
      const expected = ref.map((r) => r[field]);
      expectSeriesEqual(out[key], expected, 1e-9, key);
      expectSeriesEqual(out[`ta_${key}`], expected, 1e-9, `ta_${key}`);
    }
  });

  it('bb (manual stdev loop, and the ta.bb tuple)', () => {
    const out = plots(`
len = 20
mult = 2.0
basis = ta.sma(close, len)
ss = 0.0
for i = 0 to len - 1
    ss += math.pow(close[i] - basis, 2)
dev = mult * math.sqrt(ss / len)
[mid, up, lo] = ta.bb(close, len, mult)
plot(basis, "middle")
plot(basis + dev, "upper")
plot(basis - dev, "lower")
plot(mid, "ta_middle")
plot(up, "ta_upper")
plot(lo, "ta_lower")
`);
    const bb = new BollingerBands(20, 2);
    const ref = closes.map((v) => bb.update(v));
    for (const key of ['middle', 'upper', 'lower'] as const) {
      const expected = ref.map((r) => r[key]);
      expectSeriesEqual(out[key], expected, 1e-9, key);
      expectSeriesEqual(out[`ta_${key}`], expected, 1e-9, `ta_${key}`);
    }
  });

  it('stoch %K / %D (manual highest/lowest loop, and ta.stoch)', () => {
    const out = plots(`
len = 14
hh = high
ll = low
for i = 1 to len - 1
    hh := math.max(hh, high[i])
    ll := math.min(ll, low[i])
raw = bar_index >= len - 1 and hh != ll ? 100 * (close - ll) / (hh - ll) : na
k = ta.sma(raw, 3)
d = ta.sma(k, 3)
k2 = ta.sma(ta.stoch(close, high, low, len), 3)
plot(k, "k")
plot(d, "d")
plot(k2, "ta_k")
`);
    const st = new Stochastic(14, 3, 3);
    const ref = CANDLES.map((c) => st.update(c));
    expectSeriesEqual(out.k, ref.map((r) => r.k), 1e-9, 'k');
    expectSeriesEqual(out.d, ref.map((r) => r.d), 1e-9, 'd');
    expectSeriesEqual(out.ta_k, ref.map((r) => r.k), 1e-9, 'ta_k');
  });

  it('highest / lowest / change', () => {
    const out = plots(`
len = 20
hh = close
ll = close
for i = 1 to len - 1
    hh := math.max(hh, close[i])
    ll := math.min(ll, close[i])
plot(bar_index >= len - 1 ? hh : na, "hi")
plot(bar_index >= len - 1 ? ll : na, "lo")
plot(close - close[5], "chg")
plot(ta.highest(close, len), "ta_hi")
plot(ta.lowest(close, len), "ta_lo")
plot(ta.change(close, 5), "ta_chg")
plot(ta.highest(len), "ta_hi_high")
`);
    const hi = series(new Highest(20));
    const lo = series(new Lowest(20));
    const chg = series(new Change(5));
    expectSeriesEqual(out.hi, hi, 1e-9, 'hi');
    expectSeriesEqual(out.lo, lo, 1e-9, 'lo');
    expectSeriesEqual(out.chg, chg, 1e-9, 'chg');
    expectSeriesEqual(out.ta_hi, hi, 1e-9, 'ta_hi');
    expectSeriesEqual(out.ta_lo, lo, 1e-9, 'ta_lo');
    expectSeriesEqual(out.ta_chg, chg, 1e-9, 'ta_chg');
    expectSeriesEqual(out.ta_hi_high, series(new Highest(20), CANDLES.map((c) => c.high)), 1e-9, 'ta_hi_high');
  });

  it('ta.tr is na on bar 0 (Pine docs), ta.tr(true) is high - low there', () => {
    const out = plots(`
plot(ta.tr, "tr")
plot(ta.tr(true), "tr_na")
`);
    expect(out.tr[0]).toBeNaN();
    expect(out.tr_na[0]).toBeCloseTo(CANDLES[0].high - CANDLES[0].low, 12);
    expect(out.tr[1]).toBe(out.tr_na[1]);
  });
});
