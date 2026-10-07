import * as Blockly from 'blockly';
import { afterEach, describe, it, expect } from 'vitest';
import { compileBlocks } from '../blocks/compiler';
import { defineBlocks, signalBlockJson } from '../blocks/definitions';
import { getIndicator } from '../blocks/registry';
import { log, signal, workspace } from '../blocks/testing';
import { compilePine } from './compile';
import { syncPineIndicators } from './library';
import { forbiddenReferences } from './safety';
import { fixture } from './testing';

afterEach(() => {
  syncPineIndicators([]);
});

const LS = String.fromCharCode(0x2028);
/** Pine string literal for arbitrary text (double quotes and backslashes escaped). */
const pineStr = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

const HOSTILE = [
  'say "hi"', "it's", 'back`tick`', '${globalThis.fetch}', `line${LS}sep`, '%1 %{BKY_MATH_ADDITION_SYMBOL} 50%',
  'constructor', '__proto__', 'toString', '</script><img src=x onerror=alert(1)>', 'x'.repeat(5000), '   ', '%',
];

function hostileScript(text: string): string {
  const s = pineStr(text);
  return [
    '//@version=5',
    'indicator("Hostile")',
    `plotshape(close > open, ${s}, text=${s})`,
    `plotchar(close < open, title=${s}, char=${s})`,
    `alertcondition(close > high[1], ${s}, ${s})`,
    'if close < low[1]',
    `    label.new(bar_index, low, ${s})`,
    '',
  ].join('\n');
}

describe('signal titles / texts / messages are inert data', () => {
  it.each(HOSTILE.map((t) => [t.length > 40 ? `${t.slice(0, 20)}… (${t.length} chars)` : JSON.stringify(t), t]))('%s', (_name, text) => {
    const source = hostileScript(text);
    const result = compilePine(source);
    if (text.trim() === '') {
      // Blank label text cannot name a signal: a clean error, not a crash.
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.map((e) => e.message)).toContain('label.new text must not be empty (it names the signal)');
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { script } = result;
    // Generated code never contains the user text, and references nothing forbidden.
    expect(forbiddenReferences(script.js)).toEqual([]);
    if (text.length > 3) expect(script.js.includes(text.slice(0, 12))).toBe(false);
    // Keys are unique lowercase identifiers; names are one line and bounded.
    const keys = script.signals.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of script.signals) {
      expect(s.key).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
      expect(s.key in Object.prototype).toBe(false);
      expect(s.title.length).toBeLessThanOrEqual(110);
      expect(s.title.includes(LS) || s.title.includes('\n')).toBe(false);
    }
    // It runs, registers, and its signal block defines and creates without throwing.
    const inst = script.create();
    for (const c of fixture(30)) inst.step(undefined, c);
    syncPineIndicators([{ id: 'pine_hostile', source }]);
    defineBlocks();
    const def = getIndicator('pine_hostile')!;
    expect(def.signals?.length).toBe(4);
    const json = signalBlockJson(def);
    const options = ((json.args0 as Array<Record<string, unknown>>).find((a) => a.name === 'SIGOUT')!.options as string[][]);
    expect(options.map((o) => o[1])).toEqual(keys);
    const ws = new Blockly.Workspace();
    const block = ws.newBlock('sig_pine_hostile');
    for (const key of keys) {
      block.setFieldValue(key, 'SIGOUT');
      expect(block.getFieldValue('SIGOUT')).toBe(key);
    }
    // The dropdown shows the text literally (Blockly's %-interpolation is neutralised).
    if (text.startsWith('%1')) expect((block.getField('SIGOUT') as Blockly.FieldDropdown).getText()).toContain('%1');
    ws.dispose();
    const compiled = compileBlocks(workspace({ onBar: keys.map((k) => log(signal('pine_hostile', k, {}, null))) }));
    expect(compiled.ok).toBe(true);
    if (compiled.ok) expect(forbiddenReferences(compiled.program.source)).toEqual([]);
  });
});
