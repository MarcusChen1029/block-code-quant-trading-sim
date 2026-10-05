import { describe, it, expect } from 'vitest';
import { getIndicator } from '../blocks/registry';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { handleRequest } from '../worker/protocol';
import { compilePine, runPine } from './compile';
import { syncPineIndicators } from './library';
import { DOUBLE_EMA_SOURCE } from './templates';
import { script } from './testing';

/** compilePine must return errors (never throw) however hostile the input. */
function rejects(source: string): { line: number; col: number; message: string } {
  let result;
  expect(() => { result = compilePine(source); }).not.toThrow();
  expect(result!.ok).toBe(false);
  if (result!.ok) throw new Error('unreachable');
  return result!.errors[0];
}

const DEEP = {
  sum: script(`plot(${Array(5000).fill('close').join(' + ')})`),
  and: script(`plot(${Array(5000).fill('close > 0').join(' and ')} ? 1 : 0)`),
  history: script(`x = close\nplot(x${'[1]'.repeat(20000)})`),
  member: script(`plot(close${'.a'.repeat(20000)})`),
  unary: script(`plot(${'-'.repeat(5000)}close)`),
  parens: script(`plot(${'('.repeat(5000)}close${')'.repeat(5000)})`),
  mid: script(`plot(${Array(2500).fill('close').join(' * ')})`),
};

describe('compilePine never throws on deeply nested input', () => {
  for (const [name, source] of Object.entries(DEEP)) {
    it(`${name}: a clear "nested too deeply" error with a position`, () => {
      const err = rejects(source);
      expect(err.message).toMatch(/nested too deeply \(limit \d+ levels\)/);
      expect(err.line).toBe(source.split('\n').length);
      expect(err.message).not.toMatch(/internal compiler error/);
    });
  }

  it('deeply nested if blocks are rejected cleanly', () => {
    const lines: string[] = [];
    for (let i = 0; i < 60; i++) lines.push(`${'    '.repeat(i)}if close > 0`);
    lines.push(`${'    '.repeat(60)}x = 1`);
    const err = rejects(script(`${lines.join('\n')}\nplot(close)`));
    expect(err.message).toMatch(/blocks are nested too deeply \(limit \d+ levels\)/);
  });

  it('long but reasonable expressions still compile (200 terms)', () => {
    const result = compilePine(script(`plot(${Array(200).fill('close').join(' + ')}, "s")`));
    expect(result.ok).toBe(true);
  });

  it('chains of constants do not blow up the generated code (each is bound once)', () => {
    const lines = ['c0 = 1'];
    for (let i = 1; i <= 60; i++) lines.push(`c${i} = c${i - 1} + c${i - 1}`);
    const start = Date.now();
    const result = compilePine(script(`${lines.join('\n')}\nplot(ta.sma(close, c2), "s")\nplot(c60, "big")`));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.script.js.length).toBeLessThan(20_000);
    expect(runPine(result.script, syntheticCandles(5)).big).toEqual(Array(5).fill(2 ** 60));
  });
});

describe('stored scripts are isolated', () => {
  const good = { id: 'pine_double_ema', source: DOUBLE_EMA_SOURCE };
  const hostile = [
    { id: 'pine_deep', source: DEEP.sum },
    { id: 'pine_member', source: DEEP.member },
  ];

  it('sync skips bad records with a diagnostic and still registers the good ones', () => {
    let results: ReturnType<typeof syncPineIndicators> = [];
    expect(() => { results = syncPineIndicators([...hostile, good]); }).not.toThrow();
    expect(results.map((r) => [r.id, r.ok])).toEqual([['pine_deep', false], ['pine_member', false], ['pine_double_ema', true]]);
    expect(results[0].errors[0].message).toMatch(/nested too deeply/);
    expect(getIndicator('pine_double_ema')).toBeDefined();
    syncPineIndicators([]);
  });

  it('a worker run that does not use the bad script is unaffected by it', () => {
    const response = handleRequest({
      type: 'run', candles: syntheticCandles(200), config: { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG },
      strategy: { id: 'blocks', workspace: { blocks: { blocks: [{ type: 'event_bar', id: 'hat' }] } }, pineScripts: [...hostile, good] },
    });
    expect(response.type).toBe('result');
    syncPineIndicators([]);
  });
});
