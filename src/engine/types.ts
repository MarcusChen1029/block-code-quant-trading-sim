export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

/**
 * How `size` is interpreted, resolved at FILL time:
 * - percentEquity: margin = size% of equity, so notional = margin x leverage (fee is reserved inside the budget);
 * - usdt: notional value in USDT;
 * - qty: base-asset quantity.
 */
export type SizeUnit = 'percentEquity' | 'usdt' | 'qty';

export interface OrderRequest {
  side: Side;
  type: OrderType;
  size: number;
  unit: SizeUnit;
  /** Limit or stop trigger price; required for 'limit' and 'stop'. */
  price?: number;
  /** Only reduces the current position; the size is clipped to it (size may be Infinity). */
  reduceOnly?: boolean;
}

export interface Order extends OrderRequest {
  id: number;
  placedBar: number;
  placedTime: number;
}

export type FillReason = 'market' | 'limit' | 'stop' | 'stopLoss' | 'takeProfit' | 'wiped';

export interface Fill {
  /** null for SL/TP and forced fills, which are not orders. */
  orderId: number | null;
  bar: number;
  time: number;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  reason: FillReason;
}

/** A closed (or partially closed) round trip. */
export interface Trade {
  side: 'long' | 'short';
  qty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  /** Price PnL before fees. */
  pnl: number;
  /** Pro-rata entry fee + exit fee. */
  fees: number;
  netPnl: number;
  exitReason: FillReason;
}

export interface PositionView {
  side: 'long' | 'short' | 'flat';
  /** Signed: > 0 long, < 0 short, 0 flat. */
  qty: number;
  /** Average entry price; NaN when flat. */
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface LogEntry {
  bar: number;
  time: number;
  /** 'debug': engine notes (e.g. live warm-up suppressing orders), shown dimmed. */
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
}

export interface BrokerConfig {
  initialBalance: number;
  leverage: number;
  /** Fraction, e.g. 0.0004 = 0.04%. Market, stop and stop-loss fills. */
  takerFee: number;
  /** Fraction, e.g. 0.0002 = 0.02%. Limit and take-profit fills. */
  makerFee: number;
  /** Basis points applied against us on taker fills (market, stop, stop-loss). */
  slippageBps: number;
}

export const DEFAULT_BROKER_CONFIG: BrokerConfig = {
  initialBalance: 10_000,
  leverage: 1,
  takerFee: 0.0004,
  makerFee: 0.0002,
  slippageBps: 2,
};
