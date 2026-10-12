import type { LineData, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { SignalMarker, ZoneEvent, ZoneStyle } from '../blocks/registry';
import type { Candle } from '../data/types';
import { Ema, Sma } from '../indicators/averages';
import { BollingerBands } from '../indicators/bands';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Atr } from '../indicators/volatility';
import { Vwap } from '../indicators/vwap';
import { toChartTime } from './chartData';

export interface OverlayLine {
  key: string;
  color: string;
  /** Legend name when it is not the key (Pine plots: the plot title, e.g. "Up trend"). Plain text. */
  title?: string;
}

/** A signal drawn as chart markers: the stepper returns 1 under `key` on bars where it fires. */
export interface OverlaySignal {
  key: string;
  /** Legend name, e.g. "Supertrend 10 3: Buy (trend flips up)". */
  label: string;
  marker: SignalMarker;
}

/** The line's name in the chart legend (drawn as text on the canvas, never as HTML). */
export function lineTitle(def: Pick<OverlayDef, 'label'>, line: OverlayLine): string {
  if (line.title !== undefined) return line.title;
  return line.key === 'value' ? def.label : line.key;
}

/** A chart overlay: which pane it lives in, its lines, and an incremental stepper factory. */
export interface OverlayDef {
  id: string;
  label: string;
  pane: 'price' | 'sub';
  lines: OverlayLine[];
  /** Registry id of the indicator it draws (block / Pine overlays), so signal markers can be deduplicated. */
  indicatorId?: string;
  /** Signals to mark on the chart (on the price series, or on this overlay's own pane when it has one). */
  signals?: OverlaySignal[];
  /** Zone indicators: how its zones are drawn (the stepper then has `zones()`). */
  zones?: ZoneStyle;
  /** Identity of the zone indicator + settings: two overlays with the same key draw their zones once. */
  zoneKey?: string;
  /**
   * Identity of the indicator instance behind its signals (indicator + settings, incl. signal-only ones): a signal
   * with the same instance key and signal key is marked once (dedupeOverlaySignals). Default: the overlay id.
   */
  signalKey?: string;
  /**
   * Returns a fresh stepper. Call it once per CLOSED candle; it returns one value per line key (NaN = na), 1/0 per
   * signal key, and for price-located signals the marker price under `signalPriceKey(key)`.
   */
  create(): OverlayStepper;
}

/** A stepper; zone overlays also report the zone lifecycle events of the candle just stepped. */
export type OverlayStepper = ((candle: Candle) => Record<string, number>) & { zones?: () => readonly ZoneEvent[] };

/** Where a stepper reports a signal's marker price (not an identifier, so it never collides with an output key). */
export const signalPriceKey = (key: string) => `price:${key}`;

export type OverlayPoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

export function smaOverlay(length: number, color: string, id = `sma${length}`): OverlayDef {
  return {
    id, label: `SMA ${length}`, pane: 'price', lines: [{ key: 'value', color }],
    create() { const sma = new Sma(length); return (c) => ({ value: sma.update(c.close) }); },
  };
}

export function emaOverlay(length: number, color: string, id = `ema${length}`): OverlayDef {
  return {
    id, label: `EMA ${length}`, pane: 'price', lines: [{ key: 'value', color }],
    create() { const ema = new Ema(length); return (c) => ({ value: ema.update(c.close) }); },
  };
}

/** Overlays offered in the picker. */
export const OVERLAYS: readonly OverlayDef[] = [
  smaOverlay(20, '#f5c542'),
  emaOverlay(50, '#42a5f5'),
  {
    id: 'bb20', label: 'BB 20 2', pane: 'price',
    lines: [{ key: 'upper', color: '#7e57c2' }, { key: 'middle', color: '#b39ddb' }, { key: 'lower', color: '#7e57c2' }],
    create() { const bb = new BollingerBands(20, 2); return (c) => ({ ...bb.update(c.close) }); },
  },
  {
    id: 'vwap', label: 'VWAP', pane: 'price', lines: [{ key: 'value', color: '#ff9800' }],
    create() { const vwap = new Vwap(); return (c) => ({ value: vwap.update(c) }); },
  },
  {
    id: 'rsi14', label: 'RSI 14', pane: 'sub', lines: [{ key: 'value', color: '#ab47bc' }],
    create() { const rsi = new Rsi(14); return (c) => ({ value: rsi.update(c.close) }); },
  },
  {
    id: 'macd', label: 'MACD 12 26 9', pane: 'sub',
    lines: [{ key: 'macd', color: '#2962ff' }, { key: 'signal', color: '#ff6d00' }, { key: 'hist', color: '#26a69a' }],
    create() { const macd = new Macd(12, 26, 9); return (c) => ({ ...macd.update(c.close) }); },
  },
  {
    id: 'atr14', label: 'ATR 14', pane: 'sub', lines: [{ key: 'value', color: '#ef5350' }],
    create() { const atr = new Atr(14); return (c) => ({ value: atr.update(c) }); },
  },
  {
    id: 'stoch', label: 'Stoch 14 1 3', pane: 'sub',
    lines: [{ key: 'k', color: '#2962ff' }, { key: 'd', color: '#ff6d00' }],
    create() { const st = new Stochastic(14, 1, 3); return (c) => ({ ...st.update(c) }); },
  },
];

/** NaN becomes a whitespace point so the line has a gap instead of a bogus value. */
export function overlayPoint(timeMs: number, value: number): OverlayPoint {
  const time = toChartTime(timeMs);
  return Number.isFinite(value) ? { time, value } : { time };
}

/**
 * Runs `step` (default: a fresh stepper) over all candles; returns one point array per line key.
 * Pass your own stepper to keep feeding it live candles afterwards.
 */
export function computeOverlaySeries(
  def: OverlayDef,
  candles: readonly Candle[],
  step: (candle: Candle) => Record<string, number> = def.create(),
): Record<string, OverlayPoint[]> {
  const out: Record<string, OverlayPoint[]> = {};
  for (const line of def.lines) out[line.key] = [];
  for (const c of candles) {
    const values = step(c);
    for (const line of def.lines) out[line.key].push(overlayPoint(c.time, values[line.key]));
  }
  return out;
}

/**
 * Drops signals another (earlier) overlay already marks: same instance identity (`signalKey`, else the overlay id)
 * and signal key. Overlays keep their lines and zones. Used for backtest and live charts alike.
 */
export function dedupeOverlaySignals(defs: readonly OverlayDef[]): OverlayDef[] {
  const seen = new Set<string>();
  return defs.map((def) => {
    if (!def.signals) return def;
    const id = def.signalKey ?? def.id;
    const signals = def.signals.filter((s) => {
      const key = `${id}|${s.key}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (signals.length === def.signals.length) return def;
    if (signals.length > 0) return { ...def, signals };
    const { signals: _drop, ...rest } = def;
    return rest;
  });
}
