import { describe, expect, it } from 'vitest';
import { compilePine } from './compile';

/**
 * Valid Pine v6 scripts (our subset) that must compile with NO errors: the v6 type checks (numbers as conditions,
 * bool never na) may only fire on a definite type, never on these. Each body starts after the header.
 */
const CORPUS: Array<[string, string]> = [
  ['counter compared explicitly', 'var x = 0\nx := x + 1\nif x > 10\n    x := 0\nplot(x, "x")'],
  ['bool flag toggled', 'var bool on = false\nif ta.crossover(close, ta.sma(close, 5))\n    on := not on\nplot(on ? 1 : 0, "on")'],
  ['user function returning bool', 'isUp() => close > open\nplot(isUp() ? 1 : 0, "u")'],
  ['user function with a bool parameter', 'pick(c, a, b) => c ? a : b\nplot(pick(close > open, 1, 2), "p")'],
  ['function result compared', 'body() => close - open\nplot(body() > 0 ? 1 : 0, "b")'],
  ['explicit bool() cast', 'x = 0\nif bool(close - open)\n    x := 1\nplot(x, "x")'],
  ['nz on a number', 'prev = close[1]\nplot(nz(prev) > 0 ? 1 : 0, "p")'],
  ['na on a float', 'var float last = na\nif close > open\n    last := close\nplot(na(last) ? 0 : last, "l")'],
  ['and / or of comparisons', 'up = close > open\nbig = high - low > 1\nplot(up and big or not up ? 1 : 0, "c")'],
  ['for loop with a bool accumulator', 'all = true\nfor i = 0 to 4\n    if close[i] < open[i]\n        all := false\nplot(all ? 1 : 0, "a")'],
  ['for loop counting', 'n = 0\nfor i = 1 to 5\n    if close[i] > close\n        n += 1\nplot(n, "n")'],
  ['ternary chain', 'r = ta.rsi(close, 14)\nzone = r > 70 ? 1 : r < 30 ? -1 : 0\nplot(zone, "z")'],
  ['bool input as condition', 'useIt = input.bool(true, "Use")\nplot(useIt ? close : open, "v")'],
  ['int input in arithmetic, compared', 'len = input.int(10, "Len", minval=1)\nhalf = len / 2\nplot(half > 3 ? 1 : 0, "h")'],
  ['plotshape with a bool series', 'plotshape(ta.crossover(close, ta.ema(close, 9)), "Buy", shape.triangleup, location.belowbar)'],
  ['plotshape absolute price', 'plotshape(close > open ? low : na, "Low", shape.circle, location.absolute)'],
  ['alertcondition with a bool', 'alertcondition(close > ta.sma(close, 20), "Above", "above")'],
  ['label.new in an if', 'if ta.crossunder(close, ta.sma(close, 10))\n    label.new(bar_index, high, "Sell")\nplot(close, "c")'],
  ['bool history', 'up = close > open\nplot(up and up[1] ? 1 : 0, "two")'],
  ['bool declared explicitly', 'bool trend = close > ta.sma(close, 50)\nplot(trend ? 1 : -1, "t")'],
  ['bool assigned na later (stores false)', 'var bool seen = true\nif close < open\n    seen := na\nplot(seen ? 1 : 0, "s")'],
  ['mixed int / float variable', 'v = 0\nif close > open\n    v := 1.5\nplot(v, "v")'],
  ['int() of a division', 'q = int(bar_index / 3)\nplot(q % 2 == 0 ? 1 : 0, "even")'],
  ['float() conversion', 'f = float(bar_index)\nplot(f / 2, "f")'],
  ['math functions compared', 'plot(math.abs(close - open) > math.max(1, 2) ? 1 : 0, "m")'],
  ['nested functions', 'diff(a, b) => a - b\npositive(a, b) => diff(a, b) > 0\nplot(positive(close, open) ? 1 : 0, "p")'],
  ['multi-line function returning bool', 'a = ta.atr(14)\nstrong(atr) =>\n    r = high - low\n    r > atr\nplot(strong(a) ? 1 : 0, "s")'],
  ['tuple from macd', '[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(h > 0 ? 1 : 0, "h")'],
  ['var counter reset on a condition', 'var count = 0\ncount += 1\nif close > open\n    count := 0\nplot(count >= 3 ? 1 : 0, "c")'],
  ['change of a bool', 'up = close > open\nflip = ta.change(up)\nplot(flip ? 1 : 0, "f")'],
  ['lazy guard', 'var float prev = na\nok = not na(prev) and close / prev > 1\nprev := close\nplot(ok ? 1 : 0, "ok")'],
  ['else-if chain with numbers compared', 'x = close - open\ns = 0\nif x > 0\n    s := 1\nelse if x < 0\n    s := -1\nplot(s, "s")'],
  ['function returning a counter compared', 'var c = 0\nc := c + 1\nage() => c\nplot(age() > 5 ? 1 : 0, "a")'],
  ['bool from a parameterised function', 'above(src, ref) => src > ref\nm = ta.sma(close, 20)\nplot(above(close, m) ? 1 : 0, "x")'],
  ['highest / lowest compared', 'plot(close >= ta.highest(high, 20) ? 1 : 0, "hh")'],
];

describe(`Pine v6 corpus: ${CORPUS.length} valid scripts compile without errors`, () => {
  it('has at least 30 scripts', () => expect(CORPUS.length).toBeGreaterThanOrEqual(30));
  for (const [name, body] of CORPUS) {
    it(name, () => {
      const result = compilePine(`//@version=6\nindicator("Corpus")\n${body}`);
      expect(result.ok ? [] : result.errors.map((e) => `${e.line}:${e.col} ${e.message}`)).toEqual([]);
    });
  }
});
