import { describe, expect, it } from 'vitest';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { MAX_STRATEGY_FILE_BYTES, parseStrategyFile, serializeStrategy, strategyLabelFromFileName } from './strategyFile';

describe('strategy files', () => {
  it('round-trips a workspace', () => {
    const ws = defaultWorkspace();
    const text = serializeStrategy(ws, Date.parse('2026-10-12T00:00:00Z'));
    expect(text).toContain('"app": "quant-sim"');
    expect(text).toContain('2026-10-12T00:00:00.000Z');
    expect(parseStrategyFile(text)).toEqual({ ok: true, workspace: JSON.parse(JSON.stringify(ws)) });
  });

  it('accepts a bare Blockly workspace', () => {
    const ws = JSON.parse(JSON.stringify(defaultWorkspace()));
    expect(parseStrategyFile(JSON.stringify(ws))).toEqual({ ok: true, workspace: ws });
  });

  it('explains what is wrong with other files', () => {
    const bad = (text: string) => {
      const r = parseStrategyFile(text);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(bad('hello')).toMatch(/not valid JSON/);
    expect(bad('[1,2]')).toMatch(/not a strategy file/);
    expect(bad('{"a":1}')).toMatch(/not a Quant Sim strategy/);
    expect(bad('{"app":"quant-sim","kind":"other"}')).toMatch(/does not hold blocks/);
    expect(bad('{"app":"quant-sim","kind":"blocks-workspace","version":1,"workspace":{}}')).toMatch(/no blocks/);
    expect(bad('{"app":"quant-sim","kind":"blocks-workspace","version":99,"workspace":{"blocks":{"blocks":[]}}}')).toMatch(/newer version/);
    expect(bad('x'.repeat(MAX_STRATEGY_FILE_BYTES + 1))).toMatch(/too big/);
  });

  it('names the opened file for the status line', () => {
    expect(strategyLabelFromFileName('My robot.json')).toBe('My robot');
    expect(strategyLabelFromFileName('.json')).toBe('Opened file');
    expect(strategyLabelFromFileName('a'.repeat(100) + '.json')).toHaveLength(60);
  });
});
