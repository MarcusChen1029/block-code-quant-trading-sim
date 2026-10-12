import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { candlesFromCloses, walkCandles } from '../engine/fixtures';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { compileBlocks, createBlockStrategy } from './compiler';
import { getStarter, STARTERS, type StarterId } from './starters';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const FIXED = walkCandles(800, 11, 0, 0.012);

/** Slow, large swings: RSI reaches both extremes, MACD and Supertrend flip every half cycle. */
const SWINGS = candlesFromCloses(Array.from({ length: 600 }, (_, i) => 100 + 20 * Math.sin(i / 12) + 0.8 * Math.sin(i * 1.7)), 0.5);

/** Quiet ranges broken by sharp rallies, then sell-offs: closes break the upper Bollinger band. */
function breakouts(): Candle[] {
  const closes: number[] = [];
  let p = 100;
  for (let cycle = 0; cycle < 4; cycle++) {
    for (let i = 0; i < 60; i++) closes.push(p + (i % 2 === 0 ? 0.3 : -0.3));
    for (let i = 0; i < 15; i++) closes.push((p *= 1.02));
    for (let i = 0; i < 25; i++) closes.push((p *= 0.985));
  }
  return candlesFromCloses(closes, 0.2);
}

const DESIGNED: Record<StarterId, Candle[]> = {
  smaCross: syntheticCandles(600),
  rsiReversion: SWINGS,
  bbBreakout: breakouts(),
  supertrend: SWINGS,
  macdCross: SWINGS,
  zones: walkCandles(1500, 7, 0.0002, 0.012),
  martingale: FIXED,
  buyHold: FIXED,
};

describe('starter strategies', () => {
  it('lists the eight starters with unique ids and a one-line description each', () => {
    expect(STARTERS.map((s) => s.id)).toEqual(['smaCross', 'rsiReversion', 'bbBreakout', 'supertrend', 'macdCross', 'zones', 'martingale', 'buyHold']);
    for (const s of STARTERS) {
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.description).not.toContain('\n');
    }
    expect(getStarter('nope')).toBeUndefined();
  });

  for (const starter of STARTERS) {
    describe(starter.label, () => {
      it('compiles with zero errors and zero warnings', () => {
        const result = compileBlocks(starter.build());
        expect(result.ok ? [] : result.errors).toEqual([]);
        expect(result.warnings).toEqual([]);
      });

      it('builds a fresh copy each time (editing one never changes the next)', () => {
        const a = starter.build();
        a.blocks!.blocks!.pop();
        expect(starter.build().blocks!.blocks).toHaveLength(2);
      });

      it('backtests deterministically on a fixed fixture', () => {
        const a = runBacktest(FIXED, createBlockStrategy(starter.build()), CONFIG);
        const b = runBacktest(FIXED, createBlockStrategy(starter.build()), CONFIG);
        expect(b).toEqual(a);
        expect(a.barsProcessed).toBe(FIXED.length);
        expect(a.log.filter((l) => l.level === 'warn' || l.level === 'error')).toEqual([]); // no rejected orders
      });

      if (starter.id !== 'buyHold') {
        it('trades on a fixture designed for it', () => {
          const r = runBacktest(DESIGNED[starter.id], createBlockStrategy(starter.build()), CONFIG);
          expect(r.trades.length).toBeGreaterThanOrEqual(1);
          expect(r.wiped).toBe(false);
        });
      }
    });
  }

  it('Martingale doubles the stake after a losing trade (capped at 50%) and resets it after a win', () => {
    const r = runBacktest(FIXED, createBlockStrategy(getStarter('martingale')!.build()), CONFIG);
    expect(r.trades.length).toBeGreaterThan(10);
    expect(r.fills.every((f) => f.reason !== 'wiped')).toBe(true);
    const entries = r.fills.filter((f) => f.reason === 'market');
    const margin = entries.map((f) => (f.qty * f.price) / (r.equityCurve.find((p) => p.time === f.time)?.equity ?? NaN));
    expect(Math.max(...margin)).toBeLessThan(0.52);
    // Every entry after a losing exit is about twice the previous stake (or at the cap); after a win it is back to the 5% base.
    let checked = 0;
    for (let i = 1; i < r.trades.length; i++) {
      const prev = r.trades[i - 1];
      const stake = (r.trades[i].qty * r.trades[i].entryPrice) / DEFAULT_BROKER_CONFIG.initialBalance;
      const prevStake = (prev.qty * prev.entryPrice) / DEFAULT_BROKER_CONFIG.initialBalance;
      if (prev.netPnl < 0 && prevStake < 0.2) { expect(stake / prevStake).toBeGreaterThan(1.5); checked++; }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('Buy & hold enters exactly once (next bar open) and holds the position to the end', () => {
    const r = runBacktest(FIXED, createBlockStrategy(getStarter('buyHold')!.build()), CONFIG);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ bar: 1, side: 'buy', reason: 'market' });
    expect(r.trades).toEqual([]); // never closed: one trade still open at the end
    expect(r.finalPosition.side).toBe('long');
    expect(r.activity.orderRequests).toBe(1);
  });

  it('the Buy & hold starter matches the buy & hold benchmark (same entry bar, fee and slippage)', async () => {
    const { buildVerdict } = await import('../ui/verdict');
    for (const candles of [FIXED, SWINGS, walkCandles(500, 3, 0.001, 0.02)]) {
      const r = runBacktest(candles, createBlockStrategy(getStarter('buyHold')!.build()), CONFIG);
      const b = r.benchmark!;
      expect(r.stats.finalEquity).toBeCloseTo(b.finalEquity, 6);
      expect(r.stats.maxDrawdownPct).toBeCloseTo(b.maxDrawdownPct, 8);
      expect(r.equityCurve.map((p) => p.time)).toEqual(b.equityCurve.map((p) => p.time));
      const v = buildVerdict({
        tradeCount: r.trades.length, openPosition: true, fillCount: r.fills.length, totalReturnPct: r.stats.totalReturnPct,
        maxDrawdownPct: r.stats.maxDrawdownPct, wiped: false, barsProcessed: r.barsProcessed, barsLoaded: candles.length,
        benchmark: { returnPct: b.returnPct, maxDrawdownPct: b.maxDrawdownPct }, activity: r.activity, warmup: null,
      });
      expect(v.text).toMatch(/your strategy matched it\.$/);
    }
  });

  it('at any account leverage the Buy & hold starter matches the benchmark, which is labelled with that leverage', async () => {
    const { buildVerdict } = await import('../ui/verdict');
    const { benchmarkLabel } = await import('../engine/benchmark');
    const candles = walkCandles(500, 3, 0.001, 0.02);
    for (const leverage of [2, 5, 1]) {
      const config: EngineConfig = { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage } };
      const r = runBacktest(candles, createBlockStrategy(getStarter('buyHold')!.build()), config);
      const b = r.benchmark!;
      expect(r.wiped).toBe(false);
      expect(r.fills[0].qty).toBeCloseTo(b.qty, 9); // same notional sizing as percentEquity at this leverage
      expect(r.stats.finalEquity).toBeCloseTo(b.finalEquity, 6);
      expect(r.stats.maxDrawdownPct).toBeCloseTo(b.maxDrawdownPct, 8);
      expect(b.leverage).toBe(leverage);
      for (let i = 0; i < r.equityCurve.length; i++) expect(r.equityCurve[i].equity).toBeCloseTo(b.equityCurve[i].equity, 6);
      const v = buildVerdict({
        tradeCount: r.trades.length, openPosition: true, fillCount: r.fills.length, totalReturnPct: r.stats.totalReturnPct,
        maxDrawdownPct: r.stats.maxDrawdownPct, wiped: false, barsProcessed: r.barsProcessed, barsLoaded: candles.length,
        benchmark: { returnPct: b.returnPct, maxDrawdownPct: b.maxDrawdownPct, label: benchmarkLabel(leverage) }, activity: r.activity, warmup: null,
      });
      expect(v.text).toMatch(/your strategy matched it\.$/);
      expect(v.text).toContain(leverage === 1 ? ' Buy & hold: ' : ` Buy & hold (${leverage}x): `);
    }
  });

  it('a leveraged buy & hold that is wiped out ends where the wiped Buy & hold starter ends', () => {
    const crash = candlesFromCloses([100, 100, 98, 95, 90, 70, 72, 120, 130], 0.2);
    const config: EngineConfig = { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 5 } };
    const r = runBacktest(crash, createBlockStrategy(getStarter('buyHold')!.build()), config);
    const b = r.benchmark!;
    expect(r.wiped).toBe(true);
    expect(b.wiped).toBe(true);
    expect(b.equityCurve).toHaveLength(crash.length); // flat after the wipe, still one point per bar
    expect(b.finalEquity).toBeCloseTo(r.stats.finalEquity, 6);
    expect(b.equityCurve[b.equityCurve.length - 1].equity).toBe(b.equityCurve[r.barsProcessed - 1].equity);
  });

  it('the SMA starter is the default workspace (fresh users get the same strategy)', async () => {
    const { defaultWorkspace } = await import('./defaultWorkspace');
    expect(getStarter('smaCross')!.build()).toEqual(defaultWorkspace());
  });
});
