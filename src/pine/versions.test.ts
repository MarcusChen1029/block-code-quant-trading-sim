import { describe, it, expect } from 'vitest';
import { compilePine } from './compile';
import { compileErrors, compileOk } from './testing';

const at = (line: number, col: number, message: RegExp | string) =>
  ({ line, col, message: typeof message === 'string' ? message : expect.stringMatching(message) });
/** Body lines start at line 3. */
const v4 = (body: string) => `//@version=4\nstudy("T")\n${body}`;
const vN = (n: 5 | 6, body: string) => `//@version=${n}\nindicator("T")\n${body}`;
const first4 = (body: string) => compileErrors(v4(body))[0];

describe('version line', () => {
  it('4, 5 and 6 compile, each reported on the script', () => {
    expect(compileOk('//@version=4\nstudy("x")\nplot(close)\n').version).toBe(4);
    expect(compileOk('//@version=5\nindicator("x")\nplot(close)\n').version).toBe(5);
    expect(compileOk('//@version=6\nindicator("x")\nplot(close)\n').version).toBe(6);
    expect(compileOk('// header comment\n//   @version = 6\nindicator("x")\nplot(close)\n').version).toBe(6);
  });

  it('a missing version line keeps the old rule: a warning, compiled as v5', () => {
    const result = compilePine('indicator("x")\nplot(close)\n');
    expect(result.ok && result.script.version).toBe(5);
    expect(result.warnings).toEqual([at(1, 1, 'no //@version=5 line: compiled as Pine v5')]);
  });

  it('"N.0"-style lines (accepted before v4/v6 support) still compile as version N, with a warning', () => {
    for (const [line, n, body] of [['5.0', 5, 'indicator("x")'], ['4.0', 4, 'study("x")'], ['6.0', 6, 'indicator("x")'], ['5.5', 5, 'indicator("x")']] as const) {
      const result = compilePine(`//@version=${line}\n${body}\nplot(close)\n`);
      expect(result.ok && result.script.version, line).toBe(n);
      expect(result.warnings, line).toEqual([at(1, 1, `"//@version=${line}" is not a plain version number: compiled as Pine v${n} (write //@version=${n})`)]);
    }
    expect(compileErrors('//@version=3.0\nstudy("x")\nplot(close)\n')).toEqual([at(1, 1, /^Pine v3 is too old/)]);
  });

  it('versions below 4 or above 6, and malformed lines, are errors on that line', () => {
    expect(compileErrors('//@version=3\nstudy("x")\nplot(close)\n')).toEqual([at(1, 1, 'Pine v3 is too old (found //@version=3): only versions 4, 5 and 6 are supported')]);
    expect(compileErrors('//@version=1\nplot(close)\n')).toEqual([at(1, 1, /^Pine v1 is too old/)]);
    expect(compileErrors('//@version=7\nindicator("x")\nplot(close)\n')).toEqual([at(1, 1, 'Pine v7 is not supported yet (found //@version=7): only versions 4, 5 and 6 are supported')]);
    expect(compileErrors('//@version=abc\nindicator("x")\nplot(close)\n')).toEqual([at(1, 1, 'malformed version line "//@version=abc": write //@version=4, //@version=5 or //@version=6')]);
    expect(compileErrors('//@version=\nindicator("x")\nplot(close)\n')).toEqual([at(1, 1, /^malformed version line/)]);
    expect(compileErrors('// my script\n//@version=9\nindicator("x")\nplot(close)\n')).toEqual([at(2, 1, /^Pine v9 is not supported yet/)]);
  });
});

describe('v5-only spellings in a v4 script', () => {
  it('indicator(), ta.*, math.*, input.int() etc. are friendly errors with line:col', () => {
    expect(compileErrors('//@version=4\nindicator("x")\nplot(close)\n')[0]).toEqual(at(2, 1, 'indicator() is not available in Pine v4: use study("Title", overlay=true|false)'));
    expect(first4('x = ta.sma(close, 3)\nplot(x)')).toEqual(at(3, 5, 'ta.sma() is not available in Pine v4 (no ta.* namespace): use sma()'));
    expect(first4('x = math.max(open, close)\nplot(x)')).toEqual(at(3, 5, 'math.max() is not available in Pine v4 (no math.* namespace): use max()'));
    expect(first4('plot(ta.tr)')).toEqual(at(3, 6, 'ta.tr is not available in Pine v4 (no ta.* namespace): use tr'));
    expect(first4('n = input.int(3)\nplot(close)')).toEqual(at(3, 5, 'input.int() is not available in Pine v4: use input(defval, title, type=input.integer)'));
    expect(first4('b = input.bool(true)\nplot(close)')).toEqual(at(3, 5, 'input.bool() is not available in Pine v4: use input(defval, title, type=input.bool)'));
    expect(first4('x = input.integer\nplot(close)')).toEqual(at(3, 5, 'input.integer is only valid as the type of an input: x = input(10, "Title", type=input.integer)'));
  });

  it('v4 header messages name study()', () => {
    expect(compileErrors('//@version=4\nplot(close)\n')[0]).toEqual(at(1, 1, 'the script must declare study("Title", overlay=true|false)'));
    expect(compileErrors('//@version=4\nstudy(42)\nplot(close)\n')[0]).toEqual(at(2, 7, 'study() title must be a non-empty string literal'));
    expect(compileErrors('//@version=4\nstudy()\nplot(close)\n')[0]).toEqual(at(2, 1, 'study() needs the "title" argument (title)'));
  });
});

describe('v4 spellings in a v5 or v6 script', () => {
  for (const n of [5, 6] as const) {
    it(`v${n}: study(), bare sma()/max(), tr, iff(), security(), input.integer are friendly errors with line:col`, () => {
      const first = (body: string) => compileErrors(vN(n, body))[0];
      expect(compileErrors(`//@version=${n}\nstudy("x")\nplot(close)\n`)[0]).toEqual(at(2, 1, 'study() is Pine v4 syntax: in Pine v5+ use indicator()'));
      expect(first('x = sma(close, 3)\nplot(x)')).toEqual(at(3, 5, 'sma() is Pine v4 syntax: in Pine v5+ use ta.sma()'));
      expect(first('x = rsi(close, 14)\nplot(x)')).toEqual(at(3, 5, 'rsi() is Pine v4 syntax: in Pine v5+ use ta.rsi()'));
      expect(first('x = max(open, close)\nplot(x)')).toEqual(at(3, 5, 'max() is Pine v4 syntax: in Pine v5+ use math.max()'));
      expect(first('plot(tr)')).toEqual(at(3, 6, '"tr" is Pine v4 syntax: in Pine v5+ use ta.tr'));
      expect(first('x = iff(close > open, 1, 0)\nplot(x)')).toEqual(at(3, 5, 'iff() was removed in Pine v5: use the ternary operator, cond ? a : b'));
      expect(first('x = security("BTCUSDT", "D", close)\nplot(x)')).toEqual(at(3, 5, /^security\(\) is Pine v4 syntax \(request\.security in v5\+\)/));
      expect(first('n = input(14, type=input.integer)\nplot(close)')).toEqual(at(3, 15, 'input() has no argument named "type"'));
      expect(first('x = input.integer\nplot(close)')).toEqual(at(3, 5, 'input.integer is Pine v4 syntax (input type=...): in Pine v5+ use input.int()'));
    });
  }

  it('a script that defines its own sma / tr keeps working in v5 (hints only replace "unknown" errors)', () => {
    expect(compilePine(vN(5, 'sma(x, n) => x * n\ntr = 1\nplot(sma(close, 2) + tr)')).ok).toBe(true);
    expect(compileErrors(vN(5, 'x = foo(1)\nplot(x)'))[0]).toEqual(at(3, 5, 'unknown function "foo"'));
  });
});

describe('unsupported v4 features are explicit errors with line:col', () => {
  it('security / heikinashi / renko / tickerid / financial', () => {
    expect(first4('x = security("BTCUSDT", "D", close)\nplot(x)')).toEqual(at(3, 5, 'security() (other symbols / timeframes) is not supported in v1'));
    expect(first4('t = heikinashi(syminfo.tickerid)\nplot(close)')).toEqual(at(3, 5, 'heikinashi() (other chart types / tickers) is not supported in v1'));
    expect(first4('t = renko("X", "ATR", 10)\nplot(close)')).toEqual(at(3, 5, /^renko\(\) \(other chart types/));
    expect(first4('t = tickerid("BINANCE", "BTCUSDT")\nplot(close)')).toEqual(at(3, 5, /^tickerid\(\)/));
    expect(first4('x = financial("X", "Y", "FQ")\nplot(close)')).toEqual(at(3, 5, 'financial() (external data) is not supported in v1'));
  });

  it('study(resolution=...), strategy(), non-numeric input types, string inputs, unknown study/plot/input arguments', () => {
    expect(compileErrors('//@version=4\nstudy("x", resolution="D")\nplot(close)\n')[0]).toEqual(at(2, 23, 'study(resolution=...) (multi-timeframe) is not supported in v1'));
    expect(compileErrors('//@version=4\nstrategy("S")\nplot(close)\n')[0]).toEqual(at(2, 1, /^strategy\(\) scripts and strategy\.\* are not supported in v1/));
    expect(first4('s = input("BTC", type=input.symbol)\nplot(close)')).toEqual(at(3, 23, 'input(type=input.symbol) is not supported in v1 (use input.integer, input.float, input.bool or input.source)'));
    expect(first4('s = input("x", type=foo)\nplot(close)')).toEqual(at(3, 21, 'input type must be input.integer, input.float, input.bool or input.source'));
    expect(first4('s = input("abc")\nplot(close)')).toEqual(at(3, 11, /^input\(\) default must be a number, true\/false or a price source/));
    expect(first4('b = input(true, "B", minval=1)\nplot(close)')).toEqual(at(3, 29, 'input(type=input.bool) does not take "minval"'));
    expect(first4('n = input(3, "N", foo=1)\nplot(close)')).toEqual(at(3, 19, 'input() has no argument named "foo"'));
    expect(compileErrors('//@version=4\nstudy("x", foo=1)\nplot(close)\n')[0]).toEqual(at(2, 12, 'study() has no argument named "foo"'));
    expect(first4('plot(close, offset=2)')).toEqual(at(3, 20, /^plot\(offset=\.\.\.\) is not supported in v1/));
    expect(first4('x = 0\nswitch\n    close > open => x := 1\nplot(close)')).toEqual(at(4, 1, '"switch" is not supported in v1 (use if / else if)'));
  });

  it('a missing required argument in v4 plot() / study() / input() is reported once', () => {
    const once = (source: string, line: number, col: number, message: string) => {
      const errors = compileErrors(source);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ line, col, message });
    };
    once(v4('plot(title="y")'), 3, 1, 'plot() needs the "series" argument (series)');
    once('//@version=4\nstudy(overlay=true)\nplot(close)\n', 2, 1, 'study() needs the "title" argument (title)');
    once(v4('n = input(title="N")\nplot(close)'), 3, 5, 'input() needs the "defval" argument (defval)');
  });

  it('a misplaced v4 input() names input(), and v4 inputs stay constant', () => {
    expect(first4('x = sma(close, input(3))\nplot(x)')).toEqual(at(3, 16, /^input\(\) must be assigned to a variable at the top level/));
    expect(first4('n = input(3, type=input.integer)\nn := 4\nplot(close)')).toEqual(at(4, 1, '"n" is an input and cannot be changed'));
  });
});
