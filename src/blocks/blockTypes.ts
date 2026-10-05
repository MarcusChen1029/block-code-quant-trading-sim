/**
 * Block type names and dropdown option tables shared by the Blockly definitions (UI) and the generator,
 * so the two can never disagree. Option tables are [label, value]; only values reach generated code,
 * and only after being checked against these tables.
 */
export const BT = {
  start: 'event_start',
  bar: 'event_bar',

  price: 'market_price',
  volume: 'market_volume',
  product: 'market_product',
  timeframe: 'market_timeframe',
  currentPrice: 'market_current_price',
  barTime: 'market_bar_time',
  barIndex: 'market_bar_index',

  balance: 'account_balance',
  equity: 'account_equity',
  positionSide: 'account_position_side',
  positionIs: 'account_position_is',
  positionSize: 'account_position_size',
  entryPrice: 'account_entry_price',
  unrealizedPnl: 'account_unrealized_pnl',
  openOrders: 'account_open_orders',

  crosses: 'logic_crosses',
  minMax: 'math_minmax',

  marketOrder: 'action_market_order',
  limitOrder: 'action_limit_order',
  setExit: 'action_set_exit',
  clearExit: 'action_clear_exit',
  closePosition: 'action_close_position',
  cancelOrders: 'action_cancel_orders',
  log: 'action_log',
} as const;

export type Options = ReadonlyArray<readonly [string, string]>;

export const PRICE_FIELD_OPTIONS: Options = [
  ['close', 'close'], ['open', 'open'], ['high', 'high'], ['low', 'low'],
  ['hl2', 'hl2'], ['hlc3', 'hlc3'], ['ohlc4', 'ohlc4'],
];
export const SIDE_OPTIONS: Options = [['buy', 'buy'], ['sell', 'sell']];
export const SIZE_UNIT_OPTIONS: Options = [['% of equity', 'percentEquity'], ['USDT', 'usdt'], ['quantity', 'qty']];
export const EXIT_OPTIONS: Options = [['stop-loss', 'stopLoss'], ['take-profit', 'takeProfit']];
export const POSITION_SIDE_OPTIONS: Options = [['long', 'long'], ['short', 'short'], ['flat', 'flat']];
export const CROSS_OPTIONS: Options = [['crosses over', 'over'], ['crosses under', 'under']];
export const MIN_MAX_OPTIONS: Options = [['min', 'MIN'], ['max', 'MAX']];

/** Largest `n bars ago` a price block accepts; sizes the history ring buffer. */
export const MAX_PRICE_OFFSET = 5000;

/** Per-bar budget of loop iterations + function calls (spec §7). */
export const MAX_LOOP_ITERATIONS_PER_BAR = 10_000;

export function hasOption(options: Options, value: unknown): value is string {
  return typeof value === 'string' && options.some(([, v]) => v === value);
}
