/** One OHLCV bar. `time` is the bar OPEN time in epoch milliseconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Supported bar intervals (Binance interval strings). */
export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/** Bar duration in milliseconds, e.g. '15m' -> 900000. */
export function timeframeToMs(tf: Timeframe): number {
  const amount = Number(tf.slice(0, -1));
  const unit = tf.slice(-1);
  return amount * UNIT_MS[unit];
}
