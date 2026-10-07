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

/** At most this many markers per signal are drawn (the most recent ones). */
export const MAX_MARKERS_PER_SIGNAL = 1000;
/** A signal with more markers than this is drawn as shapes only (no text), so long ranges stay readable. */
export const MAX_TEXT_MARKERS = 150;
/** Signal markers are a bit smaller than trade markers, so the two are easy to tell apart. */
const SIGNAL_SIZE = 0.8;

export interface SignalHit {
  time: number;
  /** Marker price for 'price' locations (NaN = fall back to above the bar). */
  price: number;
}

export interface SignalMarkerStyle {
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  location: 'aboveBar' | 'belowBar' | 'price';
  color?: string;
  text?: string;
}

const DEFAULT_SIGNAL_COLOR = '#2962ff';
export const SIGNAL_TEXT_PREFIX = '◇ ';

/** Lightweight-charts markers for one signal's hits (capped to the most recent; text dropped when dense). */
export function signalMarkers(style: SignalMarkerStyle, hits: readonly SignalHit[], idPrefix: string): SeriesMarker<UTCTimestamp>[] {
  const shown = hits.length > MAX_MARKERS_PER_SIGNAL ? hits.slice(hits.length - MAX_MARKERS_PER_SIGNAL) : hits;
  const withText = hits.length <= MAX_TEXT_MARKERS && style.text !== undefined && style.text !== '';
  const color = style.color ?? DEFAULT_SIGNAL_COLOR;
  // "◇" marks a signal, so a script's own "Buy" never reads as a trade fill ("Buy" without it).
  const text = `${SIGNAL_TEXT_PREFIX}${style.text}`;
  return shown.map((h) => {
    const base = { time: toChartTime(h.time), shape: style.shape, color, size: SIGNAL_SIZE, id: `${idPrefix}@${h.time}`, ...(withText ? { text } : {}) };
    if (style.location === 'price' && Number.isFinite(h.price)) {
      const position = style.shape === 'arrowUp' ? 'atPriceBottom' : style.shape === 'arrowDown' ? 'atPriceTop' : 'atPriceMiddle';
      return { ...base, position, price: h.price } as SeriesMarker<UTCTimestamp>;
    }
    const position = style.location === 'belowBar' ? 'belowBar' : 'aboveBar';
    return { ...base, position } as SeriesMarker<UTCTimestamp>;
  });
}

/** Merges marker lists sorted by time (the library requires ascending times; equal times keep list order). */
export function mergeMarkers(...lists: ReadonlyArray<readonly SeriesMarker<UTCTimestamp>[]>): SeriesMarker<UTCTimestamp>[] {
  return lists.flat().map((m, i) => [m, i] as const).sort((a, b) => a[0].time - b[0].time || a[1] - b[1]).map(([m]) => m);
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
