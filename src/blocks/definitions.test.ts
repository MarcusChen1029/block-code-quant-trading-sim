import * as Blockly from 'blockly';
import { describe, it, expect, beforeAll } from 'vitest';
import { runBacktest } from '../engine/engine';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { BT } from './blockTypes';
import { compileBlocks, createBlockStrategy } from './compiler';
import { defaultWorkspace } from './defaultWorkspace';
import { defineBlocks } from './definitions';
import { listIndicators, indicatorBlockType } from './registry';
import { buildToolbox } from './toolbox';
import type { BlockState } from './workspaceState';

/** Runs the real Blockly (headless, via jsdom) to check definitions, default workspace and toolbox agree. */
beforeAll(() => defineBlocks());

function countBlocks(blocks: BlockState[] = []): number {
  let n = 0;
  const visit = (b: BlockState | undefined) => {
    if (!b) return;
    n++;
    for (const conn of Object.values(b.inputs ?? {})) visit(conn.block ?? conn.shadow);
    visit(b.next?.block);
  };
  blocks.forEach(visit);
  return n;
}

describe('Blockly definitions (headless Blockly 13)', () => {
  it('every custom and indicator block type is defined', () => {
    for (const type of [...Object.values(BT), ...listIndicators().map((d) => indicatorBlockType(d.id))]) {
      expect(Blockly.Blocks[type], type).toBeDefined();
    }
  });

  it('the default workspace loads without losing blocks, and the re-saved JSON still trades identically', () => {
    const ws = new Blockly.Workspace();
    const original = defaultWorkspace();
    Blockly.serialization.workspaces.load(original as Record<string, unknown>, ws);
    expect(ws.getAllBlocks(false).length).toBe(countBlocks(original.blocks?.blocks));
    const saved = Blockly.serialization.workspaces.save(ws);
    const compiled = compileBlocks(saved);
    expect(compiled.ok).toBe(true);
    const candles = syntheticCandles(400);
    const config = { symbol: 'BTCUSDT', timeframe: '1h' as const, broker: DEFAULT_BROKER_CONFIG };
    expect(runBacktest(candles, createBlockStrategy(saved), config).trades).toEqual(
      runBacktest(candles, createBlockStrategy(original), config).trades,
    );
    ws.dispose();
  });

  it('every toolbox block is understood by the generator', () => {
    const ws = new Blockly.Workspace();
    const unsupported: string[] = [];
    for (const category of buildToolbox().contents) {
      for (const item of category.contents ?? []) {
        if (item.kind !== 'block' || item.type === BT.start || item.type === BT.bar) continue;
        const { kind: _kind, ...state } = item;
        const block = Blockly.serialization.blocks.append(state as Blockly.serialization.blocks.State, ws);
        const saved = Blockly.serialization.blocks.save(block) as BlockState;
        const isValue = block.outputConnection !== null;
        const body = isValue ? { type: BT.log, id: 'wrap', inputs: { MSG: { block: saved } } } : saved;
        const result = compileBlocks({ blocks: { blocks: [{ type: BT.bar, id: 'hat', next: { block: body } }] } });
        const problems = result.ok ? [] : result.errors.filter((e) => !/slot is empty/.test(e.message));
        if (problems.length > 0) unsupported.push(`${item.type}: ${problems.map((p) => p.message).join('; ')}`);
      }
    }
    expect(unsupported).toEqual([]);
    ws.dispose();
  });
});

describe('toolbox category help', () => {
  it('describes every category in the toolbox', async () => {
    const { buildToolbox, CATEGORY_HELP } = await import('./toolbox');
    for (const c of buildToolbox().contents) expect(CATEGORY_HELP[c.name], c.name).toBeTruthy();
  });
});
