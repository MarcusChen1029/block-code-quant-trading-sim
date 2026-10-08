import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { buyAndHold } from './benchmark';
import { Engine, runBacktest, type EngineConfig } from './engine';
import { candlesFromCloses } from './fixtures';
import type { Strategy } from './strategy';
import { syntheticCandles } from './syntheticCandles';
import { DEFAULT_BROKER_CONFIG, type BrokerConfig } from './types';

const HOUR = 3_600_000;
const bar = (i: number, open: number, close: number): Candle => ({ time: i * HOUR, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 });
const BROKER: BrokerConfig = { initialBalance: 10_000, leverage: 1, takerFee: 0.0004, makerFee: 0.0002, slippageBps: 2 };

describe('buyAndHold', () => {
  it("enters at the SECOND bar's open (first fillable) + slippage with the taker fee, all-in; bar 0 is flat", () => {
    const b = buyAndHold([bar(0, 100, 100), bar(1, 100, 110), bar(2, 110, 99)], BROKER)!;
    // entry = bar 1 open 100 x 1.0002 = 100.02; qty = 10000 / (100.02 x 1.0004) = 99.9400279...
    expect(b.entryPrice).toBeCloseTo(100.02, 12);
    expect(b.qty).toBeCloseTo(99.9400279, 6);
    expect(b.entryFee).toBeCloseTo(3.99840064, 7); // = 10000 x 0.0004 / 1.0004
    expect(b.qty * b.entryPrice + b.entryFee).toBeCloseTo(10_000, 9); // notional + fee = starting balance
    expect(b.equityCurve.map((p) => p.time)).toEqual([0, HOUR, 2 * HOUR]); // same length / times as the strategy
    expect(b.equityCurve[0].equity).toBe(10_000); // nothing could be bought before bar 1
    expect(b.equityCurve[1].equity).toBeCloseTo(10993.403, 3);
    expect(b.equityCurve[2].equity).toBeCloseTo(9894.0628, 3);
    expect(b.finalEquity).toBe(b.equityCurve[2].equity); // no exit fee
    expect(b.returnPct).toBeCloseTo(-1.05937, 4);
    expect(b.maxDrawdownPct).toBeCloseTo(10, 9); // 110 -> 99 is exactly -10% of the peak
    expect(b.initialEquity).toBe(10_000);
  });

  it("two bars: enters at bar 1's open, not bar 0's", () => {
    const b = buyAndHold([bar(0, 100, 110), bar(1, 110, 99)], BROKER)!;
    // entry 110 x 1.0002 = 110.022; qty = 10000 / (110.022 x 1.0004) = 90.8545709; equity = qty x 99
    expect(b.entryPrice).toBeCloseTo(110.022, 12);
    expect(b.qty).toBeCloseTo(90.8545709, 6);
    expect(b.equityCurve.map((p) => p.equity)).toEqual([10_000, b.qty * 99]);
    expect(b.finalEquity).toBeCloseTo(8994.6025189, 6);
    expect(b.returnPct).toBeCloseTo(-10.0539748, 6);
    expect(b.maxDrawdownPct).toBeCloseTo(10.0539748, 6);
  });

  it('ignores the maker fee', () => {
    const a = buyAndHold([bar(0, 100, 110), bar(1, 110, 99)], BROKER)!;
    const b = buyAndHold([bar(0, 100, 110), bar(1, 110, 99)], { ...BROKER, makerFee: 0.01 })!;
    expect(b).toEqual(a);
    expect(a.leverage).toBe(1);
    expect(a.wiped).toBe(false);
  });

  it('is sized at the account leverage like a 100% of equity order: qty = balance / (entry x (1/L + fee))', () => {
    const b = buyAndHold([bar(0, 100, 110), bar(1, 110, 99)], { ...BROKER, leverage: 2 })!;
    // entry 110.022; qty = 10000 / (110.022 x 0.5004) = 181.6365162; fee = 10000 x 0.0004 / 0.5004 = 7.9936051
    expect(b.qty).toBeCloseTo(181.6365162, 6);
    expect(b.entryFee).toBeCloseTo(7.9936051, 6);
    // equity = (10000 - fee) + qty x (99 - 110.022)
    expect(b.equityCurve.map((p) => p.equity)[0]).toBe(10_000);
    expect(b.finalEquity).toBeCloseTo(7990.0087129, 6);
    expect(b.returnPct).toBeCloseTo(-20.099912871, 6);
    expect(b.leverage).toBe(2);
    expect(b.wiped).toBe(false);
  });

  it('a leveraged hold whose equity reaches zero is closed at that close with the taker fee and stays flat', () => {
    const b = buyAndHold([bar(0, 100, 100), bar(1, 100, 80), bar(2, 80, 200)], { ...BROKER, leverage: 5 })!;
    // qty = 10000 / (100.02 x 0.2004) = 498.9022156; equity at 80 = 9996.0... - 9987.98... < 0 -> minus the exit fee
    expect(b.wiped).toBe(true);
    expect(b.equityCurve[1].equity).toBeCloseTo(-23.9473063, 6);
    expect(b.equityCurve[2].equity).toBe(b.equityCurve[1].equity); // the rally after the wipe does not count
    expect(b.maxDrawdownPct).toBeCloseTo(100.239473063, 6);
  });

  it('a flat series: flat bar 0, then balance / ((1 + slip) (1 + fee))', () => {
    const b = buyAndHold(candlesFromCloses([100, 100, 100, 100, 100], 0), BROKER)!;
    const expected = 10_000 / (1.0002 * 1.0004);
    expect(b.equityCurve[0].equity).toBe(10_000);
    for (const p of b.equityCurve.slice(1)) expect(p.equity).toBeCloseTo(expected, 9);
    expect(b.maxDrawdownPct).toBeCloseTo((1 - expected / 10_000) * 100, 9);
  });

  it('without costs it is the plain price ratio from the entry open', () => {
    // candlesFromCloses: opens are the previous closes, so bar 1 opens at 50 (qty 200).
    const b = buyAndHold(candlesFromCloses([50, 60, 45, 75], 0), { ...BROKER, takerFee: 0, slippageBps: 0 })!;
    expect(b.equityCurve.map((p) => p.equity)).toEqual([10_000, 12_000, 9_000, 15_000]);
    expect(b.returnPct).toBeCloseTo(50, 12);
    expect(b.maxDrawdownPct).toBeCloseTo(25, 12); // 12000 -> 9000
  });

  it('is null with fewer than 2 bars (nothing could be traded) or a non-positive entry open', () => {
    expect(buyAndHold([], BROKER)).toBeNull();
    expect(buyAndHold([bar(0, 100, 100)], BROKER)).toBeNull();
    expect(buyAndHold([bar(0, 5, 1), bar(1, 0, 1)], BROKER)).toBeNull();
  });

  it('runBacktest attaches it over all candles, even after a wipe', () => {
    const crash = [100, 100, 85, 80, 120].map((p, i) => bar(i, p, p));
    const r = runBacktest(crash, { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } },
      { symbol: 'X', timeframe: '1h', broker: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } });
    expect(r.wiped).toBe(true);
    expect(r.benchmark!.equityCurve).toHaveLength(5);
    expect(structuredClone(r)).toEqual(r);
  });
});

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };

describe('Engine activity counters', () => {
  it('counts bars run and zero orders for a strategy that never trades', () => {
    const r = runBacktest(syntheticCandles(50), { onBar: () => {} }, CONFIG);
    expect(r.activity).toEqual({ barsRun: 50, orderRequests: 0, notFilled: { 'insufficient margin': 0, 'nothing to reduce': 0 } });
  });

  it('counts order requests and margin rejections; a flat close-position is not a request', () => {
    const strategy: Strategy = {
      onBar(ctx) {
        ctx.closePosition(); // flat every bar: returns null, not counted
        if (ctx.barIndex < 3) ctx.buy({ size: 400 }); // 4x notional at 1x leverage: rejected
      },
    };
    const r = runBacktest(syntheticCandles(10), strategy, CONFIG);
    expect(r.fills).toEqual([]);
    expect(r.activity.orderRequests).toBe(3);
    expect(r.activity.notFilled['insufficient margin']).toBe(3);
    expect(r.activity.barsRun).toBe(10);
  });

  it('counts skipped reduce-only orders', () => {
    const strategy: Strategy = {
      onBar(ctx) {
        if (ctx.barIndex === 0) ctx.buy({ size: 1, unit: 'qty' });
        if (ctx.barIndex === 2) { ctx.closePosition(); ctx.closePosition(); } // the second has nothing left to reduce
      },
    };
    const r = runBacktest(syntheticCandles(5), strategy, CONFIG);
    expect(r.activity.orderRequests).toBe(3);
    expect(r.activity.notFilled['nothing to reduce']).toBe(1);
    expect(r.trades).toHaveLength(1);
  });

  it('excludes warm-up bars and suppressed requests', () => {
    const engine = new Engine({ onBar: (ctx) => { ctx.buy({ size: 1, unit: 'qty' }); } }, CONFIG);
    const candles = syntheticCandles(8);
    for (const c of candles.slice(0, 5)) engine.pushWarmupCandle(c);
    for (const c of candles.slice(5)) engine.pushCandle(c);
    expect(engine.activity.barsRun).toBe(3);
    expect(engine.activity.orderRequests).toBe(3);
  });
});

describe('benchmark labels', () => {
  it("is 'Buy & hold' at 1x and names any other leverage", async () => {
    const { benchmarkLabel, benchmarkDefinition, BENCHMARK_DEFINITION } = await import('./benchmark');
    expect(benchmarkLabel(1)).toBe('Buy & hold');
    expect(benchmarkLabel(3)).toBe('Buy & hold (3x)');
    expect(benchmarkLabel(2.5)).toBe('Buy & hold (2.5x)');
    expect(BENCHMARK_DEFINITION).toContain('one 1x long');
    expect(benchmarkDefinition(3)).toMatch(/^Buy & hold \(3x\): one 3x long/);
  });

  it('runBacktest labels its benchmark with the account leverage', () => {
    const r = runBacktest(syntheticCandles(20), { onBar: () => {} }, { ...CONFIG_FOR_LABEL, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 3 } });
    expect(r.benchmark!.leverage).toBe(3);
  });
});

const CONFIG_FOR_LABEL: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
