import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Ema } from '../indicators/averages';
import { Rsi } from '../indicators/oscillators';
import { compilePine, runPine, type PineScript } from './compile';
import { EMA_CROSS_SIGNALS_SOURCE, RSI_LEVELS_SOURCE } from './templates';
import { compileErrors, compileOk, fixture } from './testing';

const CANDLES = fixture(400);

/** Hand-written references, bar by bar. */
function emaCross(candles: Candle[], fastLen = 5, slowLen = 13) {
  const fast = new Ema(fastLen);
  const slow = new Ema(slowLen);
  let pf = NaN;
  let ps = NaN;
  const up: number[] = [];
  const down: number[] = [];
  for (const c of candles) {
    const f = fast.update(c.close);
    const s = slow.update(c.close);
    up.push(pf <= ps && f > s ? 1 : 0);
    down.push(pf >= ps && f < s ? 1 : 0);
    [pf, ps] = [f, s];
  }
  return { up, down };
}

const bullBar = (candles: Candle[]) => candles.map((c) => (c.close > c.open ? 1 : 0));
const engulf = (candles: Candle[]) => candles.map((c, i) => (i > 0 && c.close > c.open && candles[i - 1].close < candles[i - 1].open ? 1 : 0));

function streamed(s: PineScript, candles: Candle[]): Record<string, number[]> {
  const inst = s.create();
  const out: Record<string, number[]> = Object.fromEntries(s.signals.map((x) => [x.key, [] as number[]]));
  for (const c of candles) {
    const v = inst.step(undefined, c);
    for (const x of s.signals) out[x.key].push(v[x.key]);
  }
  return out;
}

const V5_CROSS = `//@version=5
indicator("Cross", overlay=true)
f = ta.ema(close, 5)
s = ta.ema(close, 13)
plotshape(ta.crossover(f, s), "Long", shape.triangleup, location.belowbar, color.green, text="L")
plotchar(ta.crossunder(f, s), "Short", "▼", location.abovebar, color.red)
alertcondition(close > open, "Bull bar", "close above open")
if close > open and close[1] < open[1]
    label.new(bar_index, low, "Engulf", style=label.style_label_up)
`;

const V4_CROSS = `//@version=4
study("Cross v4", overlay=true)
f = ema(close, 5)
s = ema(close, 13)
plotshape(crossover(f, s), "Long", shape.triangleup, location.belowbar, color.green, 0, 0, "L")
plotchar(crossunder(f, s), "Short", "▼", location.abovebar, color.red, transp=20)
alertcondition(close > open, "Bull bar", "close above open")
if close > open and close[1] < open[1]
    label.new(bar_index, low, "Engulf", style=label.style_label_up)
`;

const V6_CROSS = `//@version=6
indicator("Cross v6", overlay=true)
f = ta.ema(close, 5)
s = ta.ema(close, 13)
plotshape(ta.crossover(f, s), "Long", shape.triangleup, location.belowbar, color.green, text="L")
plotchar(ta.crossunder(f, s), "Short", "▼", location.abovebar, color.red)
alertcondition(close > open, "Bull bar", "close above open")
if close > open and close[1] < open[1]
    label.new(bar_index, low, "Engulf", style=label.style_label_up)
`;

describe('Pine signals: values per bar equal a hand-written reference (v4, v5, v6)', () => {
  const ref = emaCross(CANDLES);
  for (const [version, source] of [['v4', V4_CROSS], ['v5', V5_CROSS], ['v6', V6_CROSS]] as const) {
    it(`${version}: plotshape, plotchar, alertcondition and label.new`, () => {
      const s = compileOk(source);
      expect(s.plots).toEqual([]);
      expect(s.signals.map((x) => [x.key, x.title])).toEqual([['long', 'Long'], ['short', 'Short'], ['bull_bar', 'Bull bar'], ['engulf', 'Engulf']]);
      const out = runPine(s, CANDLES);
      expect(out.long).toEqual(ref.up);
      expect(out.short).toEqual(ref.down);
      expect(out.bull_bar).toEqual(bullBar(CANDLES));
      expect(out.engulf).toEqual(engulf(CANDLES));
      expect(ref.up.filter(Boolean).length).toBeGreaterThan(3);
      expect(ref.down.filter(Boolean).length).toBeGreaterThan(3);
      expect(engulf(CANDLES).filter(Boolean).length).toBeGreaterThan(3);
    });
  }

  it('streaming one bar at a time == batch from scratch (every prefix checkpoint)', () => {
    for (const source of [V5_CROSS, V4_CROSS, V6_CROSS, RSI_LEVELS_SOURCE]) {
      const s = compileOk(source);
      const stream = streamed(s, CANDLES.slice(0, 320));
      for (const k of [0, 1, 13, 14, 15, 100, 250, 319]) {
        const batch = runPine(s, CANDLES.slice(0, k + 1));
        for (const x of s.signals) expect(batch[x.key][k], `${x.key} @${k}`).toBe(stream[x.key][k]);
      }
    }
  });

  it('label.new reports its y price as the marker price on the bars where it fires', () => {
    const s = compileOk(V5_CROSS);
    const inst = s.create();
    CANDLES.forEach((c, i) => {
      inst.step(undefined, c);
      const fired = engulf(CANDLES)[i] === 1;
      if (fired) expect(inst.markerPrice('engulf')).toBe(c.low);
      else expect(inst.markerPrice('engulf')).toBeNaN();
    });
    expect(inst.markerPrice('nope')).toBeNaN();
  });
});

describe('Pine signals: conditional execution, na and false', () => {
  it('a signal inside if / else fires only on bars where that branch runs (unexecuted = false)', () => {
    const s = compileOk(`//@version=5
indicator("Branches")
if close > open
    plotshape(true, "Up branch")
else
    plotshape(true, "Down branch")
    alertcondition(close < open, "Strict down")
plot(close)
`);
    const out = runPine(s, CANDLES);
    expect(out.up_branch).toEqual(CANDLES.map((c) => (c.close > c.open ? 1 : 0)));
    expect(out.down_branch).toEqual(CANDLES.map((c) => (c.close > c.open ? 0 : 1)));
    expect(out.strict_down).toEqual(CANDLES.map((c) => (c.close < c.open ? 1 : 0)));
  });

  it('na and 0 are false; a non-zero number is true in v4/v5; location.absolute fires where the price is not na', () => {
    const s = compileOk(`//@version=5
indicator("Na")
x = bar_index % 3 == 0 ? na : bar_index % 3
plotshape(x, "Truthy")
plotshape(na, "Never")
plotshape(bar_index % 2 == 0 ? high : na, "At high", location=location.absolute)
plot(close)
`);
    const out = runPine(s, CANDLES);
    expect(out.truthy).toEqual(CANDLES.map((_, i) => (i % 3 === 0 ? 0 : 1)));
    expect(out.never.every((v) => v === 0)).toBe(true);
    expect(out.at_high).toEqual(CANDLES.map((_, i) => (i % 2 === 0 ? 1 : 0)));
    const inst = s.create();
    inst.step(undefined, CANDLES[0]);
    expect(inst.markerPrice('at_high')).toBe(CANDLES[0].high);
    expect(s.signals[2].marker?.location).toBe('price');
  });

  it('a signal in a loop ORs over iterations; two label.new with the same text are ONE signal', () => {
    const s = compileOk(`//@version=5
indicator("Merge")
for i = 0 to 2
    if bar_index == 10 + i * 5
        plotshape(true, "Loop")
if close > open
    label.new(bar_index, high, "Mark")
if bar_index == 7
    label.new(bar_index, low, "Mark")
plot(close)
`);
    expect(s.signals.map((x) => x.title)).toEqual(['Loop', 'Mark']);
    const out = runPine(s, CANDLES);
    expect(out.loop).toEqual(CANDLES.map((_, i) => ([10, 15, 20].includes(i) ? 1 : 0)));
    expect(out.mark).toEqual(CANDLES.map((c, i) => (c.close > c.open || i === 7 ? 1 : 0)));
  });

  it('RSI levels template: alerts and labels follow ta.rsi crossings of 30 / 70', () => {
    const s = compileOk(RSI_LEVELS_SOURCE);
    expect(s.overlay).toBe(false);
    expect(s.signals.map((x) => x.key)).toEqual(['rsi_left_oversold', 'rsi_left_overbought', 'buy', 'sell']);
    const rsi = new Rsi(14);
    let prev = NaN;
    const up: number[] = [];
    const down: number[] = [];
    for (const c of CANDLES) {
      const r = rsi.update(c.close);
      up.push(prev <= 30 && r > 30 ? 1 : 0);
      down.push(prev >= 70 && r < 70 ? 1 : 0);
      prev = r;
    }
    const out = runPine(s, CANDLES);
    expect(out.rsi_left_oversold).toEqual(up);
    expect(out.buy).toEqual(up);
    expect(out.rsi_left_overbought).toEqual(down);
    expect(out.sell).toEqual(down);
    expect(up.filter(Boolean).length + down.filter(Boolean).length).toBeGreaterThan(2);
  });
});

describe('Pine signals: static discovery', () => {
  it('names, shapes, locations, colours and text are read from the source', () => {
    const s = compileOk(V5_CROSS);
    expect(s.signals.map((x) => x.marker)).toEqual([
      { shape: 'arrowUp', location: 'belowBar', color: '#4CAF50', text: 'L' },
      { shape: 'circle', location: 'aboveBar', color: '#FF5252', text: '▼' },
      // alertcondition: a small marker; "Bull" reads as a buy, so it gets the buy defaults.
      { shape: 'arrowUp', location: 'belowBar', color: '#26a69a', text: 'Bull bar' },
      { shape: 'arrowUp', location: 'price', color: '#2962ff', text: 'Engulf' },
    ]);
  });

  it('defaults: titles fall back to text, then "Signal N"; buy / sell names get green-up / red-down markers', () => {
    const s = compileOk(`//@version=5
indicator("Defaults")
plotshape(close > open)
plotshape(close < open, text="Go")
plotshape(close > high[1], "Buy now")
plotshape(close < low[1], "Sell now", color=color.new(#123456, 50))
alertcondition(close > open)
plot(close)
`);
    expect(s.signals.map((x) => x.title)).toEqual(['Signal 1', 'Go', 'Buy now', 'Sell now', 'Alert 5']);
    expect(s.signals[2].marker).toEqual({ shape: 'arrowUp', location: 'belowBar', color: '#26a69a' });
    expect(s.signals[3].marker).toEqual({ shape: 'arrowDown', location: 'aboveBar', color: '#123456' });
  });

  it('duplicate titles are numbered; keys are unique across plots and signals', () => {
    const s = compileOk(`//@version=5
indicator("Dup")
plot(close, "Buy")
plotshape(close > open, "Buy")
plotshape(close > open, "buy")
alertcondition(close > open, "Buy")
`);
    expect(s.plots.map((p) => p.key)).toEqual(['buy']);
    expect(s.signals.map((x) => [x.key, x.title])).toEqual([['buy_2', 'Buy'], ['buy_2_2', 'buy (2)'], ['buy_3', 'Buy (3)']]);
  });

  it('templates with signals compile and list their signals', () => {
    expect(compileOk(EMA_CROSS_SIGNALS_SOURCE).signals.map((x) => x.title)).toEqual(['Buy', 'Sell']);
    expect(compileOk(RSI_LEVELS_SOURCE).plots.map((p) => p.title)).toEqual(['RSI']);
  });
});

const at = (line: number, col: number, message: RegExp) => ({ line, col, message: expect.stringMatching(message) });
const body = (text: string) => `//@version=5\nindicator("E")\n${text}\nplot(close)\n`;

describe('Pine signals: unsupported forms are errors with line:col', () => {
  it.each([
    ['l = label.new(bar_index, high, "x")', at(3, 5, /^label objects beyond label\.new at the current bar are not supported/)],
    ['label.new(bar_index - 1, high, "x")', at(3, 21, /^label objects beyond label\.new.*x must be bar_index/)],
    ['label.new(bar_index, high, str.tostring(close))', at(3, 28, /^label objects beyond label\.new.*text must be a string literal/)],
    ['label.set_text(na, "x")', at(3, 1, /^label objects beyond label\.new at the current bar are not supported$/)],
    ['label.delete(na)', at(3, 1, /^label objects beyond label\.new/)],
    ['var label l = na', at(3, 5, /^label objects beyond label\.new/)],
    ['f(x) =>\n    label.new(bar_index, x, "in f")\n    x', at(4, 5, /^label objects beyond label\.new.*functions/)],
    ['plotarrow(close - open)', at(3, 1, /^plotarrow\(\) is not supported/)],
    ['line.new(bar_index, low, bar_index, high)', at(3, 1, /^drawing objects \(line\.\*\)/)],
    ['box.new(bar_index, high, bar_index, low)', at(3, 1, /^drawing objects \(box\.\*\)/)],
    ['plotshape(close > open, offset=2)', at(3, 32, /offset not supported/)],
    ['x = plotshape(close > open)', at(3, 5, /plotshape\(\) must be a statement of its own/)],
    ['plotshape(close > open, title=str.tostring(1))', at(3, 31, /title must be a string literal/)],
    ['plotshape(close > open, style="x")', at(3, 31, /style must be a shape\.\* constant/)],
    ['plotshape(close > open, location=1)', at(3, 34, /location must be location\./)],
    ['plotshape(close > open, transp=50)', at(3, 25, /has no argument named "transp"/)],
  ])('%s', (src, expected) => {
    expect(compileErrors(body(src))).toContainEqual(expected);
  });

  it('v6: plotshape / plotchar / alertcondition need a bool (numbers are not converted); location.absolute takes a price', () => {
    const v6 = (text: string) => `//@version=6\nindicator("E")\n${text}\nplot(close)\n`;
    expect(compileErrors(v6('plotshape(close - open)'))[0]).toEqual(at(3, 11, /Pine v6 does not convert numbers to bool \(plotshape series\)/));
    expect(compileErrors(v6('plotchar(volume, "v")'))[0]).toEqual(at(3, 10, /plotchar series/));
    expect(compileErrors(v6('alertcondition(close, "c")'))[0]).toEqual(at(3, 16, /alertcondition condition/));
    expect(compilePine(v6('plotshape(close > open)')).ok).toBe(true);
    expect(compilePine(v6('plotshape(high, location=location.absolute)')).ok).toBe(true);
    // v5 accepts a number (non-zero = true).
    expect(compilePine(body('plotshape(close - open)')).ok).toBe(true);
  });

  it('a script with only signals (no plot) compiles; one with neither still errors', () => {
    expect(compileOk('//@version=5\nindicator("S")\nplotshape(close > open, "Up")\n').plots).toEqual([]);
    expect(compileErrors('//@version=5\nindicator("S")\nx = 1\n')[0].message).toMatch(/has no plot\(\)/);
  });
});
