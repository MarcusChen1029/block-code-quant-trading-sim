import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { fakeBinance, finalPrice } from '../live/binanceFake';
import { LiveRunner } from '../live/runner';
import { blocksSnapshot, snapshotToSpec, type LiveSessionRecord } from '../live/session';
import { SessionEngine } from '../live/sessionEngine';
import { FakeMarket, MINUTE, ManualTimers, Recorder, testSession } from '../live/testing';
import { syntheticCandles } from '../engine/syntheticCandles';
import { buildStrategy } from '../worker/protocol';
import type { MarketDataAdapter } from './adapter';
import { BinanceFuturesAdapter } from './binance';
import { CachedMarketData, openCandleCache, type CandleCache } from './candleCache';
import type { Candle } from './types';

const BARS = syntheticCandles(450, 0, MINUTE);
const KEY = 'fake|BTCUSDT|1m';

async function cacheOrFail(factory = new IDBFactory(), options: Parameters<typeof openCandleCache>[1] = {}): Promise<CandleCache> {
  const cache = await openCandleCache(factory, { keyRange: IDBKeyRange, ...options });
  expect(cache).not.toBeNull();
  return cache!;
}

/** Lets fire-and-forget cache writes (websocket bars) land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

function run(adapter: MarketDataAdapter, session: LiveSessionRecord, now: () => number) {
  const engine = new SessionEngine(session, buildStrategy(snapshotToSpec(blocksSnapshot(defaultWorkspace(), [], []))));
  const rec = new Recorder();
  const runner = new LiveRunner(engine, adapter, rec, {
    mode: 'live', symbol: 'BTCUSDT', timeframe: '1m', now, timers: new ManualTimers(), yieldFn: () => Promise.resolve(),
    closeMarginMs: 0, fetchChunkBars: 120,
  });
  return { engine, rec, runner };
}

const core = (e: SessionEngine) => {
  const r = e.result();
  return { trades: r.trades, fills: r.fills, equityCurve: r.equityCurve, stats: r.stats, finalPosition: r.finalPosition };
};

describe('candle cache (IndexedDB)', () => {
  it('stores closed bars by open time: overlapping writes never duplicate, reads return only covered ranges', async () => {
    const cache = await cacheOrFail();
    await cache.write(KEY, MINUTE, BARS.slice(0, 60), [0, 59 * MINUTE]);
    await cache.write(KEY, MINUTE, BARS.slice(40, 100), [40 * MINUTE, 99 * MINUTE]);
    const got = await cache.read(KEY, 0, 200 * MINUTE);
    expect(got.covered).toEqual([[0, 99 * MINUTE]]);
    expect(got.bars.map((b) => b.time)).toEqual(BARS.slice(0, 100).map((b) => b.time));
    expect(got.bars[10]).toEqual(BARS[10]);
    const part = await cache.read(KEY, 20 * MINUTE, 30 * MINUTE);
    expect(part.covered).toEqual([[20 * MINUTE, 30 * MINUTE]]);
    expect(part.bars).toHaveLength(11);
  });

  it('keeps separate ranges apart and joins adjacent ones', async () => {
    const cache = await cacheOrFail();
    await cache.write(KEY, MINUTE, BARS.slice(0, 10), [0, 9 * MINUTE]);
    await cache.write(KEY, MINUTE, BARS.slice(20, 30), [20 * MINUTE, 29 * MINUTE]);
    expect((await cache.read(KEY, 0, 50 * MINUTE)).covered).toEqual([[0, 9 * MINUTE], [20 * MINUTE, 29 * MINUTE]]);
    await cache.write(KEY, MINUTE, BARS.slice(10, 20), [10 * MINUTE, 19 * MINUTE]);
    expect((await cache.read(KEY, 0, 50 * MINUTE)).covered).toEqual([[0, 29 * MINUTE]]);
  });

  it('series are keyed by symbol + timeframe', async () => {
    const cache = await cacheOrFail();
    await cache.write('fake|BTCUSDT|1m', MINUTE, BARS.slice(0, 10), [0, 9 * MINUTE]);
    expect((await cache.read('fake|ETHUSDT|1m', 0, 9 * MINUTE)).bars).toEqual([]);
    expect((await cache.read('fake|BTCUSDT|5m', 0, 9 * MINUTE)).covered).toEqual([]);
  });

  it('is bounded: least recently used series are evicted first, then the oldest bars of the current one', async () => {
    let now = 1000;
    const cache = await cacheOrFail(new IDBFactory(), { maxBars: 150, now: () => now });
    await cache.write('a', MINUTE, BARS.slice(0, 100), [0, 99 * MINUTE]);
    now = 2000;
    await cache.write('b', MINUTE, BARS.slice(0, 100), [0, 99 * MINUTE]);
    expect((await cache.read('a', 0, 99 * MINUTE)).covered).toEqual([]);
    expect((await cache.read('b', 0, 99 * MINUTE)).bars).toHaveLength(100);
    now = 3000;
    await cache.write('b', MINUTE, BARS.slice(100, 200), [100 * MINUTE, 199 * MINUTE]);
    const b = await cache.read('b', 0, 199 * MINUTE);
    expect(b.bars).toHaveLength(150);
    expect(b.covered).toEqual([[50 * MINUTE, 199 * MINUTE]]);
    expect(b.bars[0].time).toBe(50 * MINUTE);
  });

  it('a read refreshes recency, so a series in use survives eviction', async () => {
    let now = 1000;
    const cache = await cacheOrFail(new IDBFactory(), { maxBars: 150, now: () => now });
    await cache.write('a', MINUTE, BARS.slice(0, 60), [0, 59 * MINUTE]);
    now = 2000;
    await cache.write('b', MINUTE, BARS.slice(0, 60), [0, 59 * MINUTE]);
    now = 3000;
    await cache.read('a', 0, MINUTE);
    now = 4000;
    await cache.write('c', MINUTE, BARS.slice(0, 60), [0, 59 * MINUTE]);
    expect((await cache.read('a', 0, 59 * MINUTE)).bars).toHaveLength(60);
    expect((await cache.read('b', 0, 59 * MINUTE)).bars).toHaveLength(0);
  });

  it('a newer schema version starts empty (old data dropped, never misread)', async () => {
    const factory = new IDBFactory();
    const v1 = await cacheOrFail(factory, { name: 'c', version: 1 });
    await v1.write(KEY, MINUTE, BARS.slice(0, 10), [0, 9 * MINUTE]);
    const v2 = await cacheOrFail(factory, { name: 'c', version: 2 });
    expect(await v2.read(KEY, 0, 9 * MINUTE)).toEqual({ bars: [], covered: [] });
  });

  it('unusable IndexedDB means no cache, silently', async () => {
    const broken = { open: () => { throw new Error('SecurityError'); } } as unknown as IDBFactory;
    expect(await openCandleCache(broken)).toBeNull();
    expect(await openCandleCache(undefined)).toBeNull();
  });
});

describe('CachedMarketData', () => {
  it('a reopened session replays from the cache and fetches only the bars it does not have', async () => {
    const factory = new IDBFactory();
    const session = testSession({ startTime: 200 * MINUTE, warmupBars: 150 });

    // First run: everything from REST (closed bars up to 399), cached on the way.
    const m1 = new FakeMarket(BARS, MINUTE, 400 * MINUTE);
    const first = run(new CachedMarketData(m1, () => openCandleCache(factory, { keyRange: IDBKeyRange })), session, () => m1.now);
    first.runner.start();
    await first.runner.idle();
    first.runner.stop();
    expect(first.engine.lastBarTime).toBe(399 * MINUTE);

    // Reload later: 50 more bars have closed.
    const m2 = new FakeMarket(BARS, MINUTE, 450 * MINUTE);
    const second = run(new CachedMarketData(m2, () => openCandleCache(factory, { keyRange: IDBKeyRange })), session, () => m2.now);
    second.runner.start();
    await second.runner.idle();
    second.runner.stop();
    expect(second.engine.lastBarTime).toBe(449 * MINUTE);
    expect(m2.fetchCalls.length).toBeGreaterThan(0);
    expect(Math.min(...m2.fetchCalls.map(([from]) => from))).toBe(400 * MINUTE); // nothing before 400 from REST

    // Same session straight from REST: identical state.
    const m3 = new FakeMarket(BARS, MINUTE, 450 * MINUTE);
    const rest = run(m3, session, () => m3.now);
    rest.runner.start();
    await rest.runner.idle();
    rest.runner.stop();
    expect(core(second.engine)).toEqual(core(rest.engine));
    expect(rest.engine.result().trades.length).toBeGreaterThan(0);
  });

  it('a gap in the middle of the cache is fetched one bar past its end (the closed-bar rule needs a newer row)', async () => {
    const factory = new IDBFactory();
    const state = { serverNow: 200 * MINUTE, timeDown: true }; // no server clock: the newest row is never trusted
    const srv = fakeBinance(state);
    const inner = new BinanceFuturesAdapter({ fetchFn: srv.fetchFn, now: () => state.serverNow });
    const cache = await cacheOrFail(factory);
    const key = `${inner.name}|BTCUSDT|1m`;
    const bar = (t: number): Candle => ({ time: t, open: finalPrice(t), high: finalPrice(t), low: finalPrice(t), close: finalPrice(t), volume: 1 });
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => bar((a + i) * MINUTE));
    await cache.write(key, MINUTE, range(0, 49), [0, 49 * MINUTE]);
    await cache.write(key, MINUTE, range(60, 99), [60 * MINUTE, 99 * MINUTE]);
    const adapter = new CachedMarketData(inner, () => Promise.resolve(cache));
    const got = await adapter.fetchCandles('BTCUSDT', '1m', 0, 99 * MINUTE);
    expect(got.map((c) => c.time)).toEqual(range(0, 99).map((c) => c.time));
    const klineCalls = srv.calls.filter((u) => u.includes('/klines'));
    expect(klineCalls).toHaveLength(1);
    expect(klineCalls[0]).toContain(`startTime=${50 * MINUTE}`);
    expect(klineCalls[0]).toContain(`endTime=${60 * MINUTE}`);
  });

  it('never caches a forming candle (server clock), and picks the bar up once it has closed', async () => {
    const factory = new IDBFactory();
    const state = { serverNow: 100 * MINUTE + 30_000 };
    const srv = fakeBinance(state);
    const inner = new BinanceFuturesAdapter({ fetchFn: srv.fetchFn, now: () => state.serverNow });
    const cache = await cacheOrFail(factory);
    const adapter = new CachedMarketData(inner, () => Promise.resolve(cache));
    const key = `${inner.name}|BTCUSDT|1m`;
    const a = await adapter.fetchCandles('BTCUSDT', '1m', 0, 101 * MINUTE);
    expect(a.map((c) => c.time).at(-1)).toBe(99 * MINUTE); // bar 100 is forming
    const stored = await cache.read(key, 0, 200 * MINUTE);
    expect(stored.covered).toEqual([[0, 99 * MINUTE]]);
    expect(stored.bars.every((c) => c.close !== 5000)).toBe(true);

    state.serverNow = 101 * MINUTE + 30_000;
    srv.calls.length = 0;
    const b = await adapter.fetchCandles('BTCUSDT', '1m', 0, 101 * MINUTE);
    expect(b.map((c) => c.time).at(-1)).toBe(100 * MINUTE);
    expect(b.at(-1)!.close).toBe(finalPrice(100 * MINUTE));
    expect(srv.calls.filter((u) => u.includes('/klines')).every((u) => u.includes(`startTime=${100 * MINUTE}`))).toBe(true);
  });

  it('websocket bars are never cached (only REST bars that passed the closure rule)', async () => {
    const cache = await cacheOrFail();
    const market = new FakeMarket(BARS, MINUTE, 100 * MINUTE);
    const adapter = new CachedMarketData(market, () => Promise.resolve(cache));
    await adapter.fetchCandles('BTCUSDT', '1m', 0, 100 * MINUTE);
    const seen: Array<[number, boolean]> = [];
    const sub = adapter.subscribeCandles('BTCUSDT', '1m', (c, closed) => seen.push([c.time, closed]));
    market.formingTick(100);
    market.closeBar(100);
    await settle();
    expect(seen).toEqual([[100 * MINUTE, false], [100 * MINUTE, true]]); // live processing unchanged
    expect((await cache.read('fake|BTCUSDT|1m', 0, 200 * MINUTE)).covered).toEqual([[0, 99 * MINUTE]]);
    sub.close();
  });

  it('a websocket final kline that differs from REST never makes a cached replay differ from a REST-only one', async () => {
    const factory = new IDBFactory();
    const session = testSession({ startTime: 200 * MINUTE, warmupBars: 150 });
    const bars = BARS.map((c) => ({ ...c }));
    const m1 = new FakeMarket(bars, MINUTE, 400 * MINUTE);
    const first = run(new CachedMarketData(m1, () => openCandleCache(factory, { keyRange: IDBKeyRange })), session, () => m1.now);
    first.runner.start();
    await first.runner.idle();
    // Bars 400..419 close on the websocket with values REST will not serve (exchange correction, glitch).
    for (let i = 400; i < 420; i++) {
      const rest = bars[i];
      bars[i] = { ...rest, close: rest.close * 1.03, high: Math.max(rest.high, rest.close * 1.03) };
      m1.closeBar(i);
      bars[i] = rest;
      await first.runner.idle();
    }
    await settle();
    first.runner.stop();
    expect(first.engine.lastBarTime).toBe(419 * MINUTE);

    const m2 = new FakeMarket(BARS, MINUTE, 450 * MINUTE);
    const cached = run(new CachedMarketData(m2, () => openCandleCache(factory, { keyRange: IDBKeyRange })), session, () => m2.now);
    cached.runner.start();
    await cached.runner.idle();
    cached.runner.stop();
    const m3 = new FakeMarket(BARS, MINUTE, 450 * MINUTE);
    const rest = run(m3, session, () => m3.now);
    rest.runner.start();
    await rest.runner.idle();
    rest.runner.stop();
    expect(cached.engine.lastBarTime).toBe(449 * MINUTE);
    expect(core(cached.engine)).toEqual(core(rest.engine));
    expect(Math.min(...m2.fetchCalls.map(([from]) => from))).toBe(400 * MINUTE); // REST bars 0..399 still came from the cache
  });

  it('falls back to REST when the cache fails', async () => {
    const market = new FakeMarket(BARS, MINUTE, 100 * MINUTE);
    const failing: CandleCache = {
      read: () => Promise.reject(new Error('QuotaExceededError')),
      write: () => Promise.reject(new Error('QuotaExceededError')),
    };
    const adapter = new CachedMarketData(market, () => Promise.resolve(failing));
    const got = await adapter.fetchCandles('BTCUSDT', '1m', 0, 99 * MINUTE);
    expect(got).toEqual(BARS.slice(0, 100));
    const none = new CachedMarketData(market, () => Promise.resolve(null));
    expect(await none.fetchCandles('BTCUSDT', '1m', 0, 9 * MINUTE)).toEqual(BARS.slice(0, 10));
    const rejected = new CachedMarketData(market, () => Promise.reject(new Error('blocked')));
    expect(await rejected.fetchCandles('BTCUSDT', '1m', 0, 9 * MINUTE)).toEqual(BARS.slice(0, 10));
  });

  it('passes errors of the market itself through (the runner retries them)', async () => {
    const market = new FakeMarket(BARS, MINUTE, 100 * MINUTE);
    market.failNext = 1;
    const adapter = new CachedMarketData(market, () => openCandleCache(new IDBFactory(), { keyRange: IDBKeyRange }));
    await expect(adapter.fetchCandles('BTCUSDT', '1m', 0, 9 * MINUTE)).rejects.toThrow('503');
  });
});

describe('range arithmetic', () => {
  it('missingRanges: the parts of a request the cache does not cover', async () => {
    const { missingRanges, mergeRanges } = await import('./candleCache');
    const M = MINUTE;
    expect(missingRanges(0, 10 * M, [], M)).toEqual([[0, 10 * M]]);
    expect(missingRanges(0, 10 * M, [[0, 10 * M]], M)).toEqual([]);
    expect(missingRanges(0, 10 * M, [[3 * M, 5 * M]], M)).toEqual([[0, 2 * M], [6 * M, 10 * M]]);
    expect(missingRanges(4 * M, 10 * M, [[0, 5 * M], [8 * M, 20 * M]], M)).toEqual([[6 * M, 7 * M]]);
    expect(missingRanges(0, 2 * M, [[5 * M, 9 * M]], M)).toEqual([[0, 2 * M]]);
    expect(mergeRanges([[5 * M, 6 * M], [0, 2 * M], [3 * M, 4 * M], [10 * M, 11 * M]], M)).toEqual([[0, 6 * M], [10 * M, 11 * M]]);
  });
});
