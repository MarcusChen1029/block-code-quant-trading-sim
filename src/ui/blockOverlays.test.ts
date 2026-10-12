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

describe('overlay legend names (lineTitle)', () => {
  it('Pine plots are named by their plot titles, not their keys; built-ins are unchanged', async () => {
    const { syncPineIndicators } = await import('../pine/library');
    const { getIndicator } = await import('../blocks/registry');
    const { SUPERTREND_SOURCE } = await import('../pine/templates');
    const { lineTitle } = await import('./overlays');
    const { defaultIndicatorUse } = await import('./blockOverlays');
    expect(syncPineIndicators([{ id: 'pine_legend_st', source: SUPERTREND_SOURCE }]).every((r) => r.ok)).toBe(true);
    const def = getIndicator('pine_legend_st')!;
    const [pine] = blockIndicatorOverlays([defaultIndicatorUse(def)]);
    expect(pine.lines.map((l) => l.key)).not.toContain('Up trend'); // keys are identifiers...
    expect(pine.lines.map((l) => lineTitle(pine, l))).toEqual(['Supertrend', 'Up trend', 'Down trend']); // ...titles are shown

    const [macd] = blockIndicatorOverlays([{ indicatorId: 'macd', params: { fast: 12, slow: 26, signal: 9 }, source: 'close', drawable: true, blockId: 'm' }]);
    expect(macd.lines.map((l) => lineTitle(macd, l))).toEqual(['macd', 'signal', 'hist']);
    const [sma] = blockIndicatorOverlays([{ indicatorId: 'sma', params: { length: 10 }, source: 'close', drawable: true, blockId: 's' }]);
    expect(sma.lines.map((l) => lineTitle(sma, l))).toEqual(['SMA 10']);
    syncPineIndicators([]); // unregister
  });

  it('Pine signals are named by their plotshape titles in the legend', async () => {
    const { syncPineIndicators } = await import('../pine/library');
    const { getIndicator } = await import('../blocks/registry');
    const { EMA_CROSS_SIGNALS_SOURCE } = await import('../pine/templates');
    const { lineTitle } = await import('./overlays');
    const { defaultIndicatorUse } = await import('./blockOverlays');
    expect(syncPineIndicators([{ id: 'pine_legend_sig', source: EMA_CROSS_SIGNALS_SOURCE }]).every((r) => r.ok)).toBe(true);
    const [o] = blockIndicatorOverlays([defaultIndicatorUse(getIndicator('pine_legend_sig')!)]);
    expect(o.lines.map((l) => lineTitle(o, l))).toEqual(['Fast EMA', 'Slow EMA']);
    expect(o.signals!.map((s) => s.label)).toEqual(['EMA cross signals 9 21: Buy', 'EMA cross signals 9 21: Sell']);
    syncPineIndicators([]);
  });
});
