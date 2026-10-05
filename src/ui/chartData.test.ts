import { describe, it, expect } from 'vitest';
import { candleToBar, candleToVolume, toChartTime } from './chartData';
import type { Candle } from '../data/types';

const up: Candle = { time: 1791172800000, open: 100, high: 110, low: 95, close: 105, volume: 12.5 };
const down: Candle = { time: 1791176400000, open: 105, high: 106, low: 90, close: 91, volume: 3 };

describe('chartData', () => {
  it('converts epoch ms to chart seconds', () => {
    expect(toChartTime(1791172800000)).toBe(1791172800);
  });

  it('maps a candle to a candlestick bar', () => {
    expect(candleToBar(up)).toEqual({ time: 1791172800, open: 100, high: 110, low: 95, close: 105 });
  });

  it('colours volume bars by candle direction', () => {
    expect(candleToVolume(up)).toEqual({ time: 1791172800, value: 12.5, color: 'rgba(38,166,154,0.5)' });
    expect(candleToVolume(down)).toEqual({ time: 1791176400, value: 3, color: 'rgba(239,83,80,0.5)' });
  });
});
