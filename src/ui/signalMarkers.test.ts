import { afterEach, describe, it, expect } from 'vitest';
import { compileBlocks } from '../blocks/compiler';
import { getIndicator } from '../blocks/registry';
import { ifThen, indicator, log, price, signal, workspace } from '../blocks/testing';
import { syntheticCandles } from '../engine/syntheticCandles';
import { Supertrend } from '../indicators/supertrend';
import { syncPineIndicators } from '../pine/library';
import { RSI_LEVELS_SOURCE } from '../pine/templates';
import { blockIndicatorOverlays, defaultIndicatorUse } from './blockOverlays';
import { fillsToMarkers, MAX_MARKERS_PER_SIGNAL, MAX_TEXT_MARKERS, mergeMarkers, signalMarkers } from './markers';
import { signalPriceKey } from './overlays';

afterEach(() => {
  syncPineIndicators([]);
});

const CANDLES = syntheticCandles(500);
const hits = (n: number) => Array.from({ length: n }, (_, i) => ({ time: i * 3_600_000, price: 100 + i }));

describe('signal markers', () => {
  it('map shape / location / colour / text; price-located markers sit at their price', () => {
    const [below] = signalMarkers({ shape: 'arrowUp', location: 'belowBar', color: '#26a69a', text: 'Buy' }, hits(1), 's');
    expect(below).toEqual({ time: 0, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', size: 0.8, id: 's@0', text: '◇ Buy' });
    const [up, down, mid] = [
      signalMarkers({ shape: 'arrowUp', location: 'price' }, hits(1), 'a')[0],
      signalMarkers({ shape: 'arrowDown', location: 'price' }, hits(1), 'b')[0],
      signalMarkers({ shape: 'circle', location: 'price' }, hits(1), 'c')[0],
    ];
    expect([up.position, down.position, mid.position]).toEqual(['atPriceBottom', 'atPriceTop', 'atPriceMiddle']);
    expect(up.price).toBe(100);
    // No price (na y): falls back to above the bar.
    expect(signalMarkers({ shape: 'circle', location: 'price' }, [{ time: 0, price: NaN }], 'd')[0].position).toBe('aboveBar');
  });

  it('long ranges: at most the most recent N per signal, and no text once a signal is dense', () => {
    const many = signalMarkers({ shape: 'circle', location: 'aboveBar', text: 'x' }, hits(MAX_MARKERS_PER_SIGNAL + 500), 'm');
    expect(many.length).toBe(MAX_MARKERS_PER_SIGNAL);
    expect(many[0].time).toBe((500 * 3_600_000) / 1000);
    expect(many.every((m) => m.text === undefined)).toBe(true);
    expect(signalMarkers({ shape: 'circle', location: 'aboveBar', text: 'x' }, hits(MAX_TEXT_MARKERS), 'm').every((m) => m.text === '◇ x')).toBe(true);
  });

  it('merging with trade markers keeps every marker, sorted by time, trades first on ties', () => {
    const fills = fillsToMarkers([
      { time: 3_600_000, bar: 1, side: 'buy', qty: 1, price: 1, fee: 0, reason: 'market', orderId: 1 },
    ]);
    const sig = signalMarkers({ shape: 'arrowDown', location: 'aboveBar', text: 'Sell' }, hits(3), 's');
    const merged = mergeMarkers(fills, sig);
    expect(merged.length).toBe(4);
    expect(merged.map((m) => m.time)).toEqual([0, 3600, 3600, 7200]);
    expect(merged[1].text).toBe('Buy');
  });
});

describe('overlays with signals', () => {
  it('a sig_ block draws its indicator (lines) and marks the signal it uses; ind_ + sig_ of the same settings share one overlay', () => {
    const ws = workspace({
      onBar: [
        log(indicator('supertrend', { OUT: 'line', LENGTH: 10, FACTOR: 3 }, price('hl2'))),
        ifThen(signal('supertrend', 'buy', { LENGTH: 10, FACTOR: 3 }, price('hl2')), log(price())),
        ifThen(signal('supertrend', 'sell', { LENGTH: 10, FACTOR: 3 }, price('hl2')), log(price())),
      ],
    });
    const result = compileBlocks(ws);
    if (!result.ok) throw new Error(result.errors[0].message);
    const overlays = blockIndicatorOverlays(result.program.indicators);
    expect(overlays.map((o) => [o.label, o.pane, o.lines.map((l) => l.key), o.signals?.map((s) => s.key)])).toEqual([
      ['Supertrend 10 3', 'price', ['line', 'direction'], ['buy', 'sell']],
    ]);
    const step = overlays[0].create();
    const st = new Supertrend(10, 3);
    for (const c of CANDLES) {
      const v = step(c);
      const ref = st.update((c.high + c.low) / 2, c);
      expect(v.buy).toBe(ref.flippedUp ? 1 : 0);
      expect(v.sell).toBe(ref.flippedDown ? 1 : 0);
    }
    expect(overlays[0].signals![0].label).toBe('Supertrend 10 3: Buy (trend flips up)');
  });

  it('RSI numeric + signal blocks: one RSI pane; the levels do not split it, other levels do', () => {
    const rsi = (fields: Record<string, number>) => signal('rsi', 'up_oversold', { LENGTH: 14, ...fields });
    const ws = workspace({ onBar: [log(indicator('rsi', { LENGTH: 14 })), ifThen(rsi({}), log(price())), ifThen(rsi({ OVERSOLD: 20 }), log(price()))] });
    const result = compileBlocks(ws);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(blockIndicatorOverlays(result.program.indicators).map((o) => [o.label, o.signals?.length ?? 0])).toEqual([['RSI 14', 1], ['RSI 14', 1]]);
  });

  it('"Show on chart" use of a Pine script: defaults, every signal, label y reported as the marker price', () => {
    syncPineIndicators([{ id: 'pine_rsi_levels', source: RSI_LEVELS_SOURCE }]);
    const def = getIndicator('pine_rsi_levels')!;
    const [overlay] = blockIndicatorOverlays([defaultIndicatorUse(def)]);
    expect(overlay.pane).toBe('sub');
    expect(overlay.signals?.map((s) => s.key)).toEqual(['rsi_left_oversold', 'rsi_left_overbought', 'buy', 'sell']);
    const step = overlay.create();
    let labelled = 0;
    for (const c of CANDLES) {
      const v = step(c);
      if (v.buy === 1) {
        labelled++;
        expect(v[signalPriceKey('buy')]).toBe(v.rsi);
        expect(v[signalPriceKey('buy')]).toBeGreaterThan(30);
      }
    }
    expect(labelled).toBeGreaterThan(0);
  });
});
