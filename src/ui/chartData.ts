import type { CandlestickData, HistogramData, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../data/types';

export const UP_COLOR = '#26a69a';
export const DOWN_COLOR = '#ef5350';

/** lightweight-charts wants UTC seconds; our Candle.time is epoch ms. */
export function toChartTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

export function candleToBar(c: Candle): CandlestickData<UTCTimestamp> {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
}

export function candleToVolume(c: Candle): HistogramData<UTCTimestamp> {
  return {
    time: toChartTime(c.time),
    value: c.volume,
    color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
  };
}
