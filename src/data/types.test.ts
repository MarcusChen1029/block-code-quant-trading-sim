import { describe, it, expect } from 'vitest';
import { TIMEFRAMES, isTimeframe, timeframeToMs } from './types';

describe('timeframeToMs', () => {
  it('converts minute, hour and day timeframes', () => {
    expect(timeframeToMs('1m')).toBe(60_000);
    expect(timeframeToMs('15m')).toBe(900_000);
    expect(timeframeToMs('1h')).toBe(3_600_000);
    expect(timeframeToMs('4h')).toBe(14_400_000);
    expect(timeframeToMs('1d')).toBe(86_400_000);
  });

  it('has a duration for every listed timeframe', () => {
    for (const tf of TIMEFRAMES) expect(timeframeToMs(tf)).toBeGreaterThan(0);
  });
});

describe('isTimeframe', () => {
  it('accepts listed timeframes and rejects others', () => {
    expect(isTimeframe('1h')).toBe(true);
    expect(isTimeframe('7m')).toBe(false);
    expect(isTimeframe('1M')).toBe(false);
  });
});
