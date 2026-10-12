import { describe, expect, it } from 'vitest';
import { Sma } from '../indicators/averages';
import { compilePine, runPine } from './compile';
import { compileErrors, compileOk, expectSeriesEqual, fixture } from './testing';

/**
 * Regression tests for the Pine semantics gaps closed on 2026-10-08 (conversions, int / int, division by zero,
 * v6 type checks of variables and user functions, v4 input() overloads). Sources: 2026-10-07-pine-versions.md.
 */
const CANDLES = fixture(60);
type V = 4 | 5 | 6;
const src = (v: V, body: string) => `//@version=${v}\n${v === 4 ? 'study' : 'indicator'}("T")\n${body.replace(/^\n/, '')}`;
/** First-bar value of every plot. */
const first = (v: V, body: string): Record<string, number> => {
  const out = runPine(compileOk(src(v, body)), CANDLES.slice(0, 1));
  return Object.fromEntries(Object.entries(out).map(([k, xs]) => [k, xs[0]]));
};
const at = (line: number, col: number, message: RegExp) => ({ line, col, message: expect.stringMatching(message) });

describe('int() / float() / bool() conversions', () => {
  for (const v of [4, 5, 6] as const) {
    it(`v${v}: int() truncates toward zero and keeps na; float() keeps the value and na`, () => {
      expect(first(v, 'plot(int(2.7), "a")\nplot(int(-2.7), "b")\nplot(int(na), "c")\nplot(float(3), "d")\nplot(float(na), "e")\nplot(int(close) <= close and int(close) > close - 1 ? 1 : 0, "f")'))
        .toEqual({ a: 2, b: -2, c: NaN, d: 3, e: NaN, f: 1 });
    });
  }

  it('v6 bool(): false for na, false and 0; true for any other number', () => {
    expect(first(6, 'plot(bool(na) ? 1 : 0, "a")\nplot(bool(0) ? 1 : 0, "b")\nplot(bool(2.5) ? 1 : 0, "c")\nplot(bool(-1) ? 1 : 0, "d")\nplot(bool(false) ? 1 : 0, "e")'))
      .toEqual({ a: 0, b: 0, c: 1, d: 1, e: 0 });
  });

  for (const v of [4, 5] as const) {
    it(`v${v} bool(): bool(na) stays na (a bool can be na before v6); 0 false, other numbers true`, () => {
      expect(first(v, 'plot(na(bool(na)) ? 1 : 0, "a")\nplot(bool(0) ? 1 : 0, "b")\nplot(bool(3) ? 1 : 0, "c")\nplot(bool(na) ? 1 : 0, "d")'))
        .toEqual({ a: 1, b: 0, c: 1, d: 0 });
    });
  }

  it('v6: bool(x) is the documented fix for a numeric condition; int(x) as a condition is still a number', () => {
    expect(compilePine(src(6, 'x = 0\nif bool(close - open)\n    x := 1\nplot(x, "x")')).ok).toBe(true);
    expect(compileErrors(src(6, 'plot(int(close) ? 1 : 0, "x")'))).toEqual([at(3, 6, /condition of \?:\): this is a number/)]);
  });

  it('a constant conversion is a valid ta.* length', () => {
    const out = runPine(compileOk(src(5, 'len = int(14.9)\nplot(ta.sma(close, len), "s")')), CANDLES);
    const sma = new Sma(14);
    expectSeriesEqual(out.s, CANDLES.map((c) => sma.update(c.close)));
  });

  it('conversions take exactly one argument', () => {
    expect(compileErrors(src(6, 'plot(int(), "x")'))).toEqual([at(3, 6, /int\(\) needs the "x" argument/)]);
  });
});

describe('int / int division per version', () => {
  it('v4: like v5, integer division only for const / const (series / input int division unverified -> fractional)', () => {
    expect(first(4, 'a = 5\nb = 2\nplot(a / b, "c")\nplot(-7 / 2, "n")\nplot(7 / 2.0, "f")\nplot(5.0 / 2, "g")\nn = input(9, "N", type=input.integer)\nplot(n / 2, "i")'))
      .toEqual({ c: 2, n: -3, f: 3.5, g: 2.5, i: 4.5 });
    // bar_index is a series int: fractional, as on master.
    expect(runPine(compileOk(src(4, 'plot(bar_index / 2, "h")\nplot(10 / bar_index, "k")')), CANDLES.slice(0, 4)))
      .toEqual({ h: [0, 0.5, 1, 1.5], k: [Infinity, 10, 5, 10 / 3].map((x) => (x === Infinity ? NaN : x)) });
  });

  it('v5: integer division only when BOTH operands are const ints [M6]', () => {
    expect(first(5, 'a = 5\nplot(5 / 2, "c")\nplot(a / 2, "d")\nplot(1.0 / 2, "f")\nn = input.int(5)\nplot(n / 2, "i")\nvar v = 5\nplot(v / 2, "w")'))
      .toEqual({ c: 2, d: 2, f: 0.5, i: 2.5, w: 2.5 });
    expect(runPine(compileOk(src(5, 'plot(bar_index / 2, "h")')), CANDLES.slice(0, 4)).h).toEqual([0, 0.5, 1, 1.5]);
  });

  it('v6: int / int always keeps the fraction; int() gives the integer quotient [M6]', () => {
    expect(first(6, 'a = 5\nplot(5 / 2, "c")\nplot(a / 2, "d")\nplot(int(5 / 2), "t")')).toEqual({ c: 2.5, d: 2.5, t: 2 });
  });

  it('compound /= follows the same rule (fractional in every version: a reassigned name is not const)', () => {
    const body = 'x = 7\nx /= 2\nplot(x, "x")';
    expect([first(4, body).x, first(5, body).x, first(6, body).x]).toEqual([3.5, 3.5, 3.5]);
  });

  it('unknown operand types divide fractionally (function parameters)', () => {
    expect(first(4, 'half(v) => v / 2\nplot(half(5), "h")').h).toBe(2.5);
  });
});

describe('division and modulo by zero are na (not Infinity)', () => {
  for (const v of [4, 5, 6] as const) {
    it(`v${v}`, () => {
      expect(first(v, 'z = close - close\nplot(1 / 0, "a")\nplot(close / z, "b")\nplot(0 / 0, "c")\nplot(close % z, "d")\nplot(5 % 0, "e")\nplot(5 % 3, "f")\nplot(-1 % 9, "g")\nplot(close / 0.0, "h")'))
        .toEqual({ a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: 2, g: -1, h: NaN });
    });
  }

  it('compound /= and %= by zero are na', () => {
    expect(first(6, 'x = 3.0\nx /= 0\ny = 3\ny %= 0\nplot(x, "x")\nplot(y, "y")')).toEqual({ x: NaN, y: NaN });
  });
});

describe('v6: numeric variables and user-function results used as conditions are caught', () => {
  it('a var counter (x := x + 1) used as an if condition', () => {
    expect(compileErrors(src(6, 'var x = 0\nx := x + 1\nif x\n    x := 0\nplot(x, "x")'))).toEqual([at(5, 4, /condition of "if"\): "x" is a number/)]);
  });

  it('compound assignment keeps the type (y += 1)', () => {
    expect(compileErrors(src(6, 'var y = 0\ny += 1\nplot(y ? 1 : 0, "y")'))).toEqual([at(5, 6, /condition of \?:\): "y" is a number/)]);
  });

  it('a user function returning a number', () => {
    expect(compileErrors(src(6, 'f() => close\nx = 0\nif f()\n    x := 1\nplot(x, "x")'))).toEqual([at(5, 4, /condition of "if"\): this is a number/)]);
    expect(compileErrors(src(6, 'g() =>\n    b = close * 2\n    b + 1\nplot(g() and true ? 1 : 0, "x")'))).toEqual([at(6, 6, /"and" operand\): this is a number/)]);
  });

  it('mutually dependent variables', () => {
    expect(compileErrors(src(6, 'var a = 0.0\nvar b = 0.0\na := b + 1\nb := a * 2\nplot(a or b ? 1 : 0, "x")'))).toEqual([
      at(7, 6, /"or" operand\): "a" is a number/), at(7, 11, /"or" operand\): "b" is a number/),
    ]);
  });

  it('unknown stays silent: parameters passed through, bool-returning functions, mixed types', () => {
    expect(compilePine(src(6, 'id(v) => v\npos(v) => v > 0\nx = 0\nif id(close > open) and pos(close)\n    x := 1\nplot(x, "x")')).ok).toBe(true);
  });

  it('v5 still casts these numbers to bool', () => {
    expect(compilePine(src(5, 'var x = 0\nx := x + 1\nf() => close\nif x and f()\n    x := 0\nplot(x, "x")')).ok).toBe(true);
  });
});

describe('v4 input() overloads per type [R4]', () => {
  it('bool: input(defval, title, type, confirm, ...): the 4th positional is confirm', () => {
    const s = compileOk(src(4, 'b = input(true, "B", input.bool, true)\nc = input(false, "C", input.bool, false, "tip", "row", "grp")\nplot(b ? 1 : c ? 2 : 0, "x")'));
    expect(s.inputs.map((i) => [i.varName, i.kind, i.default])).toEqual([['b', 'bool', 1], ['c', 'bool', 0]]);
  });

  it('integer / float keep (defval, title, type, minval, maxval, ...)', () => {
    const s = compileOk(src(4, 'n = input(5, "N", input.integer, 1, 10)\nf = input(0.5, "F", input.float, 0.1, 2.0)\nplot(n * f, "x")'));
    expect(s.inputs.map((i) => [i.varName, i.min, i.max])).toEqual([['n', 1, 10], ['f', 0.1, 2]]);
  });

  it('source: input(defval, title, type, inline, group, tooltip)', () => {
    expect(compileOk(src(4, 's = input(close, "S", input.source, "row", "grp", "tip")\nplot(s, "x")')).sources).toEqual([{ varName: 's', title: 'S', default: 'close' }]);
  });

  it('a bool input still rejects minval and too many positionals', () => {
    expect(compileErrors(src(4, 'b = input(true, "B", input.bool, minval=1)\nplot(close)'))).toEqual([at(3, 41, /input\(type=input\.bool\) does not take "minval"/)]);
    expect(compileErrors(src(4, 'b = input(true, "B", input.bool, true, "t", "i", "g", 1)\nplot(close)'))).toEqual([at(3, 55, /too many arguments for input\(\) \(it takes 7\)/)]);
  });
});

describe('v4 iff(): 0, na and ±infinity are false [R4]', () => {
  it('an infinite condition takes the else branch', () => {
    expect(first(4, 'inf = 1e308 * 10\nplot(iff(inf, 1, 2), "a")\nplot(iff(-inf, 1, 2), "b")\nplot(iff(na, 1, 2), "c")\nplot(iff(0.5, 1, 2), "d")'))
      .toEqual({ a: 2, b: 2, c: 2, d: 1 });
  });
});
