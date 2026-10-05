import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Atr } from '../indicators/volatility';
import { compilePine, runPine, type PineScript } from './compile';
import { PINE_TEMPLATES, SUPERTREND_SOURCE } from './templates';
import { compileOk, expectSeriesEqual, fixture, plots, script } from './testing';

const CANDLES = fixture(400);
const closes = CANDLES.map((c) => c.close);

/** Hand-written Supertrend with the same rules as the template (ATR 10, factor 3, source hl2). */
function supertrendReference(candles: Candle[], atrLength = 10, factor = 3) {
  const atr = new Atr(atrLength);
  let upper = NaN;
  let lower = NaN;
  let trend = 1;
  const line: number[] = [];
  const up: number[] = [];
  const down: number[] = [];
  candles.forEach((c, i) => {
    const a = atr.update(c);
    const src = (c.high + c.low) / 2;
    const basicUpper = src + factor * a;
    const basicLower = src - factor * a;
    const prevUpper = upper;
    const prevLower = lower;
    const prevClose = i > 0 ? candles[i - 1].close : NaN;
    upper = Number.isNaN(prevUpper) || prevClose > prevUpper ? basicUpper : Math.min(basicUpper, prevUpper);
    lower = Number.isNaN(prevLower) || prevClose < prevLower ? basicLower : Math.max(basicLower, prevLower);
    if (Number.isNaN(a)) trend = 1;
    else if (trend === -1 && c.close > prevUpper) trend = 1;
    else if (trend === 1 && c.close < prevLower) trend = -1;
    line.push(trend === 1 ? lower : upper);
    up.push(trend === 1 ? lower : NaN);
    down.push(trend === -1 ? upper : NaN);
  });
  return { line, up, down };
}

/** Streams bars one at a time into one instance, and recomputes from scratch for each prefix: must agree. */
function expectStreamingEqualsBatch(s: PineScript, candles: Candle[], checkpoints: number[]): void {
  const inst = s.create();
  const streamed: Record<string, number>[] = candles.map((c) => inst.step(undefined, c));
  for (const k of checkpoints) {
    const batch = runPine(s, candles.slice(0, k + 1));
    for (const p of s.plots) {
      expect(Object.is(batch[p.key][k], streamed[k][p.key]) || batch[p.key][k] === streamed[k][p.key], `${p.key} @${k}`).toBe(true);
    }
  }
  const full = runPine(s, candles);
  for (const p of s.plots) expect(full[p.key]).toEqual(streamed.map((r) => r[p.key]));
}

describe('Supertrend example', () => {
  it('matches the hand-written reference on the fixture, and flips trend both ways', () => {
    const s = compileOk(SUPERTREND_SOURCE);
    expect(s.title).toBe('Supertrend');
    expect(s.overlay).toBe(true);
    expect(s.inputs.map((i) => [i.name, i.default])).toEqual([['atrlength', 10], ['factor', 3]]);
    expect(s.plots.map((p) => p.key)).toEqual(['supertrend', 'up_trend', 'down_trend']);
    const out = runPine(s, CANDLES);
    const ref = supertrendReference(CANDLES);
    expectSeriesEqual(out.supertrend, ref.line, 1e-9, 'supertrend');
    expectSeriesEqual(out.up_trend, ref.up, 1e-9, 'up');
    expectSeriesEqual(out.down_trend, ref.down, 1e-9, 'down');
    expect(ref.up.some((v) => !Number.isNaN(v))).toBe(true);
    expect(ref.down.some((v) => !Number.isNaN(v))).toBe(true);
  });

  it('parameters change the result (factor 1.5 = reference with factor 1.5)', () => {
    const s = compileOk(SUPERTREND_SOURCE);
    const out = runPine(s, CANDLES, { atrlength: 7, factor: 1.5 });
    expectSeriesEqual(out.supertrend, supertrendReference(CANDLES, 7, 1.5).line, 1e-9);
  });

  it('every template compiles without errors', () => {
    for (const t of PINE_TEMPLATES) {
      const result = compilePine(t.source);
      expect(result.ok, t.id).toBe(true);
    }
  });
});

describe('streaming == batch', () => {
  it('Supertrend and a script with var / history / loops agree bar by bar with from-scratch recomputation', () => {
    expectStreamingEqualsBatch(compileOk(SUPERTREND_SOURCE), CANDLES.slice(0, 320), [0, 1, 2, 9, 10, 11, 57, 150, 319]);
    const other = compileOk(script(`
var float acc = 0.0
acc := acc + close
m = ta.ema(close, 5)
s = 0.0
for i = 0 to 3
    s += close[i]
plot(acc, "acc")
plot(m[2], "lagged")
plot(s, "sum4")
`));
    expectStreamingEqualsBatch(other, CANDLES.slice(0, 310), [0, 1, 3, 4, 5, 6, 100, 309]);
  });

  it('is deterministic: two runs give identical output', () => {
    const s = compileOk(SUPERTREND_SOURCE);
    expect(runPine(s, CANDLES)).toEqual(runPine(s, CANDLES));
  });
});

describe('language semantics', () => {
  it('var initialises once, from bar 0, including a 1-bar run', () => {
    const body = `
var int count = 0
count += 1
var float first = close
plain = 0
plain := plain + 1
plot(count, "count")
plot(first, "first")
plot(plain, "plain")
`;
    expect(plots(body, CANDLES.slice(0, 1))).toEqual({ count: [1], first: [closes[0]], plain: [1] });
    const five = plots(body, CANDLES.slice(0, 5));
    expect(five.count).toEqual([1, 2, 3, 4, 5]);
    expect(five.first).toEqual(Array(5).fill(closes[0]));
    expect(five.plain).toEqual([1, 1, 1, 1, 1]);
  });

  it('history x[n] of series and variables (final value of the previous bar), na before enough bars', () => {
    const out = plots(`
x = close * 2
var int c = 0
c := c + 1
y = 0.0
y := c * 10
plot(x[3], "x3")
plot(c[1], "c1")
plot(y[1], "y1")
plot(close[0], "c0")
plot(bar_index[2], "bi2")
plot(time[1], "t1")
`, CANDLES.slice(0, 6));
    expectSeriesEqual(out.x3, [NaN, NaN, NaN, ...closes.slice(0, 3).map((v) => v * 2)]);
    expect(out.c1).toEqual([NaN, 1, 2, 3, 4, 5]);
    expect(out.y1).toEqual([NaN, 10, 20, 30, 40, 50]);
    expect(out.c0).toEqual(closes.slice(0, 6));
    expect(out.bi2).toEqual([NaN, NaN, 0, 1, 2, 3]);
    expect(out.t1).toEqual([NaN, ...CANDLES.slice(0, 5).map((c) => c.time)]);
  });

  it('history offset from a bounded input is sized by maxval and follows the parameter', () => {
    const s = compileOk(script(`
n = input.int(2, "Bars back", minval=0, maxval=50)
plot(close[n], "back")
`));
    expectSeriesEqual(runPine(s, CANDLES.slice(0, 60), { n: 40 }).back, [...Array(40).fill(NaN), ...closes.slice(0, 20)]);
    expectSeriesEqual(runPine(s, CANDLES.slice(0, 5)).back, [NaN, NaN, ...closes.slice(0, 3)]);
  });

  it('na, nz, na() and na propagation', () => {
    const out = plots(`
plot(nz(close[1], -1), "nz")
plot(nz(close[1]), "nz0")
plot(na(close[1]) ? 1 : 0, "isna")
plot(close[1] + 1, "prop")
plot(na, "nothing")
`, CANDLES.slice(0, 3));
    expect(out.nz).toEqual([-1, closes[0], closes[1]]);
    expect(out.nz0).toEqual([0, closes[0], closes[1]]);
    expect(out.isna).toEqual([1, 0, 0]);
    expectSeriesEqual(out.prop, [NaN, closes[0] + 1, closes[1] + 1]);
    expectSeriesEqual(out.nothing, [NaN, NaN, NaN]);
  });

  it('user functions: single-line, block body with locals and if, tuple return, functions calling functions', () => {
    const out = plots(`
f(a, b) => a * b + 1
g(x) =>
    y = x * 2
    if y > 205
        y := 205
    y
pair(v) => [v, f(v, 2)]
[p, q] = pair(close)
plot(f(close, 3), "f")
plot(g(close), "g")
plot(p, "p")
plot(q, "q")
`, CANDLES.slice(0, 40));
    expect(out.f).toEqual(closes.slice(0, 40).map((c) => c * 3 + 1));
    expect(out.g).toEqual(closes.slice(0, 40).map((c) => Math.min(c * 2, 205)));
    expect(out.p).toEqual(closes.slice(0, 40));
    expect(out.q).toEqual(closes.slice(0, 40).map((c) => c * 2 + 1));
    expect(out.g.some((v) => v === 205)).toBe(true);
  });

  it('for loops: inclusive bounds, counting down, by, break, continue', () => {
    const out = plots(`
up = 0
for i = 0 to 4
    up += i
down = 0
for i = 10 to 0 by 2
    down += i
br = 0
for i = 1 to 100
    if i > 3
        break
    br += i
co = 0
for i = 1 to 6
    if i % 2 == 0
        continue
    co += i
none = 0
for i = 0 to na
    none += 1
plot(up, "up")
plot(down, "down")
plot(br, "br")
plot(co, "co")
plot(none, "none")
`, CANDLES.slice(0, 1));
    expect(out).toEqual({ up: [10], down: [30], br: [6], co: [9], none: [0] });
  });

  it('ternary, :=, compound assignment, and / or / not, comparison, arithmetic precedence', () => {
    const out = plots(`
a = 2 + 3 * 4 - 6 / 3
b = 7 % 3
c = 1
c := c + 1
c *= 10
c -= 5
c /= 3
d = close > open ? 1 : close < open ? -1 : 0
e = (true and not false) or false ? 1 : 0
f = 1 < 2 and 2 <= 2 and 3 > 2 and 3 >= 3 and 1 == 1 and 1 != 2 ? 1 : 0
g = -close + 0
plot(a, "a")
plot(b, "b")
plot(c, "c")
plot(d, "d")
plot(e, "e")
plot(f, "f")
plot(g, "g")
`, CANDLES.slice(0, 3));
    expect(out.a).toEqual([12, 12, 12]);
    expect(out.b).toEqual([1, 1, 1]);
    expect(out.c).toEqual([5, 5, 5]);
    expect(out.d).toEqual(CANDLES.slice(0, 3).map((k) => (k.close > k.open ? 1 : k.close < k.open ? -1 : 0)));
    expect(out.e).toEqual([1, 1, 1]);
    expect(out.f).toEqual([1, 1, 1]);
    expect(out.g).toEqual(closes.slice(0, 3).map((v) => -v));
  });

  it('tuple destructuring of ta.macd / ta.bb at the top level', () => {
    const out = plots(`
[m, s, h] = ta.macd(close, 3, 6, 2)
plot(m - s - h, "zero")
`, CANDLES.slice(0, 30));
    expect(out.zero.filter((v) => !Number.isNaN(v)).every((v) => Math.abs(v) < 1e-12)).toBe(true);
  });

  it('inputs: int / float / bool become parameters with defaults; sources use the block source or their default', () => {
    const s = compileOk(script(`
len = input.int(5, "Length", minval=1, maxval=50)
k = input.float(1.5, "Mult")
on = input.bool(true, "Enabled")
src = input.source(hl2, "Source")
other = input.source(open, "Other")
plot(on ? src * k + len : 0, "v")
plot(other, "o")
`));
    expect(s.inputs).toEqual([
      { name: 'len', varName: 'len', kind: 'int', title: 'Length', default: 5, min: 1, max: 50 },
      { name: 'k', varName: 'k', kind: 'float', title: 'Mult', default: 1.5 },
      { name: 'on', varName: 'on', kind: 'bool', title: 'Enabled', default: 1, min: 0, max: 1 },
    ]);
    expect(s.sources.map((x) => [x.varName, x.default])).toEqual([['src', 'hl2'], ['other', 'open']]);
    const c = CANDLES[0];
    const inst = s.create({ len: 2, k: 2, on: 1 });
    expect(inst.step(undefined, c)).toEqual({ v: (c.high + c.low) + 2, o: c.open });
    expect(inst.step(10, CANDLES[1])).toEqual({ v: 22, o: CANDLES[1].open });
    expect(s.create({ on: 0 }).step(undefined, c).v).toBe(0);
    expect(() => s.create({ len: 99 })).toThrow(/Length.*from 1 to 50/);
    expect(() => s.create({ len: 2.5 })).toThrow(/whole number/);
  });

  it('a script without //@version compiles with a warning; line continuation and comments work', () => {
    const result = compilePine(`indicator("x")
// comment line
total = close +
  open   // continuation: indented by a non-multiple of 4
plot(total, "t")
`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.warnings[0].message).toMatch(/no \/\/@version=5/);
    expect(runPine(result.script, CANDLES.slice(0, 1)).t).toEqual([CANDLES[0].close + CANDLES[0].open]);
  });

  it('ta.* in a conditional is a warning (state only updates when executed), not an error', () => {
    const result = compilePine(script(`
x = 0.0
if close > open
    x := ta.sma(close, 3)
plot(x, "x")
`));
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([{ line: 5, col: 10, message: expect.stringMatching(/ta\.sma is inside a conditional or loop/) }]);
  });
});
