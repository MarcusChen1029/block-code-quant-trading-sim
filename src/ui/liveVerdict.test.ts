import { describe, expect, it } from 'vitest';
import { buyAndHold } from '../engine/benchmark';
import { runBacktest } from '../engine/engine';
import { createSmaCross } from '../engine/strategies/smaCross';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { SessionEngine, type SessionDelta } from '../live/sessionEngine';
import { MINUTE, testSession } from '../live/testing';
import type { Candle } from '../data/types';
import { liveVerdict, type LiveVerdictInput } from './liveFormat';
import { buildVerdict } from './verdict';

const BARS = syntheticCandles(400, 0, MINUTE);
const session = testSession({ startTime: 150 * MINUTE, warmupBars: 150 });

/** Runs the live session engine over `bars` and collects what the page receives (deltas). */
function liveRun(bars: readonly Candle[]): LiveVerdictInput {
  const engine = new SessionEngine(session, createSmaCross({ fast: 5, slow: 20, sizePct: 50 }));
  const deltas: SessionDelta[] = [];
  for (const bar of bars) {
    engine.push(bar);
    if (bar.time % (37 * MINUTE) === 0) deltas.push(engine.drain());
  }
  deltas.push(engine.drain());
  const last = deltas[deltas.length - 1];
  return {
    startTime: session.startTime,
    broker: session.brokerConfig,
    candles: deltas.flatMap((d) => d.candles),
    tradeCount: deltas.reduce((n, d) => n + d.trades.length, 0),
    fillCount: deltas.reduce((n, d) => n + d.fills.length, 0),
    equityPoints: deltas.reduce((n, d) => n + d.equity.length, 0),
    stats: last.stats,
    wiped: last.wiped,
    position: last.position,
    activity: last.activity,
  };
}

describe('liveVerdict', () => {
  it('buy & hold over the session\'s trading bars, entered at the first fillable bar after warm-up (= the backtest convention)', () => {
    const input = liveRun(BARS);
    const { benchmark, verdict } = liveVerdict(input);
    const trading = BARS.filter((c) => c.time >= session.startTime);
    expect(benchmark).not.toBeNull();
    expect(benchmark).toEqual(buyAndHold(trading, DEFAULT_BROKER_CONFIG));
    expect(benchmark).toEqual(runBacktest(trading, createSmaCross({ fast: 5, slow: 20, sizePct: 50 }), { symbol: 'BTCUSDT', timeframe: '1m', broker: DEFAULT_BROKER_CONFIG }).benchmark);
    expect(benchmark!.entryPrice).toBeCloseTo(BARS[151].open * (1 + DEFAULT_BROKER_CONFIG.slippageBps / 10_000), 9);
    expect(benchmark!.equityCurve.map((p) => p.time)).toEqual(trading.map((c) => c.time)); // same times as the session's equity curve
    expect(input.tradeCount).toBeGreaterThan(0);
    expect(verdict.text).toContain('Buy & hold:');
    expect(verdict).toEqual(buildVerdict({
      tradeCount: input.tradeCount,
      openPosition: input.position!.side !== 'flat',
      fillCount: input.fillCount,
      totalReturnPct: input.stats!.totalReturnPct,
      maxDrawdownPct: input.stats!.maxDrawdownPct,
      wiped: false,
      barsProcessed: trading.length,
      barsLoaded: trading.length,
      benchmark: { returnPct: benchmark!.returnPct, maxDrawdownPct: benchmark!.maxDrawdownPct },
      activity: input.activity,
      warmup: null,
    }));
  });

  it('updates as bars close: a shorter run gives the verdict of that moment', () => {
    const early = liveVerdict(liveRun(BARS.slice(0, 260)));
    const late = liveVerdict(liveRun(BARS));
    expect(early.benchmark!.equityCurve).toHaveLength(110);
    expect(late.benchmark!.equityCurve).toHaveLength(250);
    expect(early.verdict.text).not.toEqual(late.verdict.text);
  });

  it('during warm-up and on the first trading bar there is nothing to judge yet (no "move the start date" advice)', () => {
    for (const n of [0, 100, 150, 151]) {
      const { verdict, benchmark } = liveVerdict(liveRun(BARS.slice(0, n)));
      expect(benchmark).toBeNull();
      expect(verdict.tone).toBe('neutral');
      expect(verdict.text).not.toMatch(/start date/);
      expect(verdict.text).toMatch(n < 150 ? /warm-up/i : /first trading bars/i);
    }
  });

  it('a session with no warm-up trades from its first bar: buy & hold enters at the second', () => {
    const noWarm = testSession({ startTime: 0, warmupBars: 0 });
    const engine = new SessionEngine(noWarm, createSmaCross({ fast: 5, slow: 20, sizePct: 50 }));
    for (const bar of BARS.slice(0, 50)) engine.push(bar);
    const d = engine.drain();
    const { benchmark } = liveVerdict({
      startTime: 0, broker: noWarm.brokerConfig, candles: d.candles, tradeCount: d.trades.length, fillCount: d.fills.length,
      equityPoints: d.equity.length, stats: d.stats, wiped: d.wiped, position: d.position, activity: d.activity,
    });
    expect(benchmark!.entryPrice).toBeCloseTo(BARS[1].open * (1 + DEFAULT_BROKER_CONFIG.slippageBps / 10_000), 9);
  });
});

describe('liveVerdict with leverage (same wording as a backtest)', () => {
  it('a 3x session names the 3x hold, says when it was wiped, and carries the 3x tooltip', async () => {
    const { benchmarkDefinition, benchmarkLabel } = await import('../engine/benchmark');
    const broker = { ...DEFAULT_BROKER_CONFIG, leverage: 3 };
    // Trading bars: flat, then a 50% crash (a 3x long is wiped), warm-up before the start.
    const bars: Candle[] = Array.from({ length: 40 }, (_, i) => {
      const p = i < 25 ? 100 : 50;
      return { time: i * MINUTE, open: p, high: p, low: p, close: p, volume: 1 };
    });
    const lev = testSession({ startTime: 10 * MINUTE, warmupBars: 10, brokerConfig: broker });
    const engine = new SessionEngine(lev, createSmaCross({ fast: 5, slow: 20, sizePct: 50 }));
    for (const bar of bars) engine.push(bar);
    const d = engine.drain();
    const out = liveVerdict({
      startTime: lev.startTime, broker, candles: d.candles, tradeCount: d.trades.length, fillCount: d.fills.length,
      equityPoints: d.equity.length, stats: d.stats, wiped: d.wiped, position: d.position, activity: d.activity,
    });
    expect(out.benchmark!.leverage).toBe(3);
    expect(out.benchmark!.wipedTime).not.toBeNull();
    expect(out.verdict.text).toContain(benchmarkLabel(3));
    expect(out.verdict.text).toMatch(/wiped/);
    // A wiped hold shows at most -100% (clamped like the backtest), never "-150%".
    const big = out.verdict.text.match(/-\d{3,}\.\d\d%/g) ?? [];
    expect(big.every((m) => m === '-100.00%'), out.verdict.text).toBe(true);
    expect(out.benchmarkInfo).toBe(benchmarkDefinition(3));
  });

  it('1x keeps the plain wording and the 1x tooltip', async () => {
    const { BENCHMARK_DEFINITION } = await import('../engine/benchmark');
    const out = liveVerdict(liveRun(BARS));
    expect(out.verdict.text).toContain('Buy & hold');
    expect(out.benchmarkInfo).toBe(BENCHMARK_DEFINITION);
  });
});
