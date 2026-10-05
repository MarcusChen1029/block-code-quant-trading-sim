import { describe, it, expect } from 'vitest';
import type { Fill } from '../engine/types';
import { fillsToMarkers } from './markers';

const fill = (side: Fill['side'], reason: Fill['reason'], time: number): Fill => ({
  orderId: 1, bar: 1, time, side, qty: 1, price: 100, fee: 0, reason,
});

describe('fillsToMarkers', () => {
  it('maps buys below and sells above the bar, labelled by reason', () => {
    expect(fillsToMarkers([fill('buy', 'market', 3_600_000), fill('sell', 'stopLoss', 7_200_000)])).toEqual([
      { time: 3600, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', text: 'Buy' },
      { time: 7200, position: 'aboveBar', shape: 'arrowDown', color: '#ef5350', text: 'Sell SL' },
    ]);
  });
});
