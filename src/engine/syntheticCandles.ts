import type { Candle } from '../data/types';

/** Deterministic oscillating price series for tests (no randomness). Hourly bars from `startMs`. */
export function syntheticCandles(count: number, startMs = 0, stepMs = 3_600_000): Candle[] {
  const out: Candle[] = [];
  let prevClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + 10 * Math.sin(i / 8) + 3 * Math.sin(i / 2.3);
    const open = prevClose;
    out.push({
      time: startMs + i * stepMs,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 10,
    });
    prevClose = close;
  }
  return out;
}
