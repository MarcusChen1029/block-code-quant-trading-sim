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
   * The adapter reconnects on its own until close() is called.
   */
  subscribeCandles(
    symbol: string,
    tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    onError?: (error: Error) => void,
  ): CandleSubscription;
}
