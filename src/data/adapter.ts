import type { Candle, Timeframe } from './types';

/** Handle returned by a live subscription; call close() to stop receiving candles. */
export interface CandleSubscription {
  close(): void;
}

/**
 * Swappable market-data source. Binance futures is the default implementation;
 * a spot fallback (data-api.binance.vision) can implement the same interface.
 */
export interface MarketDataAdapter {
  readonly name: string;
  /** Closed candles whose open time is in [startMs, endMs], ascending, no duplicates. */
  fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]>;
  /**
   * Streams the forming candle. `closed` is true exactly once per bar, on its final update.
   * The adapter reconnects on its own until close() is called; it does NOT replay bars missed while
   * disconnected (callers that must not skip bars backfill them with fetchCandles). `onStatus` reports
   * the connection state ('connecting' first, 'open' when data flows, 'reconnecting' after a drop).
   */
  subscribeCandles(
    symbol: string,
    tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    onError?: (error: Error) => void,
    onStatus?: (state: ConnectionState) => void,
  ): CandleSubscription;
  /** Exchange time now, when the adapter knows it (null = only the local clock is known; do not trust it). */
  serverNow?(): number | null;
  /** Measures the exchange clock; false when that is not possible right now. */
  syncClock?(): Promise<boolean>;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';
