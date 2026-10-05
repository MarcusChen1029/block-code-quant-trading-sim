import { BT } from './blockTypes';
import { indicatorBlockType } from './registry';
import type { BlockState, WorkspaceState } from './workspaceState';

const num = (id: string, value: number) => ({ shadow: { type: 'math_number', id, fields: { NUM: value } } });

function sma(id: string, length: number): BlockState {
  return {
    type: indicatorBlockType('sma'),
    id,
    fields: { LENGTH: length },
    inputs: { SOURCE: { shadow: { type: BT.price, id: `${id}-src`, fields: { FIELD: 'close', OFFSET: 0 } } } },
  };
}

/** `(sma fast crosses <kind> sma slow) and (position size <op> 0)` */
function signal(prefix: string, kind: 'over' | 'under', compare: 'LTE' | 'GTE'): BlockState {
  return {
    type: 'logic_operation',
    id: `${prefix}-and`,
    fields: { OP: 'AND' },
    inputs: {
      A: {
        block: {
          type: BT.crosses,
          id: `${prefix}-cross`,
          fields: { OP: kind },
          inputs: { A: { block: sma(`${prefix}-fast`, 10) }, B: { block: sma(`${prefix}-slow`, 30) } },
        },
      },
      B: {
        block: {
          type: 'logic_compare',
          id: `${prefix}-cmp`,
          fields: { OP: compare },
          inputs: { A: { block: { type: BT.positionSize, id: `${prefix}-size` } }, B: num(`${prefix}-zero`, 0) },
        },
      },
    },
  };
}

/** `if position is <opposite>: close position` then `<side> market 100 % of equity` */
function entry(prefix: string, opposite: 'long' | 'short', side: 'buy' | 'sell'): BlockState {
  return {
    type: 'controls_if',
    id: `${prefix}-flip`,
    inputs: {
      IF0: { block: { type: BT.positionIs, id: `${prefix}-is`, fields: { SIDE: opposite } } },
      DO0: { block: { type: BT.closePosition, id: `${prefix}-close` } },
    },
    next: {
      block: {
        type: BT.marketOrder,
        id: `${prefix}-order`,
        fields: { SIDE: side, UNIT: 'percentEquity' },
        inputs: { SIZE: num(`${prefix}-pct`, 100) },
      },
    },
  };
}

/**
 * The starter workspace: the built-in SMA 10/30 cross (src/engine/strategies/smaCross.ts) rebuilt from blocks.
 * Always in the market: long on a cross over, short on a cross under. Tests prove the trade lists match.
 */
export function defaultWorkspace(): WorkspaceState {
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: BT.start,
          id: 'default-start',
          x: 20,
          y: 20,
          next: {
            block: {
              type: BT.log,
              id: 'default-hello',
              inputs: { MSG: { shadow: { type: 'text', id: 'default-hello-text', fields: { TEXT: 'SMA 10/30 cross started' } } } },
            },
          },
        },
        {
          type: BT.bar,
          id: 'default-bar',
          x: 20,
          y: 130,
          next: {
            block: {
              type: 'controls_if',
              id: 'default-if',
              extraState: { elseIfCount: 1 },
              inputs: {
                IF0: { block: signal('long', 'over', 'LTE') },
                DO0: { block: entry('long', 'short', 'buy') },
                IF1: { block: signal('short', 'under', 'GTE') },
                DO1: { block: entry('short', 'long', 'sell') },
              },
            },
          },
        },
      ],
    },
  };
}
