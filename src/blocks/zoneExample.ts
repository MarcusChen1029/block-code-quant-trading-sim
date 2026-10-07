import { BT } from './blockTypes';
import { indicatorBlockType, signalBlockType } from './registry';
import type { BlockState, WorkspaceState } from './workspaceState';

const OB_FIELDS = { SWING: 5, LOOKBACK: 10, USE_BODY: 0, MAX_AGE: 300, MAX_ACTIVE: 5 };
const FVG_FIELDS = { MIN_GAP_PCT: 0.05, MAX_AGE: 300, MAX_ACTIVE: 5 };

const and = (id: string, a: BlockState, b: BlockState): BlockState => ({ type: 'logic_operation', id, fields: { OP: 'AND' }, inputs: { A: { block: a }, B: { block: b } } });
const obSignal = (id: string, key: string): BlockState => ({ type: signalBlockType('orderblock'), id, fields: { SIGOUT: key, ...OB_FIELDS } });
const positionIs = (id: string, side: 'flat' | 'long'): BlockState => ({ type: BT.positionIs, id, fields: { SIDE: side } });

/**
 * "Order block + FVG" example: buy (100 % of equity) when the bar overlaps an active bullish order block while a
 * bullish fair value gap is active at or below the close (its bottom is a number, not na) and the position is flat;
 * close the position when a bullish order block is mitigated (a close below its bottom). Long only, no look-ahead:
 * every value is known at the bar's close and orders fill at the next open.
 */
export function zoneExampleWorkspace(): WorkspaceState {
  const fvgActive: BlockState = {
    type: 'logic_compare',
    id: 'zx-fvg-active',
    fields: { OP: 'GT' },
    inputs: {
      A: { block: { type: indicatorBlockType('fvg'), id: 'zx-fvg', fields: { OUT: 'bull_bottom', ...FVG_FIELDS } } },
      B: { shadow: { type: 'math_number', id: 'zx-zero', fields: { NUM: 0 } } },
    },
  };
  return {
    blocks: {
      languageVersion: 0,
      blocks: [
        {
          type: BT.start, id: 'zx-start', x: 20, y: 20,
          next: { block: { type: BT.log, id: 'zx-hello', inputs: { MSG: { shadow: { type: 'text', id: 'zx-hello-text', fields: { TEXT: 'Order block + FVG example started' } } } } } },
        },
        {
          type: BT.bar, id: 'zx-bar', x: 20, y: 130,
          next: {
            block: {
              type: 'controls_if', id: 'zx-entry',
              inputs: {
                IF0: { block: and('zx-and-1', and('zx-and-2', obSignal('zx-in-ob', 'in_bull'), fvgActive), positionIs('zx-flat', 'flat')) },
                DO0: { block: { type: BT.marketOrder, id: 'zx-buy', fields: { SIDE: 'buy', UNIT: 'percentEquity' }, inputs: { SIZE: { shadow: { type: 'math_number', id: 'zx-pct', fields: { NUM: 100 } } } } } },
              },
              next: {
                block: {
                  type: 'controls_if', id: 'zx-exit',
                  inputs: {
                    IF0: { block: and('zx-and-3', obSignal('zx-mitigated', 'bull_mitigated'), positionIs('zx-long', 'long')) },
                    DO0: { block: { type: BT.closePosition, id: 'zx-close' } },
                  },
                },
              },
            },
          },
        },
      ],
    },
  };
}
