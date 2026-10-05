/**
 * A Pine-style series function, updated exactly once per CLOSED bar (O(1) per update).
 * NaN plays the role of Pine's `na`: returned during warm-up. A NaN input returns NaN
 * for that bar and does NOT advance the indicator's state.
 */
export interface SeriesIndicator {
  update(value: number): number;
}

/** The bar fields indicators like ATR and Stochastic need (a Candle satisfies it). */
export interface Hlc {
  high: number;
  low: number;
  close: number;
}

export function assertLength(length: number): void {
  if (!Number.isInteger(length) || length < 1) throw new Error(`length must be a positive integer, got ${length}`);
}
