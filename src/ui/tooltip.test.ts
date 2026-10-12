import { describe, expect, it } from 'vitest';
import { placeTip } from './tooltip';

const viewport = { width: 1000, height: 800 };
const tip = { width: 200, height: 60 };

describe('tooltip placement', () => {
  it('goes centred below its target when there is room', () => {
    expect(placeTip({ left: 400, top: 100, bottom: 120, width: 100 }, tip, viewport)).toEqual({ left: 350, top: 128, above: false });
  });

  it('flips above a target near the bottom of the window', () => {
    const pos = placeTip({ left: 400, top: 760, bottom: 780, width: 100 }, tip, viewport);
    expect(pos.above).toBe(true);
    expect(pos.top).toBe(760 - 8 - 60);
  });

  it('never leaves the window sideways', () => {
    expect(placeTip({ left: 0, top: 100, bottom: 120, width: 20 }, tip, viewport).left).toBe(8);
    expect(placeTip({ left: 990, top: 100, bottom: 120, width: 10 }, tip, viewport).left).toBe(1000 - 8 - 200);
  });
});
