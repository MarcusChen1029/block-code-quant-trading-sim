import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createBlockStrategy } from '../blocks/compiler';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { zoneExampleWorkspace } from '../blocks/zoneExample';
import type { Candle } from '../data/types';
import { runBacktest, type EngineConfig } from './engine';
import { walkCandles } from './fixtures';
import { createSmaCross, DEFAULT_SMA_CROSS } from './strategies/smaCross';
import type { Strategy } from './strategy';
import { syntheticCandles } from './syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from './types';

/**
 * Regression guard: trades, fills and equity curves of fixed strategies on fixed fixtures must stay byte-identical
 * to the baseline recorded BEFORE the UX work (benchmark, activity counters) was added. Regenerate only on purpose:
 * UPDATE_BASELINE=1 npx vitest run src/engine/baseline.test.ts
 */
const BASELINE = fileURLToPath(new URL('./__fixtures__/backtest-baseline.json', import.meta.url));

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const LEVERED: EngineConfig = { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 3, slippageBps: 5 } };

/** Exercises limit, stop, SL/TP, flips and margin rejections. */
function brokerWorkout(): Strategy {
  return {
    onBar(ctx) {
      const i = ctx.barIndex;
      const c = ctx.candle.close;
      if (i % 37 === 5) ctx.buy({ size: 60 });
      if (i % 37 === 12) ctx.sell({ size: 120 }); // flip short
      if (i % 37 === 13) { ctx.setStopLoss(c * 1.02); ctx.setTakeProfit(c * 0.97); }
      if (i % 37 === 20) ctx.closePosition();
      if (i % 37 === 22) ctx.buy({ type: 'limit', size: 50, price: c * 0.995 });
      if (i % 37 === 24) ctx.sell({ type: 'stop', size: 1, unit: 'qty', price: c * 0.99 });
      if (i % 37 === 30) ctx.buy({ size: 400 }); // too big: rejected
      if (i % 37 === 33) ctx.cancelOrders();
    },
  };
}

function allInLevered(): Strategy {
  return { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } };
}

type Case = [name: string, candles: Candle[], strategy: () => Strategy, config: EngineConfig];

const SYN = syntheticCandles(600);
const WALK = walkCandles(1500, 7, 0.0002, 0.012);
const CRASH = walkCandles(300, 3, -0.004, 0.02);

const CASES: Case[] = [
  ['smaCross-syn', SYN, () => createSmaCross(DEFAULT_SMA_CROSS), CONFIG],
  ['smaCross-walk', WALK, () => createSmaCross(DEFAULT_SMA_CROSS), CONFIG],
  ['blocksDefault-walk', WALK, () => createBlockStrategy(defaultWorkspace()), CONFIG],
  ['zoneExample-walk', WALK, () => createBlockStrategy(zoneExampleWorkspace()), CONFIG],
  ['brokerWorkout-walk', WALK, brokerWorkout, LEVERED],
  ['wipe-crash', CRASH, allInLevered, { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 20 } }],
];

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, candles, strategy, config] of CASES) {
    const r = runBacktest(candles, strategy(), config);
    out[name] = { trades: r.trades, fills: r.fills, equityCurve: r.equityCurve, wiped: r.wiped, barsProcessed: r.barsProcessed, finalPosition: r.finalPosition };
  }
  return JSON.parse(JSON.stringify(out)) as Record<string, unknown>;
}

describe('backtest output baseline (byte-identical)', () => {
  it('matches the recorded trades, fills and equity of every case', () => {
    const now = snapshot();
    if (process.env.UPDATE_BASELINE === '1') writeFileSync(BASELINE, `${JSON.stringify(now)}\n`);
    expect(existsSync(BASELINE), 'baseline file missing: it must be recorded before engine changes').toBe(true);
    const recorded = readFileSync(BASELINE, 'utf8').trim();
    expect(JSON.stringify(now)).toBe(recorded); // exact text: every float must be bit-identical
    for (const name of Object.keys(now)) expect((now[name] as { fills: unknown[] }).fills.length).toBeGreaterThan(0);
  });
});
