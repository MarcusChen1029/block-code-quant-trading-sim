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
  /**
   * Open time of the first bar (closed or forming) at or after `fromMs`, or null when the exchange has none.
   * Used to confirm a hole in the history before skipping it.
   */
  firstBarAtOrAfter?(symbol: string, tf: Timeframe, fromMs: number): Promise<number | null>;
}

export type ConnectionState = 'connecting' | 'open' | 'reconnecting';

/**
 * A failed market-data request, classified for retry decisions:
 * - 'rate-limited': the exchange asks us to slow down (HTTP 418/429); wait at least `retryAfterMs`;
 * - 'terminal': retrying cannot help (invalid symbol, other 4xx, blocked region): stop and say why;
 * - 'transient': server or network trouble; retry with backoff.
 */
export class MarketDataError extends Error {
  constructor(
    message: string,
    readonly kind: 'rate-limited' | 'terminal' | 'transient',
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MarketDataError';
  }
}
