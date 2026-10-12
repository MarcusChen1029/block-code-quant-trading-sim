import { describe, expect, it } from 'vitest';
import type { Trade } from '../engine/types';
import { buildStrategyFile, datedFileName, newPineScripts, parseStrategyFile, tradesToCsv } from './exportFiles';

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: 'long', qty: 0.5, entryTime: Date.UTC(2026, 0, 2, 3), entryPrice: 100, exitTime: Date.UTC(2026, 0, 2, 5), exitPrice: 110,
  grossPnl: 5, fees: 0.1, netPnl: 4.9, exitReason: 'takeProfit', ...over,
} as Trade);

describe('trades CSV', () => {
  it('writes a header and one row per trade with UTC times', () => {
    const csv = tradesToCsv([trade(), trade({ side: 'short', netPnl: -2 })]);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines[0]).toBe('#,side,entry_time_utc,entry_price,exit_time_utc,exit_price,qty,net_pnl,exit_by');
    expect(lines[1]).toBe('1,long,2026-01-02T03:00:00.000Z,100,2026-01-02T05:00:00.000Z,110,0.5,4.9,takeProfit');
    expect(lines[2].startsWith('2,short,')).toBe(true);
    expect(lines).toHaveLength(3);
  });
});

describe('strategy file', () => {
  const pine = [{ id: 'pine_abc123', source: '//@version=5\nindicator("x")\nplot(close)' }];

  it('round-trips the blocks and Pine scripts', () => {
    const file = buildStrategyFile({ blocks: { blocks: [] } }, pine, Date.UTC(2026, 9, 12));
    const parsed = parseStrategyFile(JSON.stringify(file));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.file.workspace).toEqual({ blocks: { blocks: [] } });
      expect(parsed.file.savedAt).toBe('2026-10-12T00:00:00.000Z');
    }
  });

  it('explains what is wrong with other files', () => {
    expect(parseStrategyFile('not json')).toMatchObject({ ok: false, error: expect.stringContaining('not valid JSON') });
    expect(parseStrategyFile('{"a":1}')).toMatchObject({ ok: false, error: expect.stringContaining('Export strategy') });
    expect(parseStrategyFile('{"kind":"quant-sim/strategy","version":99,"workspace":{}}')).toMatchObject({ ok: false, error: expect.stringContaining('newer version') });
    expect(parseStrategyFile('{"kind":"quant-sim/strategy","version":1,"workspace":[]}')).toMatchObject({ ok: false, error: expect.stringContaining('no blocks') });
  });

  it('keeps only Pine scripts this browser does not have', () => {
    expect(newPineScripts(pine, [...pine, { id: 'pine_new999', source: 's' }]).map((r) => r.id)).toEqual(['pine_new999']);
  });

  it('names files by date', () => {
    expect(datedFileName('quant-sim-trades', 'csv', Date.UTC(2026, 9, 12, 23))).toBe('quant-sim-trades-2026-10-12.csv');
  });
});
