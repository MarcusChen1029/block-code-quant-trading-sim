import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Ema, Rma, Sma, Wma } from '../indicators/averages';
import { BollingerBands, Stdev } from '../indicators/bands';
import { Highest, Lowest } from '../indicators/extremes';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Change, CrossOver, CrossUnder, TrueRange } from '../indicators/primitives';
import type { SeriesIndicator } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { runPine } from './compile';
import { RSI_MA_V4_SOURCE, SUPERTREND_SOURCE } from './templates';
import { compileOk, expectSeriesEqual, fixture } from './testing';

/**
 * EQUIVALENCE: a Pine v4 script and its v5 spelling compile to the same program, so they must give
 * identical values on every bar. Where src/indicators has the indicator, both must also match it (≤ 1e-9).
 */
const CANDLES: Candle[] = fixture(400);
const closes = CANDLES.map((c) => c.close);
const run = (ind: SeriesIndicator, values: number[] = closes) => values.map((v) => ind.update(v));
const v4 = (body: string) => `//@version=4\nstudy("T")\n${body.replace(/^\n/, '')}`;
const v5 = (body: string) => `//@version=5\nindicator("T")\n${body.replace(/^\n/, '')}`;

/** Runs both spellings; asserts identical plot keys and per-bar values (Object.is, so na positions match). */
function equivalent(body4: string, body5: string): Record<string, number[]> {
  const a = compileOk(v4(body4));
  const b = compileOk(v5(body5));
  expect(a.version).toBe(4);
  expect(b.version).toBe(5);
  const outA = runPine(a, CANDLES);
  const outB = runPine(b, CANDLES);
  expect(Object.keys(outA)).toEqual(Object.keys(outB));
  for (const key of Object.keys(outB)) {
    expect(outA[key].every((v, i) => Object.is(v, outB[key][i])), `${key}: v4 and v5 differ`).toBe(true);
  }
  return outA;
}

describe('Pine v4 == Pine v5 (400-bar fixture)', () => {
  it('fixture is long enough', () => {
    expect(CANDLES.length).toBeGreaterThanOrEqual(300);
  });

  for (const [name, make] of [
    ['sma', () => new Sma(14)], ['ema', () => new Ema(14)], ['rma', () => new Rma(14)], ['wma', () => new Wma(14)],
    ['rsi', () => new Rsi(14)], ['stdev', () => new Stdev(14)],
  ] as const) {
    it(name, () => {
      const out = equivalent(`plot(${name}(close, 14), "x")`, `plot(ta.${name}(close, 14), "x")`);
      expectSeriesEqual(out.x, run(make()), 1e-9, name);
    });
  }

  it('atr and tr (variable and function)', () => {
    const out = equivalent(
      'plot(atr(14), "atr")\nplot(tr, "tr")\nplot(tr(true), "tr_na")',
      'plot(ta.atr(14), "atr")\nplot(ta.tr, "tr")\nplot(ta.tr(true), "tr_na")',
    );
    const atr = new Atr(14);
    const [tr, trNa] = [new TrueRange(false), new TrueRange(true)];
    expectSeriesEqual(out.atr, CANDLES.map((c) => atr.update(c)), 1e-9, 'atr');
    expectSeriesEqual(out.tr, CANDLES.map((c) => tr.update(c)), 1e-9, 'tr');
    expectSeriesEqual(out.tr_na, CANDLES.map((c) => trNa.update(c)), 1e-9, 'tr_na');
  });

  it('macd and bb tuples', () => {
    const out = equivalent(
      '[m, s, h] = macd(close, 12, 26, 9)\n[mid, up, lo] = bb(close, 20, 2)\nplot(m, "m")\nplot(s, "s")\nplot(h, "h")\nplot(mid, "mid")\nplot(up, "up")\nplot(lo, "lo")',
      '[m, s, h] = ta.macd(close, 12, 26, 9)\n[mid, up, lo] = ta.bb(close, 20, 2)\nplot(m, "m")\nplot(s, "s")\nplot(h, "h")\nplot(mid, "mid")\nplot(up, "up")\nplot(lo, "lo")',
    );
    const m = new Macd(12, 26, 9);
    const mr = closes.map((v) => m.update(v));
    expectSeriesEqual(out.m, mr.map((r) => r.macd), 1e-9, 'macd');
    expectSeriesEqual(out.s, mr.map((r) => r.signal), 1e-9, 'signal');
    expectSeriesEqual(out.h, mr.map((r) => r.hist), 1e-9, 'hist');
    const bb = new BollingerBands(20, 2);
    const br = closes.map((v) => bb.update(v));
    expectSeriesEqual(out.mid, br.map((r) => r.middle), 1e-9, 'middle');
    expectSeriesEqual(out.up, br.map((r) => r.upper), 1e-9, 'upper');
    expectSeriesEqual(out.lo, br.map((r) => r.lower), 1e-9, 'lower');
  });

  it('stoch (same argument order in v4 and v5)', () => {
    const out = equivalent('plot(sma(stoch(close, high, low, 14), 3), "k")', 'plot(ta.sma(ta.stoch(close, high, low, 14), 3), "k")');
    const st = new Stochastic(14, 3, 3);
    expectSeriesEqual(out.k, CANDLES.map((c) => st.update(c).k), 1e-9, 'k');
  });

  it('highest / lowest (one- and two-argument forms) and change (default length 1)', () => {
    const out = equivalent(
      'plot(highest(close, 20), "hi")\nplot(lowest(close, 20), "lo")\nplot(highest(20), "hi_high")\nplot(lowest(20), "lo_low")\nplot(change(close), "chg1")\nplot(change(close, 5), "chg5")',
      'plot(ta.highest(close, 20), "hi")\nplot(ta.lowest(close, 20), "lo")\nplot(ta.highest(20), "hi_high")\nplot(ta.lowest(20), "lo_low")\nplot(ta.change(close), "chg1")\nplot(ta.change(close, 5), "chg5")',
    );
    expectSeriesEqual(out.hi, run(new Highest(20)), 1e-9, 'hi');
    expectSeriesEqual(out.lo, run(new Lowest(20)), 1e-9, 'lo');
    expectSeriesEqual(out.hi_high, run(new Highest(20), CANDLES.map((c) => c.high)), 1e-9, 'hi_high');
    expectSeriesEqual(out.lo_low, run(new Lowest(20), CANDLES.map((c) => c.low)), 1e-9, 'lo_low');
    expectSeriesEqual(out.chg1, run(new Change(1)), 1e-9, 'chg1');
    expectSeriesEqual(out.chg5, run(new Change(5)), 1e-9, 'chg5');
  });

  it('crossover / crossunder', () => {
    const out = equivalent(
      'm = sma(close, 10)\nplot(crossover(close, m) ? 1 : 0, "over")\nplot(crossunder(close, m) ? 1 : 0, "under")',
      'm = ta.sma(close, 10)\nplot(ta.crossover(close, m) ? 1 : 0, "over")\nplot(ta.crossunder(close, m) ? 1 : 0, "under")',
    );
    const [sma, over, under] = [new Sma(10), new CrossOver(), new CrossUnder()];
    const ref = closes.map((c) => {
      const m = sma.update(c);
      return [over.update(c, m) ? 1 : 0, under.update(c, m) ? 1 : 0];
    });
    expect(out.over).toEqual(ref.map((r) => r[0]));
    expect(out.under).toEqual(ref.map((r) => r[1]));
    expect(out.over.some((v) => v === 1) && out.under.some((v) => v === 1)).toBe(true);
  });

  it('math functions without the math. prefix', () => {
    equivalent(
      'plot(max(open, close, high), "a")\nplot(min(open, close), "b")\nplot(abs(close - open), "c")\nplot(round(close, 2), "d")\nplot(sqrt(close) + pow(close, 2) + log(close) + exp(-1) + floor(close) + ceil(close) + sign(close - open) + avg(open, close), "e")',
      'plot(math.max(open, close, high), "a")\nplot(math.min(open, close), "b")\nplot(math.abs(close - open), "c")\nplot(math.round(close, 2), "d")\nplot(math.sqrt(close) + math.pow(close, 2) + math.log(close) + math.exp(-1) + math.floor(close) + math.ceil(close) + math.sign(close - open) + math.avg(open, close), "e")',
    );
  });

  it('iff(c, a, b) equals c ? a : b, and evaluates both branches (ta.* state updates on every bar, no warning)', () => {
    equivalent('plot(iff(close > open, high, low), "x")', 'plot(close > open ? high : low, "x")');
    // Both branches run every bar, so the sma in the "else" branch equals one computed at the top level.
    const s = compileOk(v4('plot(iff(close > open, close, sma(close, 5)), "x")\nplot(sma(close, 5), "ref")'));
    expect(s.warnings).toEqual([]);
    const out = runPine(s, CANDLES);
    out.x.forEach((v, i) => expect(Object.is(v, CANDLES[i].close > CANDLES[i].open ? CANDLES[i].close : out.ref[i])).toBe(true));
  });

  it('a Supertrend-style v4 script equals the v5 Supertrend template on every bar', () => {
    const v4Supertrend = SUPERTREND_SOURCE
      .replace('//@version=5', '//@version=4')
      .replace('indicator("Supertrend", overlay=true)', 'study("Supertrend", overlay=true)')
      .replace('input.int(10, "ATR length", minval=1, maxval=500)', 'input(10, "ATR length", type=input.integer, minval=1, maxval=500)')
      .replace('input.float(3.0, "Factor", minval=0.1, maxval=20)', 'input(3.0, "Factor", type=input.float, minval=0.1, maxval=20)')
      .replace('input.source(hl2, "Source")', 'input(hl2, "Source", type=input.source)')
      .replace('ta.atr(', 'atr(').replaceAll('math.min(', 'min(').replaceAll('math.max(', 'max(');
    expect(v4Supertrend).not.toMatch(/\bta\.|\bmath\.|input\.(int|float|source)\(|indicator/);
    const a = compileOk(v4Supertrend);
    const b = compileOk(SUPERTREND_SOURCE);
    expect(a.inputs).toEqual(b.inputs);
    expect(a.sources).toEqual(b.sources);
    expect(a.plots).toEqual(b.plots);
    expect([a.title, a.overlay]).toEqual([b.title, b.overlay]);
    expect(runPine(a, CANDLES)).toEqual(runPine(b, CANDLES));
    expect(runPine(a, CANDLES, { atrlength: 7, factor: 1.5 })).toEqual(runPine(b, CANDLES, { atrlength: 7, factor: 1.5 }));
  });
});

describe('Pine v4 front end details', () => {
  it('study() arguments, input(type=...) kinds, plot(transp=) and v4 plot positions', () => {
    const s = compileOk(`//@version=4
study(title="My study", shorttitle="MS", overlay=true)
len = input(14, "Length", input.integer, 1, 50)
k = input(1.5, title="Mult", type=input.float, minval=0.5, step=0.5)
on = input(true, "On", type=input.bool)
n = input(3, "Untyped int", minval=1)
src = input(hlc3, "Source", type=input.source)
m = sma(src, len)
plot(on ? m * k + n : na, "v", color.red, 2, plot.style_line, false, 50)
`);
    expect([s.title, s.shortTitle, s.overlay]).toEqual(['My study', 'MS', true]);
    expect(s.inputs).toEqual([
      { name: 'len', varName: 'len', kind: 'int', title: 'Length', default: 14, min: 1, max: 50 },
      { name: 'k', varName: 'k', kind: 'float', title: 'Mult', default: 1.5, min: 0.5 },
      { name: 'on', varName: 'on', kind: 'bool', title: 'On', default: 1, min: 0, max: 1 },
      { name: 'n', varName: 'n', kind: 'int', title: 'Untyped int', default: 3, min: 1 },
    ]);
    expect(s.sources).toEqual([{ varName: 'src', title: 'Source', default: 'hlc3' }]);
    expect(s.warnings).toEqual([]);
    expect(s.plots).toEqual([{ key: 'v', title: 'v' }]);
  });

  it('input(close) without a type compiles as a source, with a warning (the v4 docs do not say)', () => {
    const s = compileOk(v4('src = input(close, "Src")\nplot(src, "x")'));
    expect(s.sources).toEqual([{ varName: 'src', title: 'Src', default: 'close' }]);
    expect(s.warnings).toEqual([{ line: 3, col: 13, message: expect.stringMatching(/without type=input\.source/) }]);
  });

  it('user functions and variables named like v4 built-ins win over the rewrite', () => {
    const out = runPine(compileOk(v4('sma(x, n) => x * n\ntr = 2\nplot(sma(close, 3) + tr, "x")')), CANDLES.slice(0, 3));
    expect(out.x).toEqual(closes.slice(0, 3).map((c) => c * 3 + 2));
  });

  it('the shipped v4 template compiles as v4 and plots RSI and its MA', () => {
    const s = compileOk(RSI_MA_V4_SOURCE);
    expect([s.version, s.title, s.warnings]).toEqual([4, 'RSI + MA (v4)', []]);
    const out = runPine(s, CANDLES);
    expectSeriesEqual(out.rsi, run(new Rsi(14)), 1e-9, 'rsi');
    const ma = new Sma(9);
    expectSeriesEqual(out.rsi_ma, run(new Rsi(14)).map((v) => ma.update(v)), 1e-9, 'rsi_ma');
  });
});
