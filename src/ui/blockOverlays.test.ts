import { describe, it, expect } from 'vitest';
import { compileBlocks } from '../blocks/compiler';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { syntheticCandles } from '../engine/syntheticCandles';
import { Sma } from '../indicators/averages';
import { blockIndicatorOverlays } from './blockOverlays';
import { computeOverlaySeries } from './overlays';

describe('blockIndicatorOverlays', () => {
  it('draws each distinct indicator of the default workspace once (SMA 10 and SMA 30)', () => {
    const result = compileBlocks(defaultWorkspace());
    if (!result.ok) throw new Error('default workspace must compile');
    const overlays = blockIndicatorOverlays(result.program.indicators);
    expect(overlays.map((o) => [o.label, o.pane])).toEqual([['SMA 10', 'price'], ['SMA 30', 'price']]);

    const candles = syntheticCandles(40);
    const sma = new Sma(10);
    const expected = candles.map((c) => sma.update(c.close));
    const points = computeOverlaySeries(overlays[0], candles).value;
    expect(points.map((p) => ('value' in p ? p.value : NaN))).toEqual(expected);
  });

  it('skips indicators fed by a computed series', () => {
    const overlays = blockIndicatorOverlays([
      { indicatorId: 'sma', params: { length: 5 }, source: null, drawable: false, blockId: 'a' },
      { indicatorId: 'macd', params: { fast: 12, slow: 26, signal: 9 }, source: 'close', drawable: true, blockId: 'b' },
    ]);
    expect(overlays.map((o) => [o.label, o.pane, o.lines.map((l) => l.key)])).toEqual([['MACD 12 26 9', 'sub', ['macd', 'signal', 'hist']]]);
  });
});
