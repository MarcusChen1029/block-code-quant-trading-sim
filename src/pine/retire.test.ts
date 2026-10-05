import * as Blockly from 'blockly';
import { afterEach, describe, it, expect } from 'vitest';
import { compileBlocks } from '../blocks/compiler';
import { defineBlocks, defineMissingIndicatorBlocks } from '../blocks/definitions';
import { getIndicator } from '../blocks/registry';
import { indicator, log, workspace } from '../blocks/testing';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { handleRequest } from '../worker/protocol';
import { newPineScriptId, parsePineRetired, retirePineScript, syncPineIndicators, type PineRetired, type PineSourceRecord } from './library';

const rsi = (title: string, length: number) =>
  `//@version=5\nindicator("${title}")\nlen = input.int(${length}, "Length", minval=1, maxval=100)\nplot(ta.rsi(close, len), "RSI")\n`;

afterEach(() => {
  syncPineIndicators([]);
});

/** Delete the script with `id`, then create a new one titled like it (what the Pine tab does). */
function deleteThenRecreate(records: PineSourceRecord[], retired: PineRetired[], id: string, source: string) {
  const after = retirePineScript(records, retired, id);
  const newId = newPineScriptId('RSI', after.records, after.retired);
  return { records: [...after.records, { id: newId, source }], retired: after.retired, newId };
}

describe('deleted Pine script ids are retired, never reused', () => {
  it('a new script titled like a deleted one gets a fresh id; old blocks stay "missing" and name the old title', () => {
    const first: PineSourceRecord[] = [{ id: 'pine_rsi', source: rsi('RSI', 14) }];
    syncPineIndicators(first);
    const oldBlocks = workspace({ onBar: [log(indicator('pine_rsi', { LEN: 14 }))] });
    expect(compileBlocks(oldBlocks).ok).toBe(true);

    const next = deleteThenRecreate(first, [], 'pine_rsi', rsi('RSI', 7));
    expect(next.newId).toBe('pine_rsi_2');
    expect(next.retired).toEqual([{ id: 'pine_rsi', title: 'RSI' }]);
    syncPineIndicators(next.records, next.retired);

    expect(getIndicator('pine_rsi')).toBeUndefined();
    expect(getIndicator('pine_rsi_2')?.params[0].default).toBe(7);
    const result = compileBlocks(oldBlocks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toBe('Pine script "RSI" is missing: it was deleted or no longer compiles. Fix it in the Pine tab, or remove this block');
    }
  });

  it('ids stay retired across repeated delete / re-create cycles', () => {
    let records: PineSourceRecord[] = [{ id: 'pine_rsi', source: rsi('RSI', 14) }];
    let retired: PineRetired[] = [];
    const ids: string[] = ['pine_rsi'];
    for (let i = 0; i < 3; i++) {
      const next = deleteThenRecreate(records, retired, ids[ids.length - 1], rsi('RSI', 10 + i));
      records = next.records;
      retired = next.retired;
      ids.push(next.newId);
    }
    expect(ids).toEqual(['pine_rsi', 'pine_rsi_2', 'pine_rsi_3', 'pine_rsi_4']);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the placeholder block for a deleted script shows its last title (escaped)', () => {
    syncPineIndicators([], [{ id: 'pine_fast', title: 'Fast %1' }]);
    defineBlocks();
    defineMissingIndicatorBlocks(['ind_pine_fast']);
    const ws = new Blockly.Workspace();
    const block = ws.newBlock('ind_pine_fast');
    expect(block.inputList.flatMap((i) => i.fieldRow.map((f) => f.getText())).join(' ')).toBe('⚠ missing Pine script "Fast %1"');
    ws.dispose();
  });

  it('the worker gets the tombstones with the run and names the deleted script by title', () => {
    const response = handleRequest({
      type: 'run', candles: syntheticCandles(50), config: { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG },
      strategy: {
        id: 'blocks', workspace: workspace({ onBar: [log(indicator('pine_rsi', { LEN: 14 }))] }),
        pineScripts: [{ id: 'pine_rsi_2', source: rsi('RSI', 7) }], pineRetired: [{ id: 'pine_rsi', title: 'RSI' }],
      },
    });
    expect(response).toMatchObject({ type: 'error', message: expect.stringContaining('Pine script "RSI" is missing') });
  });

  it('a stored script that no longer compiles is named by its title too; tombstones from storage are validated', () => {
    syncPineIndicators([{ id: 'pine_broken', source: '//@version=5\nindicator("My Broken One")\nplot(' }]);
    const result = compileBlocks(workspace({ onBar: [log(indicator('pine_broken', {}, null))] }));
    expect(!result.ok && result.errors[0].message).toMatch(/^Pine script "My Broken One" is missing/);
    expect(parsePineRetired([{ id: 'pine_a', title: 'A' }, { id: 'x', title: 'B' }, { id: 'pine_b' }, 'junk'])).toEqual([{ id: 'pine_a', title: 'A' }]);
  });
});
