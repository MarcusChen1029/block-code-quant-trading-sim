import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Engine, runBacktest, type EngineConfig } from './engine';
import { createSmaCross } from './strategies/smaCross';
import type { Strategy } from './strategy';
import { syntheticCandles } from './syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from './types';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const HOUR = 3_600_000;

describe('Engine', () => {
  it('shows the strategy only closed bars, in order, with history via value()', () => {
    const candles = syntheticCandles(5);
    const seen: Array<[number, number, number, number]> = [];
    let inits = 0;
    const spy: Strategy = {
      init: () => { inits++; },
      onBar: (ctx) => seen.push([ctx.barIndex, ctx.candle.time, ctx.value('close', 1), ctx.value('close', -1)]),
    };
    runBacktest(candles, spy, CONFIG);
    expect(inits).toBe(1);
    expect(seen.map((s) => s[0])).toEqual([0, 1, 2, 3, 4]);
    expect(seen.map((s) => s[1])).toEqual(candles.map((c) => c.time));
    expect(seen[0][2]).toBeNaN(); // nothing before bar 0
    expect(seen[3][2]).toBe(candles[2].close);
    expect(seen.every((s) => Number.isNaN(s[3]))).toBe(true); // future offsets are refused
  });

  it('fills an order placed on bar t at the open of bar t+1 with slippage and fee', () => {
    const candles = syntheticCandles(3);
    const strategy: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 1, unit: 'qty' }); } };
    const result = runBacktest(candles, strategy, CONFIG);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].bar).toBe(1);
    expect(result.fills[0].price).toBeCloseTo(candles[1].open * 1.0002, 10);
    expect(result.fills[0].fee).toBeCloseTo(candles[1].open * 1.0002 * 0.0004, 10);
    expect(result.finalPosition.qty).toBe(1);
    expect(result.equityCurve).toHaveLength(3);
  });

  it('closePosition returns null when flat', () => {
    let id: number | null = 0;
    runBacktest(syntheticCandles(1), { onBar: (ctx) => { id = ctx.closePosition(); } }, CONFIG);
    expect(id).toBeNull();
  });

  it('stops the run when equity reaches zero (account wiped)', () => {
    const crash: Candle[] = [100, 100, 85, 80, 120].map((p, i) => ({ time: i * HOUR, open: p, high: p, low: p, close: p, volume: 1 }));
    const allIn: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } };
    const config: EngineConfig = { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } };
    const result = runBacktest(crash, allIn, config);
    // ~10x notional bought at ~100; a 15% drop at bar 2 loses > 100% of equity
    expect(result.wiped).toBe(true);
    expect(result.barsProcessed).toBe(3);
    expect(result.trades[result.trades.length - 1].exitReason).toBe('wiped');
    expect(result.log.some((l) => l.message === 'account wiped: equity <= 0, run stopped')).toBe(true);
    expect(result.finalPosition.side).toBe('flat');
  });

  it('ignores candles after a wipe when driven incrementally', () => {
    const engine = new Engine({ onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } }, { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } });
    const prices = [100, 100, 85, 120];
    const results = prices.map((p, i) => engine.pushCandle({ time: i * HOUR, open: p, high: p, low: p, close: p, volume: 1 }));
    expect(results).toEqual([true, true, false, false]);
    expect(engine.wiped).toBe(true);
  });

  it('wraps strategy exceptions with the bar index', () => {
    const bad: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 2) throw new Error('boom'); } };
    expect(() => runBacktest(syntheticCandles(5), bad, CONFIG)).toThrow('strategy error on bar 2: boom');
  });
});

describe('SMA cross backtest', () => {
  it('is deterministic: same candles -> identical result', () => {
    const candles = syntheticCandles(600);
    const a = runBacktest(candles, createSmaCross(), CONFIG);
    const b = runBacktest(candles, createSmaCross(), CONFIG);
    expect(a.trades.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
  });

  it('enters only after the slow SMA warms up and alternates long/short', () => {
    const result = runBacktest(syntheticCandles(600), createSmaCross({ fast: 10, slow: 30, sizePct: 100 }), CONFIG);
    expect(result.fills[0].bar).toBeGreaterThanOrEqual(31); // slow SMA first valid at bar 29, first cross >= 30, fill next bar
    for (let i = 1; i < result.trades.length; i++) {
      expect(result.trades[i].side).not.toBe(result.trades[i - 1].side);
    }
    expect(result.stats.tradeCount).toBe(result.trades.length);
    expect(result.log.filter((l) => l.level !== 'info')).toEqual([]);
  });

  it('rejects fast >= slow', () => {
    expect(() => createSmaCross({ fast: 30, slow: 10, sizePct: 100 })).toThrow('fast length must be less than slow length');
  });
});
