import { describe, expect, it } from 'vitest';
import type { Trade } from '../engine/types';
import { csvCell, exportFileName, tradesToCsv, TRADE_CSV_HEADER } from './exportCsv';

const trade = (over: Partial<Trade> = {}): Trade => ({
  side: 'long', qty: 0.5, entryBar: 1, entryTime: Date.parse('2026-01-01T00:00:00Z'), entryPrice: 100,
  exitBar: 3, exitTime: Date.parse('2026-01-01T02:00:00Z'), exitPrice: 110, pnl: 5, fees: 0.1, netPnl: 4.9, exitReason: 'market', ...over,
});

describe('csv export', () => {
  it('quotes cells that need it and defuses spreadsheet formulas', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell(-3.5)).toBe('-3.5'); // numbers are never mistaken for formulas
    expect(csvCell(NaN)).toBe('');
  });

  it('writes a header and one row per trade', () => {
    const csv = tradesToCsv([trade(), trade({ side: 'short', netPnl: -2 })]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(TRADE_CSV_HEADER.join(','));
    expect(lines[1]).toBe('1,long,2026-01-01T00:00:00.000Z,100,2026-01-01T02:00:00.000Z,110,0.5,4.9,market');
    expect(lines[2].startsWith('2,short,')).toBe(true);
    expect(lines[2].endsWith(',-2,market')).toBe(true);
    expect(lines[3]).toBe('');
  });

  it('rounds away float noise', () => {
    const csv = tradesToCsv([trade({ entryPrice: 27834.641731335123, qty: 0.35912090034581473, netPnl: 1583.5853281945115 })]);
    expect(csv.split('\r\n')[1]).toContain(',27834.64173134,');
    expect(csv.split('\r\n')[1]).toContain(',0.3591209,1583.58532819,');
  });

  it('an empty list is just the header', () => {
    expect(tradesToCsv([])).toBe(`${TRADE_CSV_HEADER.join(',')}\r\n`);
  });

  it('builds safe file names', () => {
    expect(exportFileName('trades', ['BTCUSDT', '1h'], 'csv')).toBe('quant-sim-trades-BTCUSDT-1h.csv');
    expect(exportFileName('strategy', ['my/../strat', ''], 'json')).toBe('quant-sim-strategy-my-..-strat.json');
  });
});
