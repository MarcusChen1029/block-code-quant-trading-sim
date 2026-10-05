import { describe, it, expect } from 'vitest';
import { compilePine, runPine } from './compile';
import { FORBIDDEN_IDENTIFIERS, forbiddenReferences } from './safety';
import { PINE_TEMPLATES } from './templates';
import { compileErrors, compileOk, fixture, script } from './testing';

const CANDLES = fixture(30);
const DANGEROUS_NAMES = ['constructor', '__proto__', 'process', 'fetch', 'self', 'globalThis', 'eval', 'prototype', 'window', 'Function', 'toString', 'hasOwnProperty'];

describe('Pine safety: generated code cannot reach the page, the worker or the network', () => {
  it('dangerous identifiers used as variable names are inert (mangled) and compute normally', () => {
    const body = DANGEROUS_NAMES.map((n, i) => `${n} = close * ${i + 1}`).join('\n') + `\nplot(${DANGEROUS_NAMES.join(' + ')}, "sum")\n`;
    const s = compileOk(script(body));
    expect(runPine(s, CANDLES).sum).toEqual(CANDLES.map((c) => DANGEROUS_NAMES.reduce((sum, _, i) => sum + c.close * (i + 1), 0)));
    expect(forbiddenReferences(s.js)).toEqual([]);
    for (const n of DANGEROUS_NAMES) expect(s.js).not.toMatch(new RegExp(`(^|[^\\w$])${n.replace(/\$/g, '\\$')}([^\\w$]|$)`, 'm'));
  });

  it('dangerous names as function names, parameters, inputs and loop variables are inert too', () => {
    const s = compileOk(script(`
constructor = input.int(3, "c", minval=1, maxval=10)
__proto__(fetch) => fetch * 2
s = 0
for eval = 1 to constructor
    s += __proto__(eval)
plot(s, "s")
`));
    expect(s.inputs[0].name).toBe('constructor_v');
    expect(runPine(s, CANDLES.slice(0, 1)).s).toEqual([12]);
    expect(runPine(s, CANDLES.slice(0, 1), { constructor_v: 4 }).s).toEqual([20]);
    expect(forbiddenReferences(s.js)).toEqual([]);
  });

  it('calling fetch / eval / Function / constructor and reaching members are compile errors', () => {
    const err = (body: string) => compileErrors(script(`${body}\nplot(close)`))[0].message;
    expect(err('x = fetch("https://example.com")')).toBe('unknown function "fetch"');
    expect(err('x = eval("1")')).toBe('unknown function "eval"');
    expect(err('x = Function("return 1")')).toBe('unknown function "Function"');
    expect(err('x = constructor(1)')).toBe('unknown function "constructor"');
    expect(err('x = self.x')).toBe('unknown namespace "self"');
    expect(err('x = globalThis.fetch("u")')).toBe('unknown namespace "globalThis"');
    expect(err('x = window.location')).toBe('unknown namespace "window"');
    expect(err('y = 1\nx = y.constructor')).toBe('member access (y.constructor) is not supported in v1');
    expect(err('x = close.constructor')).toBe('member access (close.constructor) is not supported in v1');
    expect(err('x = ta.constructor(1)')).toMatch(/^unknown function ta\.constructor\(\)/);
    expect(err('x = math.__proto__')).toBe('unknown value math.__proto__');
    expect(err('x = color.constructor')).toBe('unknown value color.constructor');
    expect(err('x = ta.sma.constructor')).toBe('unknown value ta.sma.constructor');
    expect(err('x = (close).toString()')).toBe('member access (close.toString) is not supported in v1');
    expect(err('x = "a".length')).toBe('member access is not supported in v1');
  });

  it('strings with quotes, backticks, ${} and U+2028/U+2029 round-trip exactly and stay data', () => {
    const BT = '`';
    const LS = String.fromCharCode(0x2028);
    const PS = String.fromCharCode(0x2029);
    const BS = '\\';
    const DQ = '"';
    const DOLLAR = '$';
    // Pine source text of the literal, and the value it must decode to.
    const literal = `a${BS}${DQ}b'c${BT}d${DOLLAR}{globalThis.fetch(${BS}${DQ}x${BS}${DQ})}${LS}e${PS}f${BS}${BS}`;
    const decoded = `a${DQ}b'c${BT}d${DOLLAR}{globalThis.fetch(${DQ}x${DQ})}${LS}e${PS}f${BS}`;
    const single = `${BT}${DOLLAR}{1+1}${BS}'q`;
    const source = [
      '//@version=5',
      `indicator("T ${BS}${DQ}${LS}${BT}${DOLLAR}{x}")`,
      `s = "${literal}"`,
      `t = '${single}'`,
      `plot(s == "${literal}" ? 1 : 0, "same ${DOLLAR}{x} ${BT}")`,
      'plot(s == "other" ? 1 : 0, "different")',
      `plot(t == '${single}' ? 1 : 0, "single")`,
    ].join('\n');
    const s = compileOk(source);
    expect(s.title).toBe(`T ${DQ}${LS}${BT}${DOLLAR}{x}`);
    expect(s.plots.map((p) => p.title)).toEqual([`same ${DOLLAR}{x} ${BT}`, 'different', 'single']);
    expect(runPine(s, CANDLES.slice(0, 2))).toEqual({ same_x: [1, 1], different: [0, 0], single: [1, 1] });
    expect(s.js).toContain(JSON.stringify(decoded).replace(LS, `${BS}u2028`).replace(PS, `${BS}u2029`));
    expect(forbiddenReferences(s.js)).toEqual([]);
    expect(s.js.includes(LS) || s.js.includes(PS)).toBe(false);
  });

  it('a backtick outside a string is a syntax error', () => {
    expect(compileErrors(script('x = `1`\nplot(x)'))[0]).toEqual({ line: 3, col: 5, message: 'unexpected character backtick' });
  });

  it('generated code of every template and test script references no forbidden global', () => {
    for (const t of PINE_TEMPLATES) {
      const result = compilePine(t.source);
      if (!result.ok) throw new Error(t.id);
      expect(forbiddenReferences(result.script.js), t.id).toEqual([]);
      // Every identifier token is a fixed runtime name, a keyword, or a mangled user name.
      const tokens = result.script.js.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/[A-Za-z_$][\w$]*/g) ?? [];
      for (const tok of tokens) {
        expect(/^(?:[ufzTHabs]\d+(?:_\w+)?|rt|P|NaN|true|false|const|let|if|else|for|return|function|step|use|strict|update|push|bar|open|high|low|close|volume|time|out|num|px|bi|hist|history|na|nz|and|or|color|loop|forStep|src|barIndex|m_\w+|sma|ema|rma|wma|rsi|stdev|change|highest|lowest|atr|macd|bb|stoch|crossover|crossunder|tr|break|continue|undefined)$/.test(tok), `${t.id}: unexpected token ${tok}`).toBe(true);
      }
    }
  });

  it('the scanner itself flags forbidden identifiers outside strings only', () => {
    expect(forbiddenReferences('rt.x(fetch)')).toEqual(['fetch']);
    expect(forbiddenReferences('a.constructor')).toEqual(['constructor']);
    expect(forbiddenReferences('x = "fetch constructor"')).toEqual([]);
    expect(forbiddenReferences('u1_constructor = 1')).toEqual([]);
    expect(FORBIDDEN_IDENTIFIERS.has('globalThis')).toBe(true);
  });
});
