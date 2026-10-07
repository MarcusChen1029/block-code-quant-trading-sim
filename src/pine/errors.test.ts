import { describe, it, expect } from 'vitest';
import { compilePine } from './compile';
import { compileErrors, script } from './testing';

/** First error of a script whose body starts on line 3 (see script()). */
function firstError(body: string) {
  return compileErrors(script(body))[0];
}

const at = (line: number, col: number, message: RegExp | string) =>
  ({ line, col, message: typeof message === 'string' ? message : expect.stringMatching(message) });

describe('unsupported features are compile errors with line:col', () => {
  it('strategy()', () => {
    expect(compileErrors('//@version=5\nstrategy("S")\nplot(close)\n')[0]).toEqual(
      at(2, 1, 'strategy() scripts and strategy.* are not supported in v1 (write an indicator() and trade it with blocks)'));
  });

  it('strategy.* calls inside an indicator', () => {
    expect(firstError('strategy.entry("L", strategy.long)\nplot(close)')).toEqual(at(3, 1, /^strategy\(\) scripts and strategy\.\*/));
  });

  it('request.security', () => {
    expect(firstError('x = request.security("BTCUSDT", "1D", close)\nplot(x)')).toEqual(at(3, 5, 'request.* (other symbols / timeframes) is not supported in v1'));
  });

  it('indicator(timeframe=...)', () => {
    expect(compileErrors('//@version=5\nindicator("x", timeframe="D")\nplot(close)\n')[0]).toEqual(at(2, 26, /multi-timeframe/));
  });

  it('arrays: array.* calls and array types', () => {
    expect(firstError('a = array.new_float(10)\nplot(close)')).toEqual(at(3, 5, 'arrays (array.*) are not supported in v1'));
    expect(firstError('float[] a = na\nplot(close)')).toEqual(at(3, 1, 'arrays are not supported in v1'));
    expect(firstError('array<float> a = na\nplot(close)')).toEqual(at(3, 1, 'arrays are not supported in v1'));
  });

  it('maps and matrices', () => {
    expect(firstError('m = map.new<string, float>()\nplot(close)')).toEqual(at(3, 5, 'maps are not supported in v1'));
    expect(firstError('m = matrix.new<float>(2, 2)\nplot(close)')).toEqual(at(3, 5, 'matrices are not supported in v1'));
    expect(firstError('x = map.size(m)\nplot(close)')).toEqual(at(3, 5, 'maps (map.*) are not supported in v1'));
    expect(firstError('x = matrix.rows(m)\nplot(close)')).toEqual(at(3, 5, 'matrices (matrix.*) are not supported in v1'));
  });

  it('drawing objects: line / label / box / table', () => {
    for (const ns of ['line', 'box', 'table']) {
      expect(firstError(`${ns}.new(bar_index, close)\nplot(close)`), ns).toEqual(at(3, 1, `drawing objects (${ns}.*) are not supported in v1`));
    }
    // label.new is a signal now (src/pine/signals.ts): without a text literal it cannot name one.
    expect(firstError('label.new(bar_index, close)\nplot(close)')).toEqual(at(3, 1, /^label\.new needs a text string literal/));
    expect(firstError('label l = na\nplot(close)')).toEqual(at(3, 1, /^label objects beyond label\.new at the current bar are not supported/));
  });

  it('alert and alertcondition', () => {
    expect(firstError('alert("hi")\nplot(close)')).toEqual(at(3, 1, 'alerts (alert) are not supported in v1'));
    // alertcondition() is a signal output now.
    expect(compilePine(script('alertcondition(close > open, "up")\nplot(close)')).ok).toBe(true);
  });

  it('import / export / library', () => {
    expect(firstError('import user/lib/1 as lib\nplot(close)')).toEqual(at(3, 1, '"import" (libraries) is not supported in v1'));
    expect(firstError('export f(x) => x\nplot(close)')).toEqual(at(3, 1, '"export" (libraries) is not supported in v1'));
    expect(compileErrors('//@version=5\nlibrary("L")\n')[0]).toEqual(at(2, 1, 'libraries are not supported in v1'));
  });

  it('type and method', () => {
    expect(firstError('type Point\n    float x\nplot(close)')).toEqual(at(3, 1, 'user-defined types ("type") are not supported in v1'));
    expect(firstError('method twice(float x) => x * 2\nplot(close)')).toEqual(at(3, 1, '"method" declarations are not supported in v1'));
  });

  it('while, switch, for … in', () => {
    expect(firstError('i = 0\nwhile i < 3\n    i += 1\nplot(close)')).toEqual(at(4, 1, '"while" loops are not supported in v1 (use a for loop)'));
    expect(firstError('x = 0\nswitch\n    close > open => x := 1\nplot(close)')).toEqual(at(4, 1, '"switch" is not supported in v1 (use if / else if)'));
    expect(firstError('s = 0.0\nfor v in xs\n    s += v\nplot(s)')).toEqual(at(4, 1, '"for … in" loops are not supported in v1 (use for i = a to b)'));
    expect(firstError('s = 0.0\nfor [i, v] in xs\n    s += v\nplot(s)')).toEqual(at(4, 1, '"for … in" loops are not supported in v1 (use for i = a to b)'));
  });

  it('unknown functions and namespaces', () => {
    expect(firstError('x = foo(1)\nplot(x)')).toEqual(at(3, 5, 'unknown function "foo"'));
    expect(firstError('x = ta.vwma(close, 3)\nplot(x)')).toEqual(at(3, 5, /^unknown function ta\.vwma\(\)/));
    expect(firstError('x = math.sum(close, 3)\nplot(x)')).toEqual(at(3, 5, 'unknown function math.sum()'));
    expect(firstError('x = foo.bar(1)\nplot(x)')).toEqual(at(3, 5, 'unknown namespace "foo"'));
    expect(firstError('x = str.tostring(close)\nplot(close)')).toEqual(at(3, 5, 'str.* is not supported in v1'));
    expect(firstError('plot(y)')).toEqual(at(3, 6, '"y" is not declared'));
  });

  it('assignment to an undeclared name, to inputs, to loop variables, and redeclaration', () => {
    expect(firstError('y := 1\nplot(close)')).toEqual(at(3, 1, 'cannot assign to undeclared variable "y" (declare it first with y = ...)'));
    expect(firstError('n = input.int(3)\nn := 4\nplot(close)')).toEqual(at(4, 1, '"n" is an input and cannot be changed'));
    expect(firstError('for i = 0 to 3\n    i := 2\nplot(close)')).toEqual(at(4, 5, 'loop variable "i" cannot be changed'));
    expect(firstError('x = 1\nx = 2\nplot(close)')).toEqual(at(4, 1, '"x" is already declared in this scope (use := to change it)'));
    expect(firstError('close = 1\nplot(close)')).toEqual(at(3, 1, '"close" is a built-in name; choose another name'));
    expect(firstError('g = 0\nf(x) =>\n    g := x\n    x\nplot(close)')).toEqual(at(5, 5, 'user functions cannot change the global variable "g" (Pine rule)'));
  });

  it('ta.* inside a user function is an error', () => {
    expect(firstError('f(x) => ta.sma(x, 3)\nplot(f(close))')).toEqual(at(3, 9, 'ta.* inside user functions is not supported in v1 (call it at the top level and pass the result in)'));
  });

  it('ta.* lengths must be constants; history offsets must be bounded', () => {
    expect(firstError('n = bar_index + 1\nplot(ta.sma(close, n))')).toEqual(at(4, 20, 'ta.sma length must be a constant: a number, an input, or arithmetic on them'));
    expect(firstError('n = input.int(3)\nplot(close[n])')).toEqual(at(4, 12, /history offset needs a known maximum/));
    expect(firstError('plot(close[bar_index])')).toEqual(at(3, 12, /history offset needs a known maximum/));
    expect(firstError('plot(close[-1])')).toEqual(at(3, 12, 'history offset must be a whole number ≥ 0'));
    expect(firstError('plot(close[6000])')).toEqual(at(3, 12, 'history offset can be at most 5000'));
    expect(firstError('plot((close + open)[1])')).toEqual(at(3, 20, /history \[\] works on variables and built-in series only/));
    expect(firstError('plot(ta.sma(close, 0))')).toEqual(at(3, 6, /ta\.sma length must be a whole number from 1 to 5000, got 0/));
  });

  it('misplaced indicator / input / plot, missing header and plots, other versions', () => {
    expect(firstError('if close > open\n    plot(close)\nplot(open)')).toEqual(at(4, 5, /plot\(\) must be at the top level/));
    expect(firstError('x = ta.sma(close, input.int(3))\nplot(x)')).toEqual(at(3, 19, /input\.int\(\) must be assigned to a variable at the top level/));
    expect(compileErrors('//@version=5\nplot(close)\n')[0]).toEqual(at(1, 1, 'the script must declare indicator("Title", overlay=true|false)'));
    expect(compileErrors('//@version=5\nindicator("x")\nx = 1\n')[0]).toEqual(at(1, 1, /has no plot\(\)/));
    // v4 and v6 are supported since 2026-10-07 (versions.test.ts); older and newer versions are still errors.
    expect(compileErrors('//@version=3\nstudy("x")\nplot(close)\n')[0]).toEqual(at(1, 1, /^Pine v3 is too old/));
  });

  it('syntax errors report the first problem with its position', () => {
    expect(firstError('x = (close + \nplot(x)')).toEqual(at(3, 5, '"(" is never closed'));
    expect(firstError('x = close +* 2\nplot(x)')).toEqual(at(3, 12, 'expected a value, found "*"'));
    expect(firstError('x = "unterminated\nplot(x)')).toEqual(at(3, 5, /unterminated string/));
    expect(firstError('if close > open\nx = 1\nplot(close)')).toEqual(at(4, 1, 'the body of "if" must be indented by 4 spaces'));
    expect(firstError('x = 1\n  y = 2\nplot(x)')).toEqual(at(4, 3, /expected end of line/));
    expect(firstError('x = 1 @ 2\nplot(x)')).toEqual(at(3, 7, 'unexpected character "@"'));
    expect(firstError('x = (1 + 2\nplot(x)')).toEqual(at(3, 5, /"\(" is never closed|expected/));
  });

  it('missing-argument errors are plain { line, col, message } objects (no AST nodes), in every version', () => {
    const cases = [
      script('plot(na())'), script('plot(nz())'), script('x = math.pow(2)\nplot(x)'), script('x = color.new()\nplot(close)'),
      script('plot()'), script('x = input.int()\nplot(close)'), '//@version=5\nindicator()\nplot(close)\n',
      '//@version=6\nindicator("x")\nplot(na())\n', '//@version=4\nstudy("x")\nplot(iff(true))\n', '//@version=4\nstudy("x")\nplot(title="y")\n',
    ];
    for (const source of cases) {
      const errors = compileErrors(source);
      expect(errors.length, source).toBeGreaterThan(0);
      for (const e of errors) expect(Object.keys(e).sort(), source).toEqual(['col', 'line', 'message']);
    }
  });

  it('compilePine never throws, even on deeply nested input', () => {
    const deep = `//@version=5\nindicator("x")\nplot(${'('.repeat(5000)}1${')'.repeat(5000)})\n`;
    const result = compilePine(deep);
    expect(result.ok).toBe(false);
  });
});
