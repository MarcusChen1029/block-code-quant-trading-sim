import { describe, it, expect } from 'vitest';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import type { Candle } from '../data/types';
import { runBacktest } from '../engine/engine';
import { createSmaCross } from '../engine/strategies/smaCross';
import { StrategyError, type Strategy } from '../engine/strategy';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { buildStrategy } from '../worker/protocol';
import { LiveRunner } from './runner';
import { blocksSnapshot, snapshotToSpec, type LiveSessionRecord } from './session';
import { SessionEngine } from './sessionEngine';
import { FakeMarket, MINUTE, ManualTimers, Recorder, spyStrategy, testSession } from './testing';

const BARS = syntheticCandles(400, 0, MINUTE);

function setup(market: FakeMarket, session: LiveSessionRecord, strategy: Strategy, mode: 'live' | 'replay' = 'live') {
  const engine = new SessionEngine(session, strategy, mode === 'replay' ? (session.lastBarTime ?? undefined) : undefined);
  const rec = new Recorder();
  const timers = new ManualTimers();
  const runner = new LiveRunner(engine, market, rec, {
    mode,
    symbol: session.symbol,
    timeframe: session.timeframe,
    now: () => market.now,
    timers,
    yieldFn: () => Promise.resolve(),
    closeMarginMs: 0,
    batchSize: 64,
  });
  return { engine, rec, timers, runner };
}

const blockStrategy = () => buildStrategy(snapshotToSpec(blocksSnapshot(defaultWorkspace(), [], [])));

function core(r: ReturnType<SessionEngine['result']>) {
  return { trades: r.trades, fills: r.fills, equityCurve: r.equityCurve, log: r.log, stats: r.stats, finalPosition: r.finalPosition };
}

describe('LiveRunner determinism', () => {
  const session = testSession({ startTime: 200 * MINUTE, warmupBars: 120 });

  it('one-go catch-up == bar-by-bar websocket feed == pure engine fed in any batching (block strategy)', async () => {
    const all = new FakeMarket(BARS, MINUTE, 400 * MINUTE);
    const a = setup(all, session, blockStrategy());
    a.runner.start();
    await a.runner.idle();
    const oneGo = a.engine.result();
    expect(oneGo.trades.length).toBeGreaterThan(2);
    expect(a.engine.lastBarTime).toBe(399 * MINUTE);

    const seen: Candle[] = [];
    const inc = new FakeMarket(BARS, MINUTE, 250 * MINUTE);
    const b = setup(inc, session, spyStrategy(blockStrategy(), seen));
    b.runner.start();
    await b.runner.idle();
    for (let i = 250; i < 400; i++) {
      inc.formingTick(i);
      inc.formingTick(i, 1); // wild forming prices
      inc.closeBar(i);
      await b.runner.idle();
    }
    expect(core(b.engine.result())).toEqual(core(oneGo));
    // the strategy saw each closed bar exactly once, in order, never a forming price
    expect(seen.map((c) => c.time)).toEqual(BARS.slice(80).map((c) => c.time));
    expect(seen).toEqual(BARS.slice(80));
    expect(b.rec.ticks.some((t) => t.candle.close === 999_999)).toBe(true);
    // live bars came from the socket, not REST
    expect(inc.fetchCalls.every(([, end]) => end < 250 * MINUTE)).toBe(true);

    // the deltas add up to the full state
    expect(b.rec.deltas.flatMap((d) => d.fills)).toEqual(oneGo.fills);
    expect(b.rec.deltas.flatMap((d) => d.trades)).toEqual(oneGo.trades);
    expect(b.rec.deltas.flatMap((d) => d.equity)).toEqual(oneGo.equityCurve);
    expect(b.rec.processedTimes).toEqual(BARS.slice(80).map((c) => c.time));

    const pure = new SessionEngine(session, blockStrategy());
    for (const c of BARS) {
      pure.push(c);
      pure.push(c); // duplicates are ignored
      if (c.time % (7 * MINUTE) === 0) pure.drain();
    }
    expect(core(pure.result())).toEqual(core(oneGo));
  });

  it('with warmupBars = 0 it equals a backtest started at startTime', async () => {
    const s0 = testSession({ startTime: 200 * MINUTE, warmupBars: 0 });
    const market = new FakeMarket(BARS, MINUTE, 400 * MINUTE);
    const { engine, runner } = setup(market, s0, createSmaCross());
    runner.start();
    await runner.idle();
    const backtest = runBacktest(BARS.slice(200), createSmaCross(), { symbol: 'BTCUSDT', timeframe: '1m', broker: DEFAULT_BROKER_CONFIG });
    expect(core(engine.result())).toEqual(core(backtest));
    expect(engine.result().barsProcessed).toBe(200);
  });

  it('with warm-up the first trade can come on the first post-start bar; nothing fills before the start', async () => {
    // SMA 10/30 crosses at some bar; start the session exactly on a bar whose close triggers a cross.
    const reference = runBacktest(BARS, createSmaCross(), { symbol: 'BTCUSDT', timeframe: '1m', broker: DEFAULT_BROKER_CONFIG });
    const signalBar = reference.fills[3].bar - 1; // a cross well after the slow SMA is warm
    const s = testSession({ startTime: signalBar * MINUTE, warmupBars: 60 });
    const market = new FakeMarket(BARS, MINUTE, (signalBar + 5) * MINUTE);
    const { engine, runner } = setup(market, s, createSmaCross());
    runner.start();
    await runner.idle();
    const r = engine.result();
    expect(r.fills[0].time).toBe((signalBar + 1) * MINUTE); // ordered on the first trading bar, filled at the next open
    expect(r.fills.every((f) => f.time >= s.startTime)).toBe(true);
    expect(r.equityCurve[0].time).toBe(s.startTime);
  });
});

describe('LiveRunner gap-fill and dedup', () => {
  it('backfills bars missed during a websocket drop from REST, in order, exactly once', async () => {
    const seen: Candle[] = [];
    const market = new FakeMarket(BARS, MINUTE, 100 * MINUTE);
    const { engine, rec, runner } = setup(market, testSession(), spyStrategy(createSmaCross(), seen));
    runner.start();
    await runner.idle();
    expect(engine.lastBarTime).toBe(99 * MINUTE);
    market.closeBar(100);
    market.closeBar(101);
    await runner.idle();
    market.drop();
    expect(rec.statuses[rec.statuses.length - 1].state).toBe('reconnecting');
    market.now = 105 * MINUTE; // bars 102, 103, 104 close while disconnected
    const restCallsBefore = market.fetchCalls.length;
    market.formingTick(105); // reconnected: the forming bar proves 102..104 are closed
    await runner.idle();
    expect(market.fetchCalls.slice(restCallsBefore)).toEqual([[102 * MINUTE, 104 * MINUTE]]);
    market.closeBar(105);
    market.closeBar(105); // duplicate delivery
    market.closeBar(101); // stale replay of an old bar
    await runner.idle();
    const expected = BARS.slice(0, 106).map((c) => c.time);
    expect(seen.map((c) => c.time)).toEqual(expected);
    expect(rec.processedTimes).toEqual(expected);
    expect(rec.statuses[rec.statuses.length - 1].state).toBe('live');
  });

  it('a closed bar after a hole waits for the backfill instead of jumping ahead', async () => {
    const market = new FakeMarket(BARS, MINUTE, 10 * MINUTE);
    const { engine, rec, runner } = setup(market, testSession(), createSmaCross());
    runner.start();
    await runner.idle();
    market.now = 14 * MINUTE;
    market.closeBar(14); // 10..13 were never delivered on the socket
    await runner.idle();
    expect(rec.processedTimes).toEqual(BARS.slice(0, 15).map((c) => c.time));
    expect(engine.lastBarTime).toBe(14 * MINUTE);
  });

  it('notices bars that closed while the socket was silent (sleep) via the clock heartbeat', async () => {
    const market = new FakeMarket(BARS, MINUTE, 50 * MINUTE);
    const { engine, timers, runner } = setup(market, testSession(), createSmaCross());
    runner.start();
    await runner.idle();
    market.now = 120 * MINUTE + 5;
    timers.runIntervals();
    await runner.idle();
    expect(engine.lastBarTime).toBe(119 * MINUTE);
  });

  it('skips exchange holes (no bars before listing) without stalling', async () => {
    const listed = BARS.slice(30);
    const market = new FakeMarket(listed, MINUTE, 200 * MINUTE);
    const engine = new SessionEngine(testSession({ startTime: 40 * MINUTE, warmupBars: 39 }), createSmaCross());
    const rec = new Recorder();
    const runner = new LiveRunner(engine, market, rec, {
      mode: 'live', symbol: 'BTCUSDT', timeframe: '1m', now: () => market.now, timers: new ManualTimers(),
      yieldFn: () => Promise.resolve(), closeMarginMs: 0, fetchChunkBars: 20,
    });
    runner.start();
    await runner.idle();
    expect(rec.processedTimes[0]).toBe(30 * MINUTE);
    expect(engine.lastBarTime).toBe(199 * MINUTE);
  });
});

describe('LiveRunner errors', () => {
  it('a REST failure during catch-up shows an error, changes nothing, and retries to the same state', async () => {
    const market = new FakeMarket(BARS, MINUTE, 300 * MINUTE);
    market.failNext = 1;
    const { engine, rec, timers, runner } = setup(market, testSession({ warmupBars: 0 }), createSmaCross());
    runner.start();
    await runner.idle();
    const err = rec.statuses[rec.statuses.length - 1];
    expect(err).toMatchObject({ state: 'error', message: 'Binance HTTP 503: unavailable', retryInMs: 2000, lastBarTime: null });
    expect(rec.deltas).toHaveLength(0);
    timers.runTimeouts();
    await runner.idle();
    expect(engine.lastBarTime).toBe(299 * MINUTE);
    expect(rec.statuses[rec.statuses.length - 1].state).not.toBe('error');

    const clean = setup(new FakeMarket(BARS, MINUTE, 300 * MINUTE), testSession({ warmupBars: 0 }), createSmaCross());
    clean.runner.start();
    await clean.runner.idle();
    expect(core(engine.result())).toEqual(core(clean.engine.result()));
  });

  it('a REST failure while backfilling a gap keeps the processed bars intact and recovers', async () => {
    const market = new FakeMarket(BARS, MINUTE, 20 * MINUTE);
    const { engine, rec, timers, runner } = setup(market, testSession(), createSmaCross());
    runner.start();
    await runner.idle();
    market.drop();
    market.now = 25 * MINUTE;
    market.failNext = 2;
    market.formingTick(25);
    await runner.idle();
    expect(engine.lastBarTime).toBe(19 * MINUTE);
    expect(rec.statuses[rec.statuses.length - 1].state).toBe('error');
    timers.runTimeouts();
    await runner.idle();
    expect(rec.statuses[rec.statuses.length - 1]).toMatchObject({ state: 'error', retryInMs: 5000 }); // backoff grows
    timers.runTimeouts();
    await runner.idle();
    expect(engine.lastBarTime).toBe(24 * MINUTE);
    expect(rec.processedTimes).toEqual(BARS.slice(0, 25).map((c) => c.time));
  });

  it('a strategy error halts the session with the message and the block id', async () => {
    const market = new FakeMarket(BARS, MINUTE, 100 * MINUTE);
    const bad: Strategy = { onBar: (ctx) => { if (ctx.candle.time === 30 * MINUTE) throw new StrategyError('size must be > 0', 'blk-7'); } };
    const { rec, runner } = setup(market, testSession(), bad);
    runner.start();
    await runner.idle();
    expect(rec.halts).toEqual([{ reason: 'error', message: 'strategy error on bar 30: size must be > 0', blockId: 'blk-7', lastBarTime: 30 * MINUTE }]);
    expect(market.closed).toBe(true);
    expect(rec.statuses[rec.statuses.length - 1].state).toBe('stopped');
    market.closeBar(101);
    expect(rec.processedTimes[rec.processedTimes.length - 1]).toBe(30 * MINUTE);
  });

  it('a wiped account stops the session', async () => {
    const crash = [100, 100, 85, 80, 120, 130].map((p, i) => ({ time: i * MINUTE, open: p, high: p, low: p, close: p, volume: 1 }));
    const market = new FakeMarket(crash, MINUTE, 6 * MINUTE);
    const allIn: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } };
    const { engine, rec, runner } = setup(market, testSession({ brokerConfig: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } }), allIn);
    runner.start();
    await runner.idle();
    expect(rec.halts).toEqual([{ reason: 'wiped', message: 'account wiped: equity <= 0, session stopped', lastBarTime: 2 * MINUTE }]);
    expect(engine.wiped).toBe(true);
  });

  it('stop() finalises: later bars are ignored and the last bar is reported', async () => {
    const market = new FakeMarket(BARS, MINUTE, 50 * MINUTE);
    const { rec, runner } = setup(market, testSession(), createSmaCross());
    runner.start();
    await runner.idle();
    runner.stop();
    market.closeBar(50);
    await runner.idle();
    expect(rec.halts).toEqual([{ reason: 'stopped', lastBarTime: 49 * MINUTE }]);
    expect(rec.processedTimes[rec.processedTimes.length - 1]).toBe(49 * MINUTE);
  });
});

describe('LiveRunner replay of a stopped session', () => {
  it('replays exactly up to the last processed bar and completes, without a websocket', async () => {
    const session = testSession({ startTime: 100 * MINUTE, warmupBars: 50, status: 'stopped', lastBarTime: 250 * MINUTE });
    const market = new FakeMarket(BARS, MINUTE, 400 * MINUTE);
    const { engine, rec, runner } = setup(market, session, createSmaCross(), 'replay');
    runner.start();
    await runner.idle();
    expect(market.subscriptions).toBe(0);
    expect(rec.halts).toEqual([{ reason: 'complete', lastBarTime: 250 * MINUTE }]);
    const reference = new SessionEngine(session, createSmaCross());
    for (const c of BARS.slice(0, 251)) reference.push(c);
    expect(core(engine.result())).toEqual(core(reference.result()));
  });
});
