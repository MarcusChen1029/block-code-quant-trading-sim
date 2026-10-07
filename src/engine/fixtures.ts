import type { Candle } from '../data/types';

const HOUR = 3_600_000;

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). Same seed -> same sequence, on every platform. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Test fixture: a random walk with drift (hourly bars). `drift` and `vol` are per-bar fractions. Opens equal the
 * previous close; highs/lows add a small random wick. Deterministic for a given seed.
 */
export function walkCandles(count: number, seed = 1, drift = 0, vol = 0.01, startPrice = 100, startMs = 0): Candle[] {
  const rnd = seededRandom(seed);
  const out: Candle[] = [];
  let prev = startPrice;
  for (let i = 0; i < count; i++) {
    const close = prev * (1 + drift + vol * (rnd() * 2 - 1));
    const open = prev;
    const wick = prev * vol * 0.5;
    out.push({
      time: startMs + i * HOUR,
      open,
      high: Math.max(open, close) + wick * rnd(),
      low: Math.min(open, close) - wick * rnd(),
      close,
      volume: 10 + 5 * rnd(),
    });
    prev = close;
  }
  return out;
}

/** Candles from a list of closes (open = previous close, wicks of `wick` around the body). Hourly bars. */
export function candlesFromCloses(closes: readonly number[], wick = 0.2, startMs = 0): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { time: startMs + i * HOUR, open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 10 };
  });
}
