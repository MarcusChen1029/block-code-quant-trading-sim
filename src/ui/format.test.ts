import { describe, it, expect } from 'vitest';
import type { Stats } from '../engine/stats';
import { fmtNum, fmtPct, fmtTime, statsRows } from './format';

describe('formatting', () => {
  it('formats numbers, percents and special values', () => {
    expect(fmtNum(12345.678)).toBe('12,345.68');
    expect(fmtNum(NaN)).toBe('—');
    expect(fmtNum(Infinity)).toBe('∞');
    expect(fmtPct(-3.14159)).toBe('-3.14%');
    expect(fmtPct(NaN)).toBe('—');
  });

  it('formats times in UTC', () => {
    expect(fmtTime(Date.parse('2026-10-05T07:30:00Z'))).toBe('2026-10-05 07:30');
  });
});

describe('statsRows', () => {
  it('lists every stat in display order with tones', () => {
    const stats: Stats = {
      initialEquity: 10000, finalEquity: 11000, netProfit: 1000, totalReturnPct: 10, maxDrawdownPct: 5,
      winRatePct: 50, profitFactor: 1.5, sharpe: NaN, tradeCount: 4, exposurePct: 75,
    };
    expect(statsRows(stats)).toEqual([
      { label: 'Total return', value: '10.00%', tone: 'pos' },
      { label: 'Net profit', value: '1,000.00', tone: 'pos' },
      { label: 'Final equity', value: '11,000.00', tone: 'neutral' },
      { label: 'Max drawdown', value: '5.00%', tone: 'neg' },
      { label: 'Win rate', value: '50.00%', tone: 'neutral' },
      { label: 'Profit factor', value: '1.50', tone: 'pos' },
      { label: 'Sharpe', value: '—', tone: 'neutral' },
      { label: 'Trades', value: '4', tone: 'neutral' },
      { label: 'Exposure', value: '75.00%', tone: 'neutral' },
    ]);
  });
});
