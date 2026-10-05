import { expect } from 'vitest';
import type { SeriesIndicator } from './types';

/** Test helper: feeds values one bar at a time and collects the outputs. */
export function runSeries(indicator: SeriesIndicator, values: number[]): number[] {
  return values.map((v) => indicator.update(v));
}

/** Test helper: element-wise toBeCloseTo, where NaN in `expected` means "must be NaN (na)". */
export function expectSeries(actual: number[], expected: number[], digits = 6): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => {
    if (Number.isNaN(expected[i])) expect(a, `index ${i}`).toBeNaN();
    else expect(a, `index ${i}`).toBeCloseTo(expected[i], digits);
  });
}
