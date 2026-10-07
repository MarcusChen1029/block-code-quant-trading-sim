import { describe, it, expect } from 'vitest';
import { syntheticCandles } from '../engine/syntheticCandles';
import { BollingerBands } from '../indicators/bands';
import { Rsi } from '../indicators/oscillators';
import { getIndicator } from './registry';

/** Regression tests for review findings on the signals feature (one describe per finding). */

const CANDLES = syntheticCandles(600).map((c, i) => ({ ...c, close: c.close + (i % 11) * 0.4 - 2 }));
const crossUp = (a: number[], b: number[]) => a.map((v, i) => (i > 0 && a[i - 1] <= b[i - 1] && v > b[i] ? 1 : 0));
const crossDown = (a: number[], b: number[]) => a.map((v, i) => (i > 0 && a[i - 1] >= b[i - 1] && v < b[i] ? 1 : 0));

describe('finding 6: Bollinger breakouts are described and coloured neutrally (not as buy / sell)', () => {
  it('labels describe the event; markers are neutral triangles (up above the bar, down below it)', () => {
    const signals = getIndicator('bb')!.signals!;
    expect(signals.map((s) => [s.key, s.label])).toEqual([['above_upper', 'Close above upper band'], ['below_lower', 'Close below lower band']]);
    expect(signals.map((s) => s.marker)).toEqual([
      { shape: 'arrowUp', location: 'aboveBar', color: '#42a5f5', text: 'Above upper' },
      { shape: 'arrowDown', location: 'belowBar', color: '#42a5f5', text: 'Below lower' },
    ]);
  });
});

describe('finding 1: Bollinger signals cross the SOURCE value, not the close', () => {
  const run = (src: number[]) => {
    const inst = getIndicator('bb')!.create({ length: 20, mult: 2 });
    return CANDLES.map((c, i) => inst.step(src[i], c));
  };
  const reference = (src: number[]) => {
    const bb = new BollingerBands(20, 2);
    const bands = src.map((v) => bb.update(v));
    return { up: crossUp(src, bands.map((b) => b.upper)), down: crossDown(src, bands.map((b) => b.lower)) };
  };

  it('SOURCE = open: the bands and the cross use the same series', () => {
    const opens = CANDLES.map((c) => c.open);
    const out = run(opens);
    const ref = reference(opens);
    expect(out.map((o) => o.above_upper)).toEqual(ref.up);
    expect(out.map((o) => o.below_lower)).toEqual(ref.down);
  });

  it('SOURCE = RSI (0-100): signals follow RSI crossing its own bands, never price vs RSI bands', () => {
    const rsi = new Rsi(14);
    const r = CANDLES.map((c) => rsi.update(c.close));
    const out = run(r);
    const ref = reference(r);
    expect(out.map((o) => o.above_upper)).toEqual(ref.up);
    expect(out.map((o) => o.below_lower)).toEqual(ref.down);
  });

  it('default SOURCE = close is unchanged', () => {
    const closes = CANDLES.map((c) => c.close);
    const out = run(closes);
    const ref = reference(closes);
    expect(out.map((o) => o.above_upper)).toEqual(ref.up);
    expect(ref.up.filter(Boolean).length + ref.down.filter(Boolean).length).toBeGreaterThan(1);
  });
});
