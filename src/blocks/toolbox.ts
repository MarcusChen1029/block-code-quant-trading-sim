import { BT } from './blockTypes';
import { PALETTE, type BlockStyleName } from './palette';
import { indicatorBlockType, listIndicators, PINE_ID_PREFIX, type IndicatorBlockDef } from './registry';
import type { BlockState, ConnectionState } from './workspaceState';

/** Toolbox in Blockly's JSON format (kept as plain data so tests can check it without a DOM). */
export interface ToolboxBlock {
  kind: 'block';
  type: string;
  extraState?: unknown;
  fields?: Record<string, unknown>;
  inputs?: Record<string, ConnectionState>;
}

/** A text line in a flyout (used to explain an empty Pine category). */
export interface ToolboxLabel {
  kind: 'label';
  text: string;
}

export interface ToolboxCategory {
  kind: 'category';
  name: string;
  colour: string;
  contents?: Array<ToolboxBlock | ToolboxLabel>;
  /** Blockly's dynamic categories: 'VARIABLE' (my variables) and 'PROCEDURE' (functions). */
  custom?: 'VARIABLE' | 'PROCEDURE';
}

export interface Toolbox {
  kind: 'categoryToolbox';
  contents: ToolboxCategory[];
}

const shadow = (type: string, fields: Record<string, unknown> = {}): ConnectionState => ({ shadow: { type, fields } as BlockState });
const number = (value: number) => shadow('math_number', { NUM: value });
const priceShadow = (field: string) => shadow(BT.price, { FIELD: field, OFFSET: 0 });

const block = (type: string, extra: Partial<ToolboxBlock> = {}): ToolboxBlock => ({ kind: 'block', type, ...extra });
const category = (name: string, style: BlockStyleName, contents: Array<ToolboxBlock | ToolboxLabel>): ToolboxCategory => ({
  kind: 'category', name, colour: PALETTE[style][0], contents,
});

const indicatorBlock = (def: IndicatorBlockDef): ToolboxBlock =>
  block(indicatorBlockType(def.id), def.source ? { inputs: { SOURCE: priceShadow(def.source) } } : {});

/** Builds the toolbox; indicator blocks come from the registry, Pine-compiled ones in their own category. */
export function buildToolbox(): Toolbox {
  const all = listIndicators();
  const pine = all.filter((d) => d.id.startsWith(PINE_ID_PREFIX));
  return {
    kind: 'categoryToolbox',
    contents: [
      category('Events', 'event_blocks', [block(BT.start), block(BT.bar)]),
      category('Market', 'market_blocks', [
        block(BT.price, { fields: { FIELD: 'close', OFFSET: 0 } }),
        block(BT.price, { fields: { FIELD: 'close', OFFSET: 1 } }),
        block(BT.volume),
        block(BT.currentPrice),
        block(BT.product),
        block(BT.timeframe),
        block(BT.barTime),
        block(BT.barIndex),
      ]),
      category('Account', 'account_blocks', [
        block(BT.balance), block(BT.equity), block(BT.positionIs), block(BT.positionSide), block(BT.positionSize),
        block(BT.entryPrice), block(BT.unrealizedPnl), block(BT.openOrders),
      ]),
      category('Indicators', 'indicator_blocks', all.filter((d) => !d.id.startsWith(PINE_ID_PREFIX)).map(indicatorBlock)),
      category('Pine', 'indicator_blocks', pine.length > 0
        ? pine.map(indicatorBlock)
        : [{ kind: 'label', text: 'Compile a script in the Pine tab to get a block here.' }]),
      category('Logic', 'logic_blocks', [
        block('controls_if'),
        block('controls_if', { extraState: { hasElse: true } }),
        block('logic_compare', { fields: { OP: 'GT' } }),
        block(BT.crosses, { fields: { OP: 'over' } }),
        block(BT.crosses, { fields: { OP: 'under' } }),
        block('logic_operation'),
        block('logic_negate'),
        block('logic_boolean'),
        block('controls_repeat_ext', { inputs: { TIMES: number(10) } }),
      ]),
      category('Math', 'math_blocks', [
        block('math_number', { fields: { NUM: 0 } }),
        block('math_arithmetic', { inputs: { A: number(1), B: number(1) } }),
        block('math_single', { fields: { OP: 'ABS' } }),
        block(BT.minMax, { inputs: { A: number(0), B: number(0) } }),
        block('math_round'),
        block('text'),
        block('text_join'),
      ]),
      { kind: 'category', name: 'My variables', colour: PALETTE.variable_blocks[0], custom: 'VARIABLE' },
      category('Actions', 'action_blocks', [
        block(BT.marketOrder, { fields: { SIDE: 'buy', UNIT: 'percentEquity' }, inputs: { SIZE: number(100) } }),
        block(BT.marketOrder, { fields: { SIDE: 'sell', UNIT: 'percentEquity' }, inputs: { SIZE: number(100) } }),
        block(BT.limitOrder, { fields: { SIDE: 'buy', UNIT: 'percentEquity' }, inputs: { PRICE: number(100), SIZE: number(100) } }),
        block(BT.setExit, { fields: { KIND: 'stopLoss' }, inputs: { PRICE: number(100) } }),
        block(BT.setExit, { fields: { KIND: 'takeProfit' }, inputs: { PRICE: number(100) } }),
        block(BT.clearExit),
        block(BT.closePosition),
        block(BT.cancelOrders),
        block(BT.log, { inputs: { MSG: shadow('text', { TEXT: 'hello' }) } }),
      ]),
      { kind: 'category', name: 'Functions', colour: PALETTE.procedure_blocks[0], custom: 'PROCEDURE' },
    ],
  };
}
