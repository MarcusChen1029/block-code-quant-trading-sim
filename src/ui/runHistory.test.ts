import { describe, expect, it } from 'vitest';
import { addRun, bestRunIndex, MAX_RUNS, parseRunHistory, type RunRecord } from './runHistory';

const run = (at: number, returnPct: number): RunRecord => ({
  at, strategy: 'Your blocks', symbol: 'BTCUSDT', timeframe: '1h', startDate: '2026-07-14', returnPct, benchReturnPct: 2, maxDrawdownPct: 5, trades: 3, wiped: false,
});

describe('run history', () => {
  it('adds newest first and keeps at most MAX_RUNS', () => {
    let h: RunRecord[] = [];
    for (let i = 0; i < MAX_RUNS + 5; i++) h = addRun(h, run(i, i));
    expect(h).toHaveLength(MAX_RUNS);
    expect(h[0].at).toBe(MAX_RUNS + 4);
  });

  it('marks the best return only when there is something to compare', () => {
    expect(bestRunIndex([run(1, 5)])).toBe(-1);
    expect(bestRunIndex([run(3, -2), run(2, 9), run(1, 9)])).toBe(1);
  });

  it('drops malformed saved entries and sorts newest first', () => {
    const parsed = parseRunHistory([run(1, 1), { ...run(5, 2), returnPct: 'x' }, run(9, 3), null, { ...run(4, 1), benchReturnPct: null }]);
    expect(parsed.map((r) => r.at)).toEqual([9, 4, 1]);
    expect(parseRunHistory('nope')).toEqual([]);
  });
});
