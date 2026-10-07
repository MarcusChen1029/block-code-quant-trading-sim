import * as Blockly from 'blockly';
import { afterEach, describe, it, expect } from 'vitest';
import { syntheticCandles } from '../engine/syntheticCandles';
import { BollingerBands } from '../indicators/bands';
import { Rsi } from '../indicators/oscillators';
import { syncPineIndicators } from '../pine/library';
import { compileBlocks } from './compiler';
import { defineBlocks } from './definitions';
import { getIndicator } from './registry';
import { indicator, log, signal, workspace } from './testing';
import { fixupIndicatorBlocks } from './workspaceFixup';

/** Regression tests for review findings on the signals feature (one describe per finding). */

const pine = (title: string, signals: string[], plots: string[] = []) => `//@version=5
indicator("${title}")
${plots.map((p) => `plot(close, "${p}")`).join('\n')}
${signals.map((s) => `plotshape(close > open, "${s}")`).join('\n')}
`;

describe('finding 2: a renamed / removed signal or output never silently rewires a saved block', () => {
  afterEach(() => syncPineIndicators([]));

  const sigWs = (key: string | undefined) => workspace({ onBar: [log(signal('pine_s', key ?? 'x', {}, null))] });
  const firstError = (ws: unknown) => {
    const r = compileBlocks(ws);
    return r.ok ? null : r.errors[0];
  };

  it('a SIGOUT value that does not exist (no fixup) or a missing SIGOUT is a compile error naming the block', () => {
    syncPineIndicators([{ id: 'pine_s', source: pine('Arrows', ['Up', 'Down']) }]);
    const unknown = sigWs('gone');
    expect(firstError(unknown)).toEqual({ message: expect.stringMatching(/^Arrows: signal "gone" does not exist/), blockId: expect.stringMatching(/^sig-pine_s/) });
    const missing = sigWs(undefined);
    delete (missing.blocks!.blocks![0].next!.block!.inputs!.MSG.block!.fields as Record<string, unknown>).SIGOUT;
    expect(firstError(missing)?.message).toMatch(/^Arrows: no signal is chosen/);
  });

  it('renaming "Up" to "Up arrow": after the editor fixup (and a Blockly load/save) the block errors with the old title', () => {
    syncPineIndicators([{ id: 'pine_s', source: pine('Arrows', ['Up', 'Down']) }]);
    defineBlocks();
    const ws = sigWs('up');
    expect(compileBlocks(ws).ok).toBe(true);
    syncPineIndicators([{ id: 'pine_s', source: pine('Arrows', ['Up arrow', 'Down']) }]);
    defineBlocks();
    const fixed = fixupIndicatorBlocks(ws).workspace;
    // Through real Blockly: the dropdown falls back to its first option, the stale choice must survive anyway.
    const bw = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(fixed as Record<string, unknown>, bw);
    const saved = Blockly.serialization.workspaces.save(bw);
    bw.dispose();
    const err = firstError(saved);
    expect(err?.message).toBe('Arrows: signal "Up" no longer exists in the script (renamed or removed): choose a signal in this block');
    expect(err?.blockId).toMatch(/^sig-pine_s/);
    // Renamed back: the old choice is restored and it compiles again.
    syncPineIndicators([{ id: 'pine_s', source: pine('Arrows', ['Up', 'Down']) }]);
    defineBlocks();
    const restored = fixupIndicatorBlocks(saved).workspace as typeof ws;
    const block = restored.blocks!.blocks![0].next!.block!.inputs!.MSG.block!;
    expect(block.fields?.SIGOUT).toBe('up');
    expect(compileBlocks(restored).ok).toBe(true);
  });

  it('the same holds for a numeric output dropdown (plot "Fast" renamed to "Quick")', () => {
    syncPineIndicators([{ id: 'pine_s', source: pine('Lines', [], ['Fast', 'Slow']) }]);
    defineBlocks();
    const ws = workspace({ onBar: [log(indicator('pine_s', { OUT: 'fast' }, null))] });
    expect(compileBlocks(ws).ok).toBe(true);
    syncPineIndicators([{ id: 'pine_s', source: pine('Lines', [], ['Quick', 'Slow']) }]);
    const fixed = fixupIndicatorBlocks(ws).workspace;
    expect(firstError(fixed)?.message).toBe('Lines: output "Fast" no longer exists in the script (renamed or removed): choose an output in this block');
  });
});

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
