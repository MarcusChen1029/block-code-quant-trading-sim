import { describe, it, expect } from 'vitest';
import { compilePine, runPine } from './compile';
import { SUPERTREND_SOURCE, SUPERTREND_V6_SOURCE } from './templates';
import { compileErrors, compileOk, fixture } from './testing';

const CANDLES = fixture(400);
/** Body lines start at line 3. */
const v6 = (body: string) => `//@version=6\nindicator("T")\n${body.replace(/^\n/, '')}`;
const v5 = (body: string) => `//@version=5\nindicator("T")\n${body.replace(/^\n/, '')}`;
const at = (line: number, col: number, message: RegExp) => ({ line, col, message: expect.stringMatching(message) });

describe('Pine v6: lazy and / or', () => {
  // ta.change(bar_index) is the number of bars since that call site last ran: it shows whether the right side ran.
  const AND = 'x = bar_index % 3 == 0 and ta.change(bar_index) == 3\nplot(x ? 1 : 0, "x")';
  const OR = 'y = bar_index % 3 != 0 or ta.change(bar_index) == 3\nplot(y ? 1 : 0, "y")';

  it('"and" skips its right operand when the left is false (v6); v5 evaluates both sides', () => {
    const lazy = runPine(compileOk(v6(AND)), CANDLES.slice(0, 12)).x;
    const strict = runPine(compileOk(v5(AND)), CANDLES.slice(0, 12)).x;
    // v6: the right side only runs on bars 0, 3, 6, 9, so from bar 3 on it sees a change of 3 bars.
    expect(lazy).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
    // v5: it runs on every bar, so the change is always 1.
    expect(strict).toEqual(new Array(12).fill(0));
  });

  it('"or" skips its right operand when the left is true (v6); v5 evaluates both sides', () => {
    expect(runPine(compileOk(v6(OR)), CANDLES.slice(0, 7)).y).toEqual([0, 1, 1, 1, 1, 1, 1]);
    expect(runPine(compileOk(v5(OR)), CANDLES.slice(0, 7)).y).toEqual([0, 1, 1, 0, 1, 1, 0]);
  });

  it('a ta.* call on the right of and/or gets the "conditional" warning in v6 only; on the left it does not', () => {
    const warned = compilePine(v6(AND));
    expect(warned.warnings).toEqual([at(3, 28, /^ta\.change is inside a conditional or loop/)]);
    expect(compilePine(v6(OR)).warnings).toEqual([at(3, 27, /^ta\.change is inside a conditional or loop/)]);
    expect(compilePine(v5(AND)).warnings).toEqual([]);
    expect(compilePine(v6('x = ta.change(bar_index) == 1 and close > open\nplot(x ? 1 : 0, "x")')).warnings).toEqual([]);
  });

  it('guard pattern: the right side may rely on the left (no evaluation when it would be invalid)', () => {
    const s = compileOk(v6('var float prev = na\nok = not na(prev) and close / prev > 1\nprev := close\nplot(ok ? 1 : 0, "ok")'));
    const out = runPine(s, CANDLES.slice(0, 5)).ok;
    expect(out).toEqual(CANDLES.slice(0, 5).map((c, i) => (i > 0 && c.close / CANDLES[i - 1].close > 1 ? 1 : 0)));
  });
});

describe('Pine v6: no implicit number -> bool cast', () => {
  it('if <number> is an error with line:col', () => {
    expect(compileErrors(v6('x = 0\nif close\n    x := 1\nplot(x, "x")'))).toEqual([
      at(4, 4, /^Pine v6 does not convert numbers to bool \(condition of "if"\): "close" is a number; compare it explicitly, e\.g\. close != 0$/),
    ]);
  });

  it('and / or / not / ?: operands that are numbers are errors (each operand reported)', () => {
    expect(compileErrors(v6('b = close and high\nplot(b ? 1 : 0, "b")'))).toEqual([
      at(3, 5, /"and" operand\): "close" is a number/), at(3, 15, /"and" operand\): "high" is a number/),
    ]);
    expect(compileErrors(v6('b = false or volume\nplot(b ? 1 : 0, "b")'))).toEqual([at(3, 14, /"or" operand\): "volume" is a number/)]);
    expect(compileErrors(v6('b = not close\nplot(b ? 1 : 0, "b")'))).toEqual([at(3, 9, /"not" operand\): "close" is a number/)]);
    expect(compileErrors(v6('plot(bar_index ? 1 : 0, "b")'))).toEqual([at(3, 6, /condition of \?:\): "bar_index" is a number/)]);
    expect(compileErrors(v6('n = input.int(3)\nk = n * 2\nplot(k + 1 ? 1 : 0, "b")'))).toEqual([at(5, 6, /condition of \?:\): this is a number; compare it explicitly, e\.g\. x != 0/)]);
    expect(compileErrors(v6('var int trend = 1\nplot(trend ? 1 : 0, "t")'))).toEqual([at(4, 6, /"trend" is a number/)]);
    expect(compileErrors(v6('s = ta.sma(close, 3)\nif s[1]\n    s := 0\nplot(s, "s")'))).toEqual([at(4, 4, /"if"\): this is a number/)]);
  });

  it('valid bool expressions never error (no false positives), including unknown types', () => {
    const s = compileOk(v6(`
len = input.int(5, "Len", minval=1, maxval=50)
useFilter = input.bool(true, "Filter")
up = close > open
var bool flag = false
flag := not flag
m = ta.sma(close, len)
cross = ta.crossover(close, m)
changed = ta.change(up)
isPos(x) => x > 0
pick(c, a, b) => c ? a : b
mixed = 0
mixed := 1
v = na(m) ? 0.0 : m
if up and useFilter or na(m)
    v := pick(cross, 1.0, 2.0)
else if not flag and isPos(close - open) and changed
    v := -1
for i = 0 to 3
    if i == 2 and (up or cross)
        break
plot(v, "v")
plot(flag ? 1 : 0, "flag")
`));
    expect(s.version).toBe(6);
    expect(runPine(s, CANDLES).flag.slice(0, 4)).toEqual([1, 0, 1, 0]);
  });

  it('v5 contrast: the same numeric conditions compile and cast (0 / na false, else true)', () => {
    const out = runPine(compileOk(v5('x = 0\nif close\n    x := 1\nb = close and high\nplot(x, "x")\nplot(b ? 1 : 0, "b")\nplot(bar_index ? 1 : 0, "bi")\nplot(not close ? 1 : 0, "n")')), CANDLES.slice(0, 3));
    expect(out).toEqual({ x: [1, 1, 1], b: [1, 1, 1], bi: [0, 1, 1], n: [0, 0, 0] });
  });
});

describe('Pine v6: bool is never na', () => {
  it('na() / nz() of a bool and bool = na are errors', () => {
    expect(compileErrors(v6('b = close > open\nplot(na(b) ? 1 : 0, "x")'))).toEqual([at(4, 6, /^Pine v6: bool values cannot be na, so na\(\) does not accept a bool$/)]);
    expect(compileErrors(v6('b = close > open\nc = nz(b)\nplot(c ? 1 : 0, "x")'))).toEqual([at(4, 5, /so nz\(\) does not accept a bool/)]);
    expect(compileErrors(v6('var bool b = na\nplot(close, "x")'))).toEqual([at(3, 14, /a bool variable cannot be na; initialise "b"/)]);
    expect(compileErrors(v6('bool b = true\nb := na\nplot(close, "x")'))).toEqual([at(4, 6, /a bool variable cannot be na; assign true or false to "b"/)]);
    // v5 accepts all of these.
    expect(compilePine(v5('b = close > open\nplot(na(b) ? 1 : 0, "x")')).ok).toBe(true);
    expect(compilePine(v5('var bool b = na\nplot(close, "x")')).ok).toBe(true);
  });

  it('history of a bool before its first bar is false in v6 (na in v5)', () => {
    const body = 'b = close > open\nplot(b[1] == false ? 1 : 0, "x")';
    expect(runPine(compileOk(v6(body)), CANDLES.slice(0, 1)).x).toEqual([1]);
    expect(runPine(compileOk(v5(body)), CANDLES.slice(0, 1)).x).toEqual([0]);
  });
});

describe('Pine v6: for loops re-evaluate their "to" bound before every iteration', () => {
  const BODY = 'lim = 3\ncount = 0\nfor i = 0 to lim\n    count += 1\n    if i == 0\n        lim := 5\nplot(count, "count")';

  it('a bound changed inside the loop is seen by v6 (6 iterations); v5 evaluated it once (4)', () => {
    expect(runPine(compileOk(v6(BODY)), CANDLES.slice(0, 2)).count).toEqual([6, 6]);
    expect(runPine(compileOk(v5(BODY)), CANDLES.slice(0, 2)).count).toEqual([4, 4]);
  });

  it('constant bounds behave exactly as in v5: inclusive, counting down, by, break, continue', () => {
    const body = `
a = 0
for i = 0 to 4
    a += i
b = 0
for i = 5 to 1 by 2
    b += i
c = 0
for i = 0 to 10
    if i == 3
        continue
    if i == 6
        break
    c += 1
plot(a, "a")
plot(b, "b")
plot(c, "c")
`;
    const out6 = runPine(compileOk(v6(body)), CANDLES.slice(0, 2));
    expect(out6).toEqual(runPine(compileOk(v5(body)), CANDLES.slice(0, 2)));
    expect(out6).toEqual({ a: [10, 10], b: [9, 9], c: [5, 5] });
  });
});

describe('Pine v6: other rules', () => {
  it('plot / hline linewidth below 1 is an error (v5 accepted it)', () => {
    expect(compileErrors(v6('plot(close, "x", linewidth=0)'))).toEqual([at(3, 28, /^Pine v6: plot\(\) linewidth must be at least 1$/)]);
    expect(compileErrors(v6('plot(close, "x", color.red, 0)'))).toEqual([at(3, 29, /plot\(\) linewidth must be at least 1/)]);
    expect(compilePine(v5('plot(close, "x", linewidth=0)')).ok).toBe(true);
  });

  it('the v6 Supertrend template compiles cleanly and equals the v5 Supertrend on every bar', () => {
    const a = compileOk(SUPERTREND_V6_SOURCE);
    const b = compileOk(SUPERTREND_SOURCE);
    expect([a.version, a.warnings]).toEqual([6, []]);
    expect(a.inputs).toEqual(b.inputs);
    expect(runPine(a, CANDLES)).toEqual(runPine(b, CANDLES));
  });
});
