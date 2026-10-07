import { describe, it, expect } from 'vitest';
import { compilePine, runPine } from './compile';
import { V4_INPUT_TYPES, V4_MATH_FUNCTIONS, V4_TA_FUNCTIONS, V4_UNSUPPORTED, v4SpellingHint } from './dialect';
import { forbiddenReferences } from './safety';
import { RSI_MA_V4_SOURCE, SUPERTREND_V6_SOURCE } from './templates';
import { compileErrors, compileOk, fixture } from './testing';

const CANDLES = fixture(30);
const v4 = (body: string, title = 'T') => `//@version=4\nstudy("${title}")\n${body}`;
const v6 = (body: string, title = 'T') => `//@version=6\nindicator("${title}")\n${body}`;
const DANGEROUS = ['constructor', '__proto__', 'process', 'fetch', 'self', 'globalThis', 'eval', 'prototype', 'window', 'Function',
  'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', '__defineGetter__', 'propertyIsEnumerable'];
/** Every name Object.prototype answers to: a plain-object table would "find" these. */
const PROTO_KEYS = Object.getOwnPropertyNames(Object.prototype);

/** Every identifier token in generated code is a runtime name, a JS keyword or a mangled user name. */
const ALLOWED_TOKEN = /^(?:[ufzTHabsk]\d+(?:_\w+)?|rt|P|NaN|true|false|const|let|if|else|for|return|function|step|use|strict|update|push|bar|open|high|low|close|volume|time|out|num|px|bi|hist|history|na|nz|and|or|iff|color|loop|forStep|src|barIndex|m_\w+|sma|ema|rma|wma|rsi|stdev|change|highest|lowest|atr|macd|bb|stoch|crossover|crossunder|tr|break|continue|undefined)$/;

function expectInertJs(js: string, label: string): void {
  expect(forbiddenReferences(js), label).toEqual([]);
  const tokens = js.replace(/"(?:[^"\\]|\\.)*"/g, '""').match(/[A-Za-z_$][\w$]*/g) ?? [];
  for (const tok of tokens) expect(ALLOWED_TOKEN.test(tok), `${label}: unexpected token ${tok}`).toBe(true);
}

describe('Pine v4 / v6 safety', () => {
  it('the name tables are prototype-less: no Object.prototype key resolves as a v4 name or hint', () => {
    for (const key of PROTO_KEYS) {
      expect(V4_TA_FUNCTIONS.has(key) || V4_MATH_FUNCTIONS.has(key) || V4_UNSUPPORTED.has(key) || V4_INPUT_TYPES.has(key), key).toBe(false);
      expect(v4SpellingHint(key, true), key).toBeUndefined();
      expect(v4SpellingHint(key, false), key).toBeUndefined();
      expect(v4SpellingHint(`input.${key}`, false), key).toBeUndefined();
    }
  });

  for (const [label, wrap] of [['v4', v4], ['v6', v6]] as const) {
    it(`${label}: dangerous names as variables, functions and parameters are inert and compute normally`, () => {
      const body = DANGEROUS.map((n, i) => `${n} = close * ${i + 1}`).join('\n') + `\nplot(${DANGEROUS.join(' + ')}, "sum")\n`;
      const s = compileOk(wrap(body));
      expect(runPine(s, CANDLES).sum).toEqual(CANDLES.map((c) => DANGEROUS.reduce((sum, _, i) => sum + c.close * (i + 1), 0)));
      expect(forbiddenReferences(s.js)).toEqual([]);
      const fn = compileOk(wrap('__proto__(fetch) => fetch * 2\nhasOwnProperty(eval) => eval + 1\nplot(__proto__(close) + hasOwnProperty(1), "x")'));
      expect(runPine(fn, CANDLES.slice(0, 1)).x).toEqual([CANDLES[0].close * 2 + 2]);
      expect(forbiddenReferences(fn.js)).toEqual([]);
    });

    it(`${label}: calling dangerous bare names (the v4 bare-name path) is "unknown function"`, () => {
      for (const n of DANGEROUS) {
        expect(compileErrors(wrap(`x = ${n}(1)\nplot(close)`))[0], n).toEqual({ line: 3, col: 5, message: `unknown function "${n}"` });
      }
    });
  }

  it('v4: input type=input.<Object.prototype key> is rejected, never resolved', () => {
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(compileErrors(v4(`n = input(1, type=input.${key})\nplot(close)`))[0], key).toEqual({ line: 3, col: 19, message: 'input type must be input.integer, input.float, input.bool or input.source' });
    }
  });

  it('v4 and v6: titles and strings with quotes, backticks, ${} and U+2028 round-trip and stay data', () => {
    const BT = '`';
    const LS = String.fromCharCode(0x2028);
    const nasty = `q\\"t'${BT}\${globalThis.fetch(\\"x\\")}${LS}e`;
    const decoded = `q"t'${BT}\${globalThis.fetch("x")}${LS}e`;
    const s4 = compileOk(`//@version=4\nstudy("${nasty}")\nlen = input(3, title="${nasty}", type=input.integer)\nplot(sma(close, len), title="${nasty}")\n`);
    expect(s4.title).toBe(decoded);
    expect(s4.inputs[0].title).toBe(decoded);
    expect(s4.plots[0].title).toBe(decoded);
    const s6 = compileOk(`//@version=6\nindicator("${nasty}")\ns = "${nasty}"\nplot(s == "${nasty}" and close > 0 ? 1 : 0, "${nasty}")\n`);
    expect(s6.title).toBe(decoded);
    expect(runPine(s6, CANDLES.slice(0, 2))[s6.plots[0].key]).toEqual([1, 1]);
    for (const s of [s4, s6]) {
      expect(forbiddenReferences(s.js)).toEqual([]);
      expect(s.js.includes(LS)).toBe(false);
    }
    expect(compileErrors(v6('x = `1`\nplot(x)'))[0]).toEqual({ line: 3, col: 5, message: 'unexpected character backtick' });
  });

  it('generated JS of the shipped v4/v6 templates and of version-specific constructs has no forbidden tokens', () => {
    const scripts: Record<string, string> = {
      'rsi-ma-v4': RSI_MA_V4_SOURCE,
      'supertrend-v6': SUPERTREND_V6_SOURCE,
      'kitchen-v4': v4('len = input(5, "Len", type=input.integer, minval=1, maxval=20)\nx = iff(close > open, sma(close, len), ema(close, len))\nvar float acc = 0.0\nacc := acc + max(abs(change(close)), 0)\ns = 0.0\nfor i = 0 to len\n    s += close[i]\nplot(x + acc + s + tr, "k")'),
      'kitchen-v6': v6('len = input.int(5, "Len", minval=1, maxval=20)\nup = close > open\nok = up and ta.sma(close, len) > 0 or not up\nlim = len\nc = 0\nfor i = 0 to lim\n    c += 1\nplot(ok ? c : 0, "k")\nplot(up[1] ? 1 : 0, "h")'),
    };
    for (const [label, source] of Object.entries(scripts)) {
      const result = compilePine(source);
      if (!result.ok) throw new Error(`${label}: ${result.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('; ')}`);
      expectInertJs(result.script.js, label);
    }
  });
});
