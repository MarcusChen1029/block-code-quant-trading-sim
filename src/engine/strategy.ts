import type { Candle, Timeframe } from '../data/types';
import type { OrderType, PositionView, SizeUnit } from './types';

export type PriceField = 'open' | 'high' | 'low' | 'close' | 'volume';

export interface EntryRequest {
  /** Default 'market'. */
  type?: OrderType;
  size: number;
  /** Default 'percentEquity'. */
  unit?: SizeUnit;
  /** Required for limit/stop. */
  price?: number;
}

/**
 * Everything a strategy may see and do on one CLOSED bar. Hand-written strategies, the Blockly generator
 * and Pine-compiled code all target this interface; live mode feeds the same Engine.
 */
export interface StrategyContext {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** 0-based index of the bar that just closed. */
  readonly barIndex: number;
  /** The bar that just closed. Later bars are never visible (no look-ahead). */
  readonly candle: Candle;
  /** `field` of the bar `offset` bars ago (0 = this bar). NaN before the first bar or for negative offsets. */
  value(field: PriceField, offset?: number): number;
  readonly balance: number;
  /** Balance + unrealized PnL marked at this bar's close. */
  readonly equity: number;
  readonly unrealizedPnl: number;
  readonly position: PositionView;
  readonly openOrderCount: number;
  /** Queues a buy for the next bar; returns the order id. */
  buy(request: EntryRequest): number;
  /** Queues a sell for the next bar; returns the order id. */
  sell(request: EntryRequest): number;
  /** Queues a reduce-only market order closing the whole position; null when flat. */
  closePosition(): number | null;
  cancelOrders(): void;
  setStopLoss(price: number | null): void;
  setTakeProfit(price: number | null): void;
  log(message: string): void;
}

/**
 * An error raised while a strategy runs. `blockId` names the Blockly block that was executing (block strategies
 * only) so the UI can highlight it; `bar` is the bar index when known.
 */
export class StrategyError extends Error {
  constructor(message: string, readonly blockId?: string, readonly bar?: number) {
    super(message);
    this.name = 'StrategyError';
  }
}

export interface Strategy {
  /** Once, on the first bar, before onBar ("when strategy starts"). */
  init?(ctx: StrategyContext): void;
  /** Every closed bar ("when a bar closes"), after the broker processed that bar's fills. */
  onBar(ctx: StrategyContext): void;
}
