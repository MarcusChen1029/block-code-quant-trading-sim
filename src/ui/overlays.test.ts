import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { OVERLAYS, computeOverlaySeries, overlayPoint, smaOverlay } from './overlays';

const HOUR = 3_600_000;
const candles: Candle[] = [10, 20, 30, 40].map((close, i) => ({
  time: i * HOUR, open: close, high: close + 1, low: close - 1, close, volume: 1,
}));

describe('overlayPoint', () => {
  it('turns NaN into a whitespace point', () => {
    expect(overlayPoint(HOUR, NaN)).toEqual({ time: 3600 });
    expect(overlayPoint(HOUR, 5)).toEqual({ time: 3600, value: 5 });
  });
});

describe('computeOverlaySeries', () => {
  it('computes an SMA line with warm-up gaps', () => {
    const series = computeOverlaySeries(smaOverlay(2, '#fff'), candles);
    expect(series.value).toEqual([{ time: 0 }, { time: 3600, value: 15 }, { time: 7200, value: 25 }, { time: 10800, value: 35 }]);
  });

  it('produces one array per line key, one point per candle, for every built-in overlay', () => {
    for (const def of OVERLAYS) {
      const series = computeOverlaySeries(def, candles);
      expect(Object.keys(series).sort()).toEqual(def.lines.map((l) => l.key).sort());
      for (const line of def.lines) expect(series[line.key]).toHaveLength(candles.length);
    }
  });

  it('has unique overlay ids', () => {
    const ids = OVERLAYS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
