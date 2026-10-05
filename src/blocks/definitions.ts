import * as Blockly from 'blockly';
import {
  BT, CROSS_OPTIONS, EXIT_OPTIONS, MAX_PRICE_OFFSET, MIN_MAX_OPTIONS, POSITION_SIDE_OPTIONS, PRICE_FIELD_OPTIONS,
  SIDE_OPTIONS, SIZE_UNIT_OPTIONS, type Options,
} from './blockTypes';
import { getIndicator, INDICATOR_BLOCK_PREFIX, indicatorBlockType, listIndicators, paramFieldName, type IndicatorBlockDef } from './registry';

type Json = Record<string, unknown>;

const dropdown = (name: string, options: Options) => ({ type: 'field_dropdown', name, options: options.map((o) => [...o]) });
const offsetField = { type: 'field_number', name: 'OFFSET', value: 0, min: 0, max: MAX_PRICE_OFFSET, precision: 1 };
const numberIn = (name: string) => ({ type: 'input_value', name, check: 'Number' });

/** A value block: `text` with %1.. placeholders, `args` for them. */
function reporter(type: string, style: string, text: string, tooltip: string, output: string | null = 'Number', args: unknown[] = []): Json {
  return { type, style, message0: text, args0: args, output, tooltip, inputsInline: true };
}

/** A stackable command block. */
function command(type: string, text: string, tooltip: string, args: unknown[] = []): Json {
  return { type, style: 'action_blocks', message0: text, args0: args, previousStatement: null, nextStatement: null, tooltip, inputsInline: true };
}

const CUSTOM_BLOCKS: Json[] = [
  // Events (hats): blocks stack underneath, Scratch-style.
  { type: BT.start, style: 'event_blocks', message0: 'when strategy starts', nextStatement: null, tooltip: "Runs once, on the first bar, before 'when a bar closes'. Good for setting variables." },
  { type: BT.bar, style: 'event_blocks', message0: 'when a bar closes', nextStatement: null, tooltip: 'Runs every time a bar (candle) closes. The strategy only ever sees closed bars: no look-ahead. Orders placed here fill at the next bar\'s open.' },

  // Market
  reporter(BT.price, 'market_blocks', '%1 %2 bars ago', 'A value of a closed bar. 0 bars ago = the bar that just closed. hl2/hlc3/ohlc4 are averages as in Pine. Empty (na) before enough bars exist.', 'Number', [dropdown('FIELD', PRICE_FIELD_OPTIONS), offsetField]),
  reporter(BT.volume, 'market_blocks', 'volume %1 bars ago', 'Traded volume of a closed bar.', 'Number', [offsetField]),
  reporter(BT.currentPrice, 'market_blocks', 'current price', 'Backtest: the last close (the bar that just closed). Live mode: the latest tick.'),
  reporter(BT.product, 'market_blocks', 'product', 'The traded symbol, e.g. BTCUSDT.', 'String'),
  reporter(BT.timeframe, 'market_blocks', 'timeframe', 'The bar interval, e.g. 1h.', 'String'),
  reporter(BT.barTime, 'market_blocks', 'bar time', "Open time of the bar that just closed, in milliseconds since 1970-01-01 UTC."),
  reporter(BT.barIndex, 'market_blocks', 'bar index', '0 for the first bar, then 1, 2, …'),

  // Account
  reporter(BT.balance, 'account_blocks', 'balance', 'Cash balance in USDT (realised PnL and fees included, open position not).'),
  reporter(BT.equity, 'account_blocks', 'equity', 'Balance + unrealised PnL at the last close.'),
  reporter(BT.positionSide, 'account_blocks', 'position side', 'Text: long, short or flat.', 'String'),
  reporter(BT.positionIs, 'account_blocks', 'position is %1', 'True when the current position is long / short / flat.', 'Boolean', [dropdown('SIDE', POSITION_SIDE_OPTIONS)]),
  reporter(BT.positionSize, 'account_blocks', 'position size', 'Signed quantity like Pine strategy.position_size: > 0 long, < 0 short, 0 flat.'),
  reporter(BT.entryPrice, 'account_blocks', 'entry price', 'Average entry price of the open position (na when flat).'),
  reporter(BT.unrealizedPnl, 'account_blocks', 'unrealized PnL', 'Open position PnL at the last close, in USDT.'),
  reporter(BT.openOrders, 'account_blocks', 'open order count', 'Orders waiting to fill (market, limit).'),

  // Logic / math additions
  {
    type: BT.crosses, style: 'logic_blocks', message0: '%1 %2 %3', inputsInline: true, output: 'Boolean',
    args0: [numberIn('A'), dropdown('OP', CROSS_OPTIONS), numberIn('B')],
    tooltip: 'True on the bar where the left value moves above (over) or below (under) the right value, compared with the previous bar. Evaluated on every bar, even inside an if that is not taken.',
  },
  {
    type: BT.minMax, style: 'math_blocks', message0: '%1 of %2 and %3', inputsInline: true, output: 'Number',
    args0: [dropdown('OP', MIN_MAX_OPTIONS), numberIn('A'), numberIn('B')], tooltip: 'The smaller / larger of two numbers.',
  },

  // Actions
  command(BT.marketOrder, '%1 at market, size %2 %3', "Queues a market order; it fills at the next bar's open (plus slippage and taker fee). An opposite order reduces or flips the position.", [dropdown('SIDE', SIDE_OPTIONS), numberIn('SIZE'), dropdown('UNIT', SIZE_UNIT_OPTIONS)]),
  command(BT.limitOrder, '%1 limit at price %2 size %3 %4', "Queues a limit order; it fills when a later bar's high/low reaches the price (maker fee).", [dropdown('SIDE', SIDE_OPTIONS), numberIn('PRICE'), numberIn('SIZE'), dropdown('UNIT', SIZE_UNIT_OPTIONS)]),
  command(BT.setExit, 'set %1 at price %2', 'Protective exit for the current (or next) position, checked against each later bar. If one bar touches both, the stop-loss wins.', [dropdown('KIND', EXIT_OPTIONS), numberIn('PRICE')]),
  command(BT.clearExit, 'remove %1', 'Removes the stop-loss or take-profit.', [dropdown('KIND', EXIT_OPTIONS)]),
  command(BT.closePosition, 'close position', 'Queues a market order that closes the whole position at the next open.'),
  command(BT.cancelOrders, 'cancel all open orders', 'Cancels every order that has not filled yet.'),
  command(BT.log, 'log %1', 'Writes a line to the run log.', [{ type: 'input_value', name: 'MSG' }]),
];

/** Blockly JSON definition for a registered indicator. */
export function indicatorBlockJson(def: IndicatorBlockDef): Json {
  const parts: string[] = [];
  const args: unknown[] = [];
  const add = (text: string, arg: unknown) => {
    args.push(arg);
    parts.push(text.replace('%', `%${args.length}`));
  };
  parts.push(def.label);
  if (def.outputs.length > 1) add('%', dropdown('OUT', def.outputs.map((o) => [o.label, o.key] as const)));
  if (def.source) add('of %', { type: 'input_value', name: 'SOURCE', check: 'Number' });
  for (const p of def.params) {
    add(`${p.label} %`, { type: 'field_number', name: paramFieldName(p), value: p.default, min: p.min, max: p.max, precision: p.integer ? 1 : undefined });
  }
  return {
    type: indicatorBlockType(def.id), style: 'indicator_blocks', message0: parts.join(' '), args0: args,
    output: 'Number', inputsInline: true,
    tooltip: `${def.tooltip} Updates on every bar, even inside an if that is not taken. Early bars return na while it warms up.`,
  };
}

/** Block type -> the JSON it was defined with (Pine blocks are redefined when their script changes). */
const defined = new Map<string, string>();

function define(jsons: Json[]): void {
  const fresh = jsons.filter((b) => defined.get(b.type as string) !== JSON.stringify(b));
  for (const b of fresh) {
    const type = b.type as string;
    // Redefinition (an edited Pine script): drop the old one first so Blockly does not warn about overwriting.
    if (defined.has(type)) delete (Blockly.Blocks as Record<string, unknown>)[type];
    defined.set(type, JSON.stringify(b));
  }
  if (fresh.length > 0) Blockly.common.defineBlocksWithJsonArray(fresh);
}

/** Registers all custom blocks plus one block per registered indicator (idempotent; call again after registering more). */
export function defineBlocks(): void {
  define([...CUSTOM_BLOCKS, ...listIndicators().map(indicatorBlockJson)]);
}

/**
 * Placeholder for an indicator block whose definition is gone (a deleted Pine script) so a saved workspace that
 * still uses it loads. It keeps a SOURCE input; the generator reports it as a missing script.
 */
export function missingIndicatorBlockJson(type: string): Json {
  const name = type.slice(INDICATOR_BLOCK_PREFIX.length).replace(/^pine_/, '');
  return {
    type, style: 'indicator_blocks', message0: `⚠ missing Pine script "${name}" %1`, inputsInline: true, output: 'Number',
    args0: [{ type: 'input_value', name: 'SOURCE', check: 'Number' }],
    tooltip: 'This Pine script was deleted or no longer compiles. Re-create it in the Pine tab or remove this block.',
  };
}

/** Only well-formed Pine block types get a placeholder (the type text comes from saved, untrusted JSON). */
const MISSING_PINE_TYPE = /^ind_pine_[a-z0-9_]{1,35}$/;

/** Defines placeholders for the given indicator block types that have no registered indicator. */
export function defineMissingIndicatorBlocks(types: Iterable<string>): void {
  const missing = [...new Set(types)].filter((t) => MISSING_PINE_TYPE.test(t) && !getIndicator(t.slice(INDICATOR_BLOCK_PREFIX.length)));
  define(missing.map(missingIndicatorBlockJson));
}
