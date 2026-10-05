import { describe, it, expect } from 'vitest';
import { computeStats } from './stats';
import type { Trade } from './types';

function trade(netPnl: number): Trade {
  return {
    side: 'long', qty: 1, entryBar: 0, entryTime: 0, entryPrice: 100, exitBar: 1, exitTime: 1,
    exitPrice: 100 + netPnl, pnl: netPnl, fees: 0, netPnl, exitReason: 'market',
  };
}

const DAY = 86_400_000;

describe('computeStats', () => {
  it('matches hand-computed values', () => {
    const s = computeStats({
      initialEquity: 100,
      equityCurve: [{ time: 0, equity: 110 }, { time: DAY, equity: 99 }, { time: 2 * DAY, equity: 121 }],
      trades: [trade(10), trade(-5), trade(15)],
      barsInPosition: 2,
      timeframe: '1d',
    });
    expect(s.finalEquity).toBe(121);
    expect(s.netProfit).toBe(21);
    expect(s.totalReturnPct).toBeCloseTo(21, 10);
    expect(s.maxDrawdownPct).toBeCloseTo(10, 10); // peak 110 -> 99
    expect(s.winRatePct).toBeCloseTo(66.666667, 5); // 2 of 3
    expect(s.profitFactor).toBeCloseTo(5, 10); // 25 / 5
    // returns 0.1, -0.1, 0.222222: mean 0.0740741, sample sd 0.1626681, x sqrt(365)
    expect(s.sharpe).toBeCloseTo(8.699821, 5);
    expect(s.tradeCount).toBe(3);
    expect(s.exposurePct).toBeCloseTo(66.666667, 5);
  });

  it('reports undefined ratios as NaN and no-loss profit factor as Infinity', () => {
    const none = computeStats({ initialEquity: 100, equityCurve: [{ time: 0, equity: 100 }], trades: [], barsInPosition: 0, timeframe: '1h' });
    expect(none.winRatePct).toBeNaN();
    expect(none.profitFactor).toBeNaN();
    expect(none.sharpe).toBeNaN();
    expect(none.maxDrawdownPct).toBe(0);

    const allWins = computeStats({ initialEquity: 100, equityCurve: [], trades: [trade(1)], barsInPosition: 0, timeframe: '1h' });
    expect(allWins.profitFactor).toBe(Infinity);
    expect(allWins.exposurePct).toBe(0);
  });
});
