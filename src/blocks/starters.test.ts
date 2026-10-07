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
  buyHold: FIXED,
};

describe('starter strategies', () => {
  it('lists the seven starters with unique ids and a one-line description each', () => {
    expect(STARTERS.map((s) => s.id)).toEqual(['smaCross', 'rsiReversion', 'bbBreakout', 'supertrend', 'macdCross', 'zones', 'buyHold']);
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

  it('Buy & hold enters exactly once (next bar open) and holds the position to the end', () => {
    const r = runBacktest(FIXED, createBlockStrategy(getStarter('buyHold')!.build()), CONFIG);
    expect(r.fills).toHaveLength(1);
    expect(r.fills[0]).toMatchObject({ bar: 1, side: 'buy', reason: 'market' });
    expect(r.trades).toEqual([]); // never closed: one trade still open at the end
    expect(r.finalPosition.side).toBe('long');
    expect(r.activity.orderRequests).toBe(1);
  });

  it('the SMA starter is the default workspace (fresh users get the same strategy)', async () => {
    const { defaultWorkspace } = await import('./defaultWorkspace');
    expect(getStarter('smaCross')!.build()).toEqual(defaultWorkspace());
  });
});
