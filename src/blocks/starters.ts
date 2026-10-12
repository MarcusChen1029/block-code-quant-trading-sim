import { BT } from './blockTypes';
import { defaultWorkspace } from './defaultWorkspace';
import { indicatorBlockType, signalBlockType } from './registry';
import type { BlockState, WorkspaceState } from './workspaceState';
import { zoneExampleWorkspace } from './zoneExample';

/**
 * Starter strategies for the "Start from…" picker. Each is ordinary Blockly workspace JSON built from the existing
 * block types (the user can edit every part of it), not a hard-coded strategy. Sizing is 100 % of equity (1x at the
 * default leverage). Only market orders with literal sizes and close-position blocks are used, so no `na` value can
 * ever reach an order price or a stop-loss (comparisons with `na` are simply false during indicator warm-up).
 */
export type StarterId = 'smaCross' | 'rsiReversion' | 'bbBreakout' | 'supertrend' | 'macdCross' | 'zones' | 'martingale' | 'buyHold';

export interface StarterDef {
  id: StarterId;
  label: string;
  /** One plain-language line shown in the picker. */
  description: string;
  build(): WorkspaceState;
}

const num = (id: string, value: number): { shadow: BlockState } => ({ shadow: { type: 'math_number', id, fields: { NUM: value } } });
const priceShadow = (id: string, field = 'close') => ({ shadow: { type: BT.price, id, fields: { FIELD: field, OFFSET: 0 } } });
const and = (id: string, a: BlockState, b: BlockState): BlockState => ({ type: 'logic_operation', id, fields: { OP: 'AND' }, inputs: { A: { block: a }, B: { block: b } } });
const compare = (id: string, op: string, a: BlockState, b: { block: BlockState } | { shadow: BlockState }): BlockState =>
  ({ type: 'logic_compare', id, fields: { OP: op }, inputs: { A: { block: a }, B: b } });
const positionIs = (id: string, side: 'flat' | 'long' | 'short'): BlockState => ({ type: BT.positionIs, id, fields: { SIDE: side } });
const positionSize = (id: string): BlockState => ({ type: BT.positionSize, id });
const close = (id: string): BlockState => ({ type: BT.price, id, fields: { FIELD: 'close', OFFSET: 0 } });
const order = (id: string, side: 'buy' | 'sell'): BlockState =>
  ({ type: BT.marketOrder, id, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: num(`${id}-pct`, 100) } });
const closePosition = (id: string): BlockState => ({ type: BT.closePosition, id });
const ifThen = (id: string, cond: BlockState, body: BlockState, next?: BlockState): BlockState =>
  ({ type: 'controls_if', id, inputs: { IF0: { block: cond }, DO0: { block: body } }, ...(next ? { next: { block: next } } : {}) });

/** `when strategy starts: log <message>` + `when a bar closes: <body>`. */
function workspace(prefix: string, message: string, body: BlockState): WorkspaceState {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: BT.start, id: `${prefix}-start`, x: 20, y: 20,
          next: { block: { type: BT.log, id: `${prefix}-hello`, inputs: { MSG: { shadow: { type: 'text', id: `${prefix}-hello-text`, fields: { TEXT: message } } } } } },
        },
        { type: BT.bar, id: `${prefix}-bar`, x: 20, y: 130, next: { block: body } },
      ],
    },
  };
}

/** Long only: enter when flat and `entry` holds, close the long when `exit` holds. */
function longOnly(prefix: string, message: string, entry: BlockState, exit: BlockState): WorkspaceState {
  return workspace(prefix, message,
    ifThen(`${prefix}-entry`, and(`${prefix}-entry-and`, entry, positionIs(`${prefix}-flat`, 'flat')), order(`${prefix}-buy`, 'buy'),
      ifThen(`${prefix}-exit`, and(`${prefix}-exit-and`, exit, positionIs(`${prefix}-long`, 'long')), closePosition(`${prefix}-close`))));
}

const rsi = (id: string): BlockState => ({ type: indicatorBlockType('rsi'), id, fields: { LENGTH: 14 }, inputs: { SOURCE: priceShadow(`${id}-src`) } });
const bb = (id: string, out: 'upper' | 'middle' | 'lower'): BlockState =>
  ({ type: indicatorBlockType('bb'), id, fields: { OUT: out, LENGTH: 20, MULT: 2 }, inputs: { SOURCE: priceShadow(`${id}-src`) } });
const supertrendSignal = (id: string, key: 'buy' | 'sell'): BlockState =>
  ({ type: signalBlockType('supertrend'), id, fields: { SIGOUT: key, LENGTH: 10, FACTOR: 3 }, inputs: { SOURCE: priceShadow(`${id}-src`, 'hl2') } });
const macdSignal = (id: string, key: 'bull_cross' | 'bear_cross'): BlockState =>
  ({ type: signalBlockType('macd'), id, fields: { SIGOUT: key, FAST: 12, SLOW: 26, SIGNAL: 9 }, inputs: { SOURCE: priceShadow(`${id}-src`) } });

function rsiReversion(): WorkspaceState {
  return longOnly('rsi', 'RSI mean reversion started',
    compare('rsi-oversold', 'LT', rsi('rsi-in'), num('rsi-30', 30)),
    compare('rsi-overbought', 'GT', rsi('rsi-out'), num('rsi-70', 70)));
}

function bbBreakout(): WorkspaceState {
  return longOnly('bbo', 'Bollinger breakout started',
    compare('bbo-above', 'GT', close('bbo-close-in'), { block: bb('bbo-upper', 'upper') }),
    compare('bbo-below', 'LT', close('bbo-close-out'), { block: bb('bbo-middle', 'middle') }));
}

/** On a Supertrend Buy: close a short, go long. On a Sell: close a long, go short (always in the market). */
function supertrendFlip(): WorkspaceState {
  const flip = (prefix: string, key: 'buy' | 'sell', guard: 'LTE' | 'GTE', opposite: 'long' | 'short') =>
    ifThen(`${prefix}-if`,
      and(`${prefix}-and`, supertrendSignal(`${prefix}-sig`, key), compare(`${prefix}-cmp`, guard, positionSize(`${prefix}-size`), num(`${prefix}-zero`, 0))),
      ifThen(`${prefix}-flip`, positionIs(`${prefix}-is`, opposite), closePosition(`${prefix}-close`), order(`${prefix}-order`, key)));
  const buy = flip('st-long', 'buy', 'LTE', 'short');
  buy.next = { block: flip('st-short', 'sell', 'GTE', 'long') };
  return workspace('st', 'Supertrend flip started', buy);
}

function macdCross(): WorkspaceState {
  return longOnly('macd', 'MACD cross started', macdSignal('macd-bull', 'bull_cross'), macdSignal('macd-bear', 'bear_cross'));
}

const varGet = (id: string, varId: string): BlockState => ({ type: 'variables_get', id, fields: { VAR: { id: varId } } });
const varSet = (id: string, varId: string, value: BlockState | { shadow: BlockState }): BlockState =>
  ({ type: 'variables_set', id, fields: { VAR: { id: varId } }, inputs: { VALUE: 'type' in value ? { block: value } : value } });
const chain = (...blocks: BlockState[]): BlockState => {
  for (let i = 0; i < blocks.length - 1; i++) blocks[i].next = { block: blocks[i + 1] };
  return blocks[0];
};

/**
 * Martingale: always re-enters a long as soon as the account is flat, with a +-2 % stop-loss / take-profit. After a
 * losing trade the stake (% of equity used as margin) doubles, after a win it resets to the base. The stake is capped
 * so it never reaches 100 % (a full-equity order has no room for the fee and would be rejected). Teaching example:
 * martingale wins small and often until one long losing streak, so look at the max drawdown before trusting it.
 */
function martingale(): WorkspaceState {
  const BASE = 5;
  const CAP = 50;
  const [stake, entryEquity, inTrade] = ['mg-v-stake', 'mg-v-entry', 'mg-v-intrade'];
  const afterClose = controlsIfElse('mg-won', compare('mg-won-cmp', 'GTE', { type: BT.equity, id: 'mg-eq-now' }, { block: varGet('mg-entry-get', entryEquity) }),
    varSet('mg-reset', stake, num('mg-base', BASE)),
    varSet('mg-double', stake, { type: BT.minMax, id: 'mg-cap', fields: { OP: 'MIN' }, inputs: {
      A: { block: { type: 'math_arithmetic', id: 'mg-x2', fields: { OP: 'MULTIPLY' }, inputs: { A: { block: varGet('mg-stake-get', stake) }, B: num('mg-two', 2) } } },
      B: num('mg-cap-num', CAP),
    } }));
  const openNew = { type: BT.openPosition, id: 'mg-open', fields: { SIDE: 'buy' }, inputs: {
    EQUITY: { block: varGet('mg-stake-open', stake) }, LEVERAGE: num('mg-lev', 1), STOP: num('mg-sl', 2), TAKE: num('mg-tp', 2),
  } } as BlockState;
  const body = ifThen('mg-entry', and('mg-entry-and', positionIs('mg-flat', 'flat'), compare('mg-no-orders', 'EQ', { type: BT.openOrders, id: 'mg-orders' }, num('mg-zero', 0))),
    chain(
      ifThen('mg-closed', compare('mg-was-in', 'EQ', varGet('mg-intrade-get', inTrade), num('mg-one', 1)), chain(afterClose, varSet('mg-out', inTrade, num('mg-zero2', 0)))),
      varSet('mg-save', entryEquity, { type: BT.equity, id: 'mg-eq-save' }),
      varSet('mg-in', inTrade, num('mg-one2', 1)),
      openNew,
    ));
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: BT.start, id: 'mg-start', x: 20, y: 20,
          next: { block: chain(
            varSet('mg-init-stake', stake, num('mg-init-base', BASE)),
            varSet('mg-init-entry', entryEquity, { type: BT.equity, id: 'mg-init-eq' }),
            varSet('mg-init-in', inTrade, num('mg-init-zero', 0)),
            { type: BT.log, id: 'mg-hello', inputs: { MSG: { shadow: { type: 'text', id: 'mg-hello-text', fields: { TEXT: `Martingale started: stake ${BASE}% of equity, doubles after a loss (cap ${CAP}%)` } } } } },
          ) },
        },
        { type: BT.bar, id: 'mg-bar', x: 20, y: 260, next: { block: body } },
      ],
    },
    variables: [{ name: 'stake', id: stake }, { name: 'entry equity', id: entryEquity }, { name: 'in trade', id: inTrade }],
  };
}

function controlsIfElse(id: string, cond: BlockState, thenBlock: BlockState, elseBlock: BlockState): BlockState {
  return { type: 'controls_if', id, extraState: { hasElse: true }, inputs: { IF0: { block: cond }, DO0: { block: thenBlock }, ELSE: { block: elseBlock } } };
}

/** Buys 100 % of equity once (flat, nothing pending) and never sells: the baseline to beat. */
function buyHold(): WorkspaceState {
  return workspace('bh', 'Buy & hold started',
    ifThen('bh-entry',
      and('bh-and', positionIs('bh-flat', 'flat'), compare('bh-no-orders', 'EQ', { type: BT.openOrders, id: 'bh-orders' }, num('bh-zero', 0))),
      order('bh-buy', 'buy')));
}

export const STARTERS: readonly StarterDef[] = [
  { id: 'smaCross', label: 'SMA 10/30 cross', description: 'Always in the market: long when SMA 10 crosses above SMA 30, short when it crosses below.', build: defaultWorkspace },
  { id: 'rsiReversion', label: 'RSI oversold/overbought (mean reversion)', description: 'Buys when RSI 14 drops below 30, sells the position when RSI rises above 70.', build: rsiReversion },
  { id: 'bbBreakout', label: 'Bollinger breakout', description: 'Buys when the close breaks above the upper band, exits when it falls back below the middle band.', build: bbBreakout },
  { id: 'supertrend', label: 'Supertrend flip', description: "Follows the built-in Supertrend 10/3 Buy and Sell signals: long after a Buy, short after a Sell.", build: supertrendFlip },
  { id: 'macdCross', label: 'MACD cross', description: 'Buys when the MACD line crosses above its signal line, exits on the opposite cross.', build: macdCross },
  { id: 'zones', label: 'Zone example (order block + fair value gap)', description: 'Buys inside a bullish order block while a bullish fair value gap is active; exits when the order block breaks.', build: zoneExampleWorkspace },
  { id: 'martingale', label: 'Martingale (doubles after a loss)', description: 'Re-enters long whenever flat with a 2% stop and 2% target; the stake doubles after each loss (capped at 50% of equity) and resets after a win.', build: martingale },
  { id: 'buyHold', label: 'Buy & hold (baseline)', description: 'Buys once with all equity on the first bar and holds to the end: the baseline to beat.', build: buyHold },
];

export function getStarter(id: string): StarterDef | undefined {
  return STARTERS.find((s) => s.id === id);
}
