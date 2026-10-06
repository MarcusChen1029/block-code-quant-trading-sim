import { describe, it, expect } from 'vitest';
import { Sma } from '../indicators/averages';
import { Engine, runBacktest, type EngineConfig } from './engine';
import type { Strategy } from './strategy';
import { syntheticCandles } from './syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from './types';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };

/** Buys 1 unit on every bar where SMA(5) is defined and the account is flat with no pending order. */
function smaGate(placed: number[]): Strategy {
  const sma = new Sma(5);
  return {
    onBar(ctx) {
      const v = sma.update(ctx.candle.close);
      ctx.log(`bar ${ctx.barIndex}`);
      if (!Number.isNaN(v) && ctx.position.qty === 0 && ctx.openOrderCount === 0) {
        const id = ctx.buy({ size: 1, unit: 'qty' });
        if (id > 0) placed.push(ctx.barIndex);
      }
    },
  };
}

describe('Engine warm-up (live sessions)', () => {
  it('lets warm indicators trade on the first post-start bar and suppresses everything before it', () => {
    const candles = syntheticCandles(12);
    const placed: number[] = [];
    const engine = new Engine(smaGate(placed), CONFIG);
    for (const c of candles.slice(0, 6)) engine.pushWarmupCandle(c); // SMA(5) is already defined on warm-up bar 4
    for (const c of candles.slice(6)) engine.pushCandle(c);
    const result = engine.result();

    expect(placed[0]).toBe(6); // the first post-start bar (index 6) places the order...
    expect(result.fills[0].bar).toBe(7); // ...filled at the next open, like any order
    expect(result.fills.every((f) => f.time >= candles[6].time)).toBe(true); // no fill before the start
    expect(result.equityCurve.map((p) => p.time)).toEqual(candles.slice(6).map((c) => c.time));
    expect(result.barsProcessed).toBe(12);
    // Strategy log messages from warm-up bars are dropped; the suppression note is logged exactly once.
    expect(result.log.filter((l) => l.level === 'debug')).toEqual([
      { bar: 4, time: candles[4].time, level: 'debug', message: 'warm-up: order requests before the session start are ignored' },
    ]);
    expect(result.log.filter((l) => l.level === 'info').map((l) => l.message)[0]).toBe('bar 6');
  });

  it('without warm-up the same strategy has to wait for its indicator', () => {
    const placed: number[] = [];
    runBacktest(syntheticCandles(6).slice(0), smaGate(placed), CONFIG);
    expect(placed[0]).toBe(4);
  });

  it('keeps stats to the trading bars only (equity, exposure, sharpe input)', () => {
    const candles = syntheticCandles(40);
    const warm = new Engine(smaGate([]), CONFIG);
    for (const c of candles.slice(0, 20)) warm.pushWarmupCandle(c);
    for (const c of candles.slice(20)) warm.pushCandle(c);
    const stats = warm.stats();
    expect(warm.equityPoints).toHaveLength(20);
    expect(stats.exposurePct).toBeGreaterThan(0);
    expect(stats.exposurePct).toBeLessThanOrEqual(100);
  });

  it('refuses warm-up bars after trading started', () => {
    const engine = new Engine({ onBar: () => {} }, CONFIG);
    const [a, b] = syntheticCandles(2);
    engine.pushCandle(a);
    expect(() => engine.pushWarmupCandle(b)).toThrow('warm-up bars must come before the first trading bar');
  });

  it('runs init once, on the first warm-up bar, and reports warm-up errors with the bar index', () => {
    let inits = 0;
    const bad: Strategy = { init: () => { inits++; }, onBar: (ctx) => { if (ctx.barIndex === 1) throw new Error('boom'); } };
    const engine = new Engine(bad, CONFIG);
    const [a, b] = syntheticCandles(2);
    engine.pushWarmupCandle(a);
    expect(inits).toBe(1);
    expect(() => engine.pushWarmupCandle(b)).toThrow('strategy error on bar 1: boom');
  });

  it('marks equity at any price without recording it', () => {
    const engine = new Engine({ onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 1, unit: 'qty' }); } }, CONFIG);
    const candles = syntheticCandles(2);
    for (const c of candles) engine.pushCandle(c);
    const { qty, entryPrice } = engine.position;
    const balance = engine.stats().finalEquity - qty * (candles[1].close - entryPrice); // equity = balance + uPnL
    expect(engine.markEquity(entryPrice + 10)).toBeCloseTo(balance + qty * 10, 8);
    expect(engine.equityPoints).toHaveLength(2);
  });
});
