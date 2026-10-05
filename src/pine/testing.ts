import { expect } from 'vitest';
import type { Candle } from '../data/types';
import { syntheticCandles } from '../engine/syntheticCandles';
import { compilePine, runPine, type PineCompileResult, type PineScript } from './compile';
import type { PineDiagnostic } from './diagnostics';

/** 400 deterministic bars with varying volume and a flat stretch (zero high-low range for a few bars). */
export function fixture(count = 400): Candle[] {
  return syntheticCandles(count).map((c, i) => {
    const volume = 10 + 5 * Math.sin(i / 3) + (i % 7);
    if (i >= 200 && i < 206) return { ...c, open: 100, high: 100, low: 100, close: 100, volume };
    return { ...c, volume };
  });
}

/** Compiles or fails the test with the errors. */
export function compileOk(source: string): PineScript {
  const result = compilePine(source);
  if (!result.ok) throw new Error(`expected the script to compile:\n${result.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join('\n')}`);
  return result.script;
}

/** The compile errors (fails the test if it compiled). */
export function compileErrors(source: string): PineDiagnostic[] {
  const result = compilePine(source);
  if (result.ok) throw new Error('expected compile errors');
  return result.errors;
}

/** Wraps statements in a minimal indicator script (body lines start at line 3). */
export function script(body: string, title = 'Test'): string {
  return `//@version=5\nindicator("${title}")\n${body.replace(/^\n/, '')}`;
}

/** Runs the body and returns the plot arrays. */
export function plots(body: string, candles: Candle[] = fixture(), params?: Record<string, number>): Record<string, number[]> {
  return runPine(compileOk(script(body)), candles, params);
}

/** Same length, NaN at exactly the same bars, other values within `tolerance`. */
export function expectSeriesEqual(actual: readonly number[], expected: readonly number[], tolerance = 1e-9, label = ''): void {
  expect(actual.length, `${label} length`).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    if (Number.isNaN(expected[i])) {
      expect(actual[i], `${label} bar ${i} should be na`).toBeNaN();
    } else {
      expect(Number.isNaN(actual[i]), `${label} bar ${i} should not be na`).toBe(false);
      expect(Math.abs(actual[i] - expected[i]), `${label} bar ${i}: ${actual[i]} vs ${expected[i]}`).toBeLessThanOrEqual(tolerance);
    }
  }
}

export type { PineCompileResult };
