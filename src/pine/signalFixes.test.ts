import { describe, it, expect } from 'vitest';
import { compilePine } from './compile';

/** Regression tests for review findings on Pine signals (one describe per finding). */

const HEADERS = { 4: '//@version=4\nstudy("E")', 5: '//@version=5\nindicator("E")', 6: '//@version=6\nindicator("E")' } as const;
const src = (v: 4 | 5 | 6, body: string) => `${HEADERS[v]}\n${body}\nplot(close)\n`;
const errorsOf = (s: string) => {
  const r = compilePine(s);
  return r.ok ? [] : r.errors;
};

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
