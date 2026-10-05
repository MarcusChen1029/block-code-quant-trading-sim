import * as Blockly from 'blockly';
import { afterEach, describe, it, expect } from 'vitest';
import { BT } from '../blocks/blockTypes';
import { compileBlocks, createBlockStrategy } from '../blocks/compiler';
import { defineBlocks, defineMissingIndicatorBlocks } from '../blocks/definitions';
import { getIndicator, indicatorBlockType } from '../blocks/registry';
import { indicator, ifThen, num, price, slot, workspace } from '../blocks/testing';
import { buildToolbox } from '../blocks/toolbox';
import { fixupIndicatorBlocks } from '../blocks/workspaceFixup';
import type { BlockState } from '../blocks/workspaceState';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { blockIndicatorOverlays } from '../ui/blockOverlays';
import { computeOverlaySeries } from '../ui/overlays';
import { handleRequest } from '../worker/protocol';
import { runPine } from './compile';
import { pineIdFor, parsePineRecords, syncPineIndicators } from './library';
import { DOUBLE_EMA_SOURCE, SUPERTREND_SOURCE } from './templates';
import { compileOk } from './testing';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = syntheticCandles(600);
const DEMA = { id: 'pine_double_ema', source: DOUBLE_EMA_SOURCE };

afterEach(() => {
  syncPineIndicators([]);
});

const crosses = (op: 'over' | 'under', a: BlockState, b: BlockState): BlockState => ({
  type: BT.crosses, id: `x-${op}`, fields: { OP: op }, inputs: { A: slot(a), B: slot(b) },
});
const order = (side: 'buy' | 'sell'): BlockState => ({
  type: BT.marketOrder, id: `order-${side}`, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: slot(num(100)) },
});

/** EMA-cross strategy built either from the Pine "Double EMA" block or from two built-in EMA blocks. */
function emaCrossWorkspace(usePine: boolean) {
  const line = (which: 'fast' | 'slow') => usePine
    ? indicator('pine_double_ema', { OUT: `${which}_ema`, FASTLENGTH: 9, SLOWLENGTH: 21 })
    : indicator('ema', { LENGTH: which === 'fast' ? 9 : 21 });
  return workspace({
    onBar: [
      ifThen(crosses('over', line('fast'), line('slow')), order('buy')),
      ifThen(crosses('under', line('fast'), line('slow')), order('sell')),
    ],
  });
}

describe('Pine scripts as indicator blocks', () => {
  it('ids are slugs of the title, deduplicated; stored records are validated', () => {
    expect(pineIdFor('Double EMA', [])).toBe('pine_double_ema');
    expect(pineIdFor('Double EMA', ['pine_double_ema'])).toBe('pine_double_ema_2');
    expect(pineIdFor('$$$', [])).toBe('pine_script');
    expect(parsePineRecords([{ id: 'pine_a', source: 'x' }, { id: 'pine_a', source: 'dup' }, { id: 'sma', source: 'x' }, { id: 'pine_constructor' }, null, 3]))
      .toEqual([{ id: 'pine_a', source: 'x' }]);
    expect(parsePineRecords({ length: 1 })).toEqual([]);
  });

  it('sync registers a compiled script (params from inputs, outputs from plots, pane from overlay) and lists it in the Pine toolbox category', () => {
    const [result] = syncPineIndicators([DEMA]);
    expect(result).toMatchObject({ id: 'pine_double_ema', ok: true, title: 'Double EMA' });
    const def = getIndicator('pine_double_ema')!;
    expect(def.label).toBe('Double EMA');
    expect(def.pane).toBe('price');
    expect(def.source).toBe('close');
    expect(def.params.map((p) => [p.name, p.default, p.min, p.max, p.integer])).toEqual([['fastlength', 9, 1, 500, true], ['slowlength', 21, 1, 500, true]]);
    expect(def.outputs).toEqual([{ key: 'fast_ema', label: 'Fast EMA' }, { key: 'slow_ema', label: 'Slow EMA' }]);
    const pine = buildToolbox().contents.find((c) => c.name === 'Pine')!;
    expect(pine.contents).toEqual([expect.objectContaining({ kind: 'block', type: 'ind_pine_double_ema' })]);
    expect(buildToolbox().contents.find((c) => c.name === 'Indicators')!.contents!.some((b) => b.kind === 'block' && b.type.includes('pine'))).toBe(false);
  });

  it('sync replaces edited scripts, unregisters deleted ones and does not register scripts that fail to compile', () => {
    syncPineIndicators([DEMA]);
    const edited = DOUBLE_EMA_SOURCE.replace('plot(slow, "Slow EMA", color=color.blue)\n', '');
    syncPineIndicators([{ id: DEMA.id, source: edited }]);
    expect(getIndicator(DEMA.id)!.outputs.map((o) => o.key)).toEqual(['fast_ema']);
    const [broken] = syncPineIndicators([{ id: DEMA.id, source: '//@version=5\nindicator("x")\nplot(' }]);
    expect(broken.ok).toBe(false);
    expect(broken.errors[0]).toMatchObject({ line: 3 });
    expect(getIndicator(DEMA.id)).toBeUndefined();
    syncPineIndicators([DEMA]);
    syncPineIndicators([]);
    expect(getIndicator(DEMA.id)).toBeUndefined();
    expect(buildToolbox().contents.find((c) => c.name === 'Pine')!.contents).toEqual([{ kind: 'label', text: expect.any(String) }]);
  });

  it('END-TO-END: a workspace using the Pine block backtests deterministically and equals the built-in EMA blocks', () => {
    syncPineIndicators([DEMA]);
    const ws = emaCrossWorkspace(true);
    const compiled = compileBlocks(ws);
    expect(compiled.ok).toBe(true);
    const a = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const b = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(b.trades).toEqual(a.trades);
    expect(b.fills).toEqual(a.fills);
    const builtIn = runBacktest(CANDLES, createBlockStrategy(emaCrossWorkspace(false)), CONFIG);
    expect(a.trades).toEqual(builtIn.trades);
  });

  it('END-TO-END via the worker protocol: the worker compiles the Pine sources it is sent', () => {
    const request = { type: 'run' as const, candles: CANDLES, config: CONFIG };
    const ok = handleRequest({ ...request, strategy: { id: 'blocks', workspace: emaCrossWorkspace(true), pineScripts: [DEMA] } });
    expect(ok.type).toBe('result');
    if (ok.type === 'result') expect(ok.result.trades.length).toBeGreaterThan(3);
    expect(structuredClone(ok)).toEqual(ok);
  });

  it('a workspace referencing a missing (deleted) Pine script gives a clear error naming it, not a crash', () => {
    syncPineIndicators([]);
    const result = compileBlocks(emaCrossWorkspace(true));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].message).toBe('Pine script "double_ema" is missing: it was deleted or no longer compiles. Fix it in the Pine tab, or remove this block');
    expect(result.errors[0].blockId).toMatch(/^pine_double_ema/);
    const response = handleRequest({ type: 'run', candles: CANDLES, config: CONFIG, strategy: { id: 'blocks', workspace: emaCrossWorkspace(true), pineScripts: [] } });
    expect(response).toMatchObject({ type: 'error', message: expect.stringContaining('Pine script "double_ema" is missing') });
  });

  it('Supertrend block: SOURCE input feeds input.source, other params come from block fields', () => {
    syncPineIndicators([{ id: 'pine_supertrend', source: SUPERTREND_SOURCE }]);
    const def = getIndicator('pine_supertrend')!;
    expect(def.source).toBe('hl2');
    expect(def.params.map((p) => [p.name, p.integer ?? false])).toEqual([['atrlength', true], ['factor', false]]);
    const inst = def.create({ atrlength: 10, factor: 3 });
    const viaBlock = CANDLES.map((c) => inst.step((c.high + c.low) / 2, c).supertrend);
    expect(viaBlock).toEqual(runPine(compileOk(SUPERTREND_SOURCE), CANDLES).supertrend);
  });

  it('chart overlays draw a Pine block used in a strategy (na = gap); a throwing instance yields gaps, not a crash', () => {
    syncPineIndicators([{ id: 'pine_supertrend', source: SUPERTREND_SOURCE }]);
    const ws = workspace({ onBar: [ifThen(crosses('over', price(), indicator('pine_supertrend', { OUT: 'supertrend', ATRLENGTH: 10, FACTOR: 3 }, price('hl2'))), order('buy'))] });
    const compiled = compileBlocks(ws);
    if (!compiled.ok) throw new Error(compiled.errors[0].message);
    const [overlay] = blockIndicatorOverlays(compiled.program.indicators);
    expect(overlay.pane).toBe('price');
    expect(overlay.lines.map((l) => l.key)).toEqual(['supertrend', 'up_trend', 'down_trend']);
    const drawn = computeOverlaySeries(overlay, CANDLES);
    expect(drawn.supertrend[0]).toEqual({ time: 0 });
    expect(drawn.up_trend.some((p) => !('value' in p))).toBe(true);
    expect(drawn.supertrend.filter((p) => 'value' in p).length).toBeGreaterThan(500);
    const bad = blockIndicatorOverlays([{ ...compiled.program.indicators[0], params: { atrlength: 0, factor: 3 } }])[0];
    expect(computeOverlaySeries(bad, CANDLES.slice(0, 3)).supertrend).toEqual(CANDLES.slice(0, 3).map((c) => ({ time: c.time / 1000 })));
  });

  it('headless Blockly: a saved workspace still using a deleted Pine block loads (placeholder) and reports the missing script', () => {
    syncPineIndicators([DEMA]);
    defineBlocks();
    const saved = emaCrossWorkspace(true);
    syncPineIndicators([]);
    // A fresh realm would not know the type at all: simulate by checking the fixup + placeholder path.
    const { workspace: fixed, missingTypes } = fixupIndicatorBlocks(saved);
    expect(missingTypes).toEqual([indicatorBlockType('pine_double_ema')]);
    defineMissingIndicatorBlocks(missingTypes);
    const ws = new Blockly.Workspace();
    Blockly.serialization.workspaces.load(fixed as Record<string, unknown>, ws);
    expect(ws.getAllBlocks(false).filter((b) => b.type === 'ind_pine_double_ema')).toHaveLength(4);
    const result = compileBlocks(Blockly.serialization.workspaces.save(ws));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].message).toMatch(/Pine script "double_ema" is missing/);
    ws.dispose();
  });

  it('headless Blockly: an edited script redefines its block; fixup drops inputs/fields the new definition lacks', () => {
    syncPineIndicators([DEMA]);
    defineBlocks();
    const saved = emaCrossWorkspace(true);
    const noSource = DOUBLE_EMA_SOURCE.replace('src = input.source(close, "Source")\n', '').replaceAll('ta.ema(src,', 'ta.ema(close,')
      .replace('slowLength = input.int(21, "Slow length", minval=1, maxval=500)\n', '').replace('ta.ema(close, slowLength)', 'ta.ema(close, 21)');
    syncPineIndicators([{ id: DEMA.id, source: noSource }]);
    defineBlocks();
    expect(Blockly.Blocks['ind_pine_double_ema']).toBeDefined();
    const ws = new Blockly.Workspace();
    expect(() => Blockly.serialization.workspaces.load(saved as Record<string, unknown>, ws)).toThrow();
    ws.clear();
    const { workspace: fixed, missingTypes } = fixupIndicatorBlocks(saved);
    expect(missingTypes).toEqual([]);
    Blockly.serialization.workspaces.load(fixed as Record<string, unknown>, ws);
    const block = ws.getAllBlocks(false).find((b) => b.type === 'ind_pine_double_ema')!;
    expect(block.getInput('SOURCE')).toBeNull();
    expect(block.getField('SLOWLENGTH')).toBeNull();
    expect(compileBlocks(Blockly.serialization.workspaces.save(ws)).ok).toBe(true);
    ws.dispose();
  });
});
