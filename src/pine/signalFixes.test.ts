import { describe, it, expect } from 'vitest';
import { compilePine } from './compile';

/** Regression tests for review findings on Pine signals (one describe per finding). */

const HEADERS = { 4: '//@version=4\nstudy("E")', 5: '//@version=5\nindicator("E")', 6: '//@version=6\nindicator("E")' } as const;
const src = (v: 4 | 5 | 6, body: string) => `${HEADERS[v]}\n${body}\nplot(close)\n`;
const errorsOf = (s: string) => {
  const r = compilePine(s);
  return r.ok ? [] : r.errors;
};

describe('finding 4: hidden signals (display.none, show_last=0, fully transparent) are signals without a marker', () => {
  const signalsOf = (s: string) => {
    const r = compilePine(s);
    if (!r.ok) throw new Error(r.errors[0].message);
    return r.script;
  };

  it('v5/v6: display=display.none, show_last=0, color.new(c, 100), color.rgb(..., 100) and #RRGGBB00 hide the marker', () => {
    for (const v of [5, 6] as const) {
      const s = signalsOf(src(v, [
        'plotshape(close > open, "A", display=display.none)',
        'plotshape(close > open, "B", show_last=0)',
        'plotshape(close > open, "C", color=color.new(color.red, 100))',
        'plotchar(close > open, "D", color=color.rgb(1, 2, 3, 100))',
        'plotshape(close > open, "E", color=#FF000000)',
        'plotshape(close > open, "F", color=color.new(color.red, 50), display=display.all)',
      ].join('\n')));
      expect(s.signals.map((x) => [x.title, x.marker === undefined])).toEqual([
        ['A', true], ['B', true], ['C', true], ['D', true], ['E', true], ['F', false],
      ]);
    }
  });

  it('v4: transp=100 (named or positional) hides the marker; transp=50 does not; the signal still fires', () => {
    const s = signalsOf(src(4, [
      'plotshape(close > open, "A", transp=100)',
      'plotshape(close > open, "B", shape.circle, location.abovebar, color.green, 100)',
      'plotshape(close > open, "C", transp=50)',
    ].join('\n')));
    expect(s.signals.map((x) => [x.title, x.marker === undefined])).toEqual([['A', true], ['B', true], ['C', false]]);
    const inst = s.create();
    const bar = { time: 0, open: 1, high: 3, low: 0, close: 2, volume: 1 };
    expect(inst.step(undefined, bar).a).toBe(1);
  });
});

describe('finding 2: output / signal keys are stable', () => {
  const keys = (body: string) => {
    const r = compilePine(`//@version=5\nindicator("K")\n${body}\n`);
    if (!r.ok) throw new Error(r.errors[0].message);
    return { plots: r.script.plots.map((p) => p.key), signals: r.script.signals.map((s) => s.key) };
  };

  it('appending a plot with the same title after a signal does not change the signal key', () => {
    const before = keys('plotshape(close > open, "Buy")');
    const after = keys('plotshape(close > open, "Buy")\nplot(close, "Buy")');
    expect(before.signals).toEqual(['buy']);
    expect(after.signals).toEqual(['buy']);
    expect(after.plots).toEqual(['buy_2']);
  });

  it('appending a duplicate signal later in the file does not change earlier keys', () => {
    const before = keys('plot(close, "Close")\nplotshape(close > open, "Buy")\nplotshape(close < open, "Sell")');
    const after = keys('plot(close, "Close")\nplotshape(close > open, "Buy")\nplotshape(close < open, "Sell")\nplotshape(high > high[1], "Buy")\nplot(open, "Close")');
    expect(after.signals.slice(0, 2)).toEqual(before.signals);
    expect(after.plots[0]).toBe(before.plots[0]);
    expect(after.signals[2]).toBe('buy_2');
  });
});

describe('finding 3: string / colour series are compile errors (they could never fire)', () => {
  for (const v of [4, 5, 6] as const) {
    it(`v${v}: string and colour literals, colour constants and string variables are rejected with line:col`, () => {
      expect(errorsOf(src(v, 'plotshape("abc", "t")'))).toContainEqual({ line: 3, col: 11, message: 'plotshape series must be a bool or a number, not a string' });
      expect(errorsOf(src(v, 'plotshape(color.red, "t")'))).toContainEqual({ line: 3, col: 11, message: 'plotshape series must be a bool or a number, not a color' });
      expect(errorsOf(src(v, 'plotchar(#ff0000, "t")'))).toContainEqual({ line: 3, col: 10, message: 'plotchar series must be a bool or a number, not a color' });
      expect(errorsOf(src(v, 'alertcondition("x", "t")'))).toContainEqual({ line: 3, col: 16, message: 'alertcondition condition must be a bool or a number, not a string' });
      expect(errorsOf(src(v, 's = "up"\nplotshape(s, "t")'))).toContainEqual({ line: 4, col: 11, message: 'plotshape series must be a bool or a number, not a string' });
      expect(errorsOf(src(v, 'label.new(bar_index, "high", "t")'))).toContainEqual({ line: 3, col: 22, message: 'label.new y must be a bool or a number, not a string' });
    });

    it(`v${v}: bool, numeric and unknown-typed series produce no false errors`, () => {
      const numericOk = v === 6 ? [] : ['plotshape(close - open, "n")', 'plotshape(volume, "v")'];
      for (const body of ['plotshape(close > open, "b")', 'f(x) => x\nplotshape(f(close > open), "u")', 'plotshape(na, "na")', ...numericOk]) {
        expect(compilePine(src(v, body)).ok, body).toBe(true);
      }
    });
  }
});
