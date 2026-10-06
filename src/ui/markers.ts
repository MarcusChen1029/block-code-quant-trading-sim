import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { Fill, FillReason } from '../engine/types';
import { DOWN_COLOR, UP_COLOR, toChartTime } from './chartData';

const LABEL: Record<FillReason, string> = {
  market: '',
  limit: 'L',
  stop: 'S',
  stopLoss: 'SL',
  takeProfit: 'TP',
  wiped: 'WIPED',
};

/** Live sessions: where trading starts (warm-up bars are to its left). */
export function sessionStartMarker(timeMs: number): SeriesMarker<UTCTimestamp> {
  return { time: toChartTime(timeMs), position: 'aboveBar', shape: 'square', color: '#2962ff', text: 'Session start' };
}

/** One chart marker per fill: buys below the bar (green up arrow), sells above (red down arrow). */
export function fillsToMarkers(fills: readonly Fill[]): SeriesMarker<UTCTimestamp>[] {
  return fills.map((f) => {
    const tag = LABEL[f.reason];
    const text = f.side === 'buy' ? `Buy${tag ? ' ' + tag : ''}` : `Sell${tag ? ' ' + tag : ''}`;
    return f.side === 'buy'
      ? { time: toChartTime(f.time), position: 'belowBar', shape: 'arrowUp', color: UP_COLOR, text }
      : { time: toChartTime(f.time), position: 'aboveBar', shape: 'arrowDown', color: DOWN_COLOR, text };
  });
}
