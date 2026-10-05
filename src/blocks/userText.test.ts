import * as Blockly from 'blockly';
import { afterEach, describe, it, expect } from 'vitest';
import { syncPineIndicators } from '../pine/library';
import { blocklyText, defineBlocks, indicatorBlockJson } from './definitions';
import { getIndicator } from './registry';
import { loadWorkspaceSafely } from './workspaceLoad';

/** Pine titles reach Blockly message strings: `%1`, `%{BKY_..}` and newlines must be inert. */
const HOSTILE = `//@version=5
indicator("Fast %1 %{BKY_MATH_ADDITION_SYMBOL} 100%")
len = input.int(9, "Len %2 50%", minval=1, maxval=50)
plot(ta.ema(close, len), "Line %1")
plot(ta.sma(close, len), "Other %%")
`;

afterEach(() => {
  syncPineIndicators([]);
});

function textOf(block: Blockly.Block): string {
  return block.inputList.flatMap((input) => input.fieldRow.map((f) => f.getText())).join(' ');
}

describe('user text in Blockly blocks', () => {
  it('blocklyText doubles % and flattens line breaks', () => {
    expect(blocklyText('Fast %1\nx 50%')).toBe('Fast %%1 x 50%%');
  });

  it('a Pine block titled "Fast %1" defines, renders its title literally and keeps every field', () => {
    syncPineIndicators([{ id: 'pine_fast', source: HOSTILE }]);
    defineBlocks();
    const ws = new Blockly.Workspace();
    const block = ws.newBlock('ind_pine_fast');
    const text = textOf(block);
    expect(text).toContain('Fast %1 %{BKY_MATH_ADDITION_SYMBOL} 100%');
    expect(text).toContain('Len %2 50%');
    expect(block.getField('LEN')).not.toBeNull();
    expect(block.getInput('SOURCE')).toBeNull(); // no input.source in this script
    const out = block.getField('OUT') as Blockly.FieldDropdown;
    expect(out.getOptions(false).map((o) => o[0])).toEqual(['Line %1', 'Other %%']);
    expect(block.getTooltip()).not.toMatch(/%%/);
    ws.dispose();
  });

  it('built-in labels containing % (Stochastic "%K length") render correctly', () => {
    defineBlocks();
    const ws = new Blockly.Workspace();
    const block = ws.newBlock('ind_stoch');
    expect(textOf(block)).toMatch(/^Stochastic %K %K length 14 smooth 1 %D length 3$/);
    ws.dispose();
    expect(JSON.stringify(indicatorBlockJson(getIndicator('stoch')!).args0)).toContain('"text":"%%K length"');
  });

  it('a workspace that fails to load leaves the target workspace untouched', () => {
    defineBlocks();
    const ws = new Blockly.Workspace();
    const good = { blocks: { languageVersion: 0, blocks: [{ type: 'math_number', id: 'keep-me', fields: { NUM: 7 } }] } };
    expect(loadWorkspaceSafely(ws, good)).toEqual({ ok: true });
    const bad = { blocks: { languageVersion: 0, blocks: [{ type: 'math_number', id: 'n', inputs: { NOPE: { block: { type: 'math_number' } } } }] } };
    const result = loadWorkspaceSafely(ws, bad);
    expect(result.ok).toBe(false);
    expect(ws.getAllBlocks(false).map((b) => b.id)).toEqual(['keep-me']);
    const unknownType = { blocks: { languageVersion: 0, blocks: [{ type: 'no_such_block', id: 'x' }] } };
    expect(loadWorkspaceSafely(ws, unknownType).ok).toBe(false);
    expect(ws.getAllBlocks(false).map((b) => b.id)).toEqual(['keep-me']);
    ws.dispose();
  });
});
