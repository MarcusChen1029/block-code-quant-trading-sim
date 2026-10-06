import { describe, it, expect } from 'vitest';
import { BinanceFuturesAdapter } from '../data/binance';
import { finalPrice, lastSeen, liveSetup, noForming } from './binanceFake';
import { MINUTE, testSession } from './testing';

describe('live closing decisions use the server clock, never the local one', () => {
  it('a local clock 25 s FAST never lets the forming REST bar reach the strategy (E1)', async () => {
    const state = { serverNow: 100 * MINUTE + 50_000 }; // bar 100 forming; it really closes at 101:00
    const { runner, seen, sockets } = liveSetup(state, 25_000);
    runner.start();
    await runner.idle();
    expect(lastSeen(seen).time).toBe(99 * MINUTE);
    expect(noForming(seen)).toBe(true);
    // the real final candle arrives on the socket and is processed (not dropped as a duplicate)
    state.serverNow = 101 * MINUTE + 100;
    sockets[0].kline(100 * MINUTE, true);
    await runner.idle();
    expect(lastSeen(seen)).toMatchObject({ time: 100 * MINUTE, close: finalPrice(100 * MINUTE) });
    expect(noForming(seen)).toBe(true);
  });

  it('a local clock 120 s BEHIND only delays: every closed bar is processed once server time is known', async () => {
    const state = { serverNow: 100 * MINUTE + 50_000 };
    const { runner, seen } = liveSetup(state, -120_000);
    runner.start();
    await runner.idle();
    expect(lastSeen(seen).time).toBe(99 * MINUTE);
    expect(seen).toHaveLength(100);
    expect(noForming(seen)).toBe(true);
  });

  it('time endpoint down: the newest REST row is never accepted on the local clock; the websocket confirms it', async () => {
    const state = { serverNow: 100 * MINUTE + 50_000, timeDown: true };
    const { runner, seen, sockets, timers } = liveSetup(state, 25_000);
    runner.start();
    await runner.idle();
    expect(lastSeen(seen).time).toBe(99 * MINUTE);
    expect(noForming(seen)).toBe(true);
    // bar 100 closes; the socket says so -> processed with its final price
    state.serverNow = 101 * MINUTE + 2_000;
    sockets[0].kline(100 * MINUTE, true);
    await runner.idle();
    expect(lastSeen(seen)).toMatchObject({ time: 100 * MINUTE, close: finalPrice(100 * MINUTE) });
    // socket goes quiet for minutes; the heartbeat backfills only bars REST proves closed (a later bar exists)
    state.serverNow = 104 * MINUTE + 30_000;
    timers.runIntervals();
    await runner.idle();
    timers.runTimeouts();
    await runner.idle();
    expect(lastSeen(seen).time).toBe(103 * MINUTE);
    expect(seen.map((c) => c.time / MINUTE)).toEqual(Array.from({ length: 104 }, (_, i) => i));
    expect(noForming(seen)).toBe(true);
  });

  it('a 4320-bar catch-up pages contiguously and processes every bar once (E2)', async () => {
    const state = { serverNow: 4400 * MINUTE + 30_000 };
    const { runner, seen } = liveSetup(state, 0, testSession({ startTime: 80 * MINUTE, warmupBars: 0 }));
    runner.start();
    await runner.idle();
    const times = seen.map((c) => c.time / MINUTE);
    expect(times).toEqual(Array.from({ length: 4320 }, (_, i) => 80 + i));
    expect(noForming(seen)).toBe(true);
  });
});

describe('BinanceFuturesAdapter server clock', () => {
  it('measures the offset at the RTT midpoint and refreshes it when stale', async () => {
    let local = 1_000_000;
    let timeCalls = 0;
    const fetchFn = async (input: string) => {
      if (new URL(input).pathname === '/fapi/v1/time') {
        timeCalls++;
        local += 200; // 200 ms round trip; the server stamped the middle of it
        return new Response(JSON.stringify({ serverTime: local - 100 + 30_000 }), { status: 200 });
      }
      return new Response('[]', { status: 200 });
    };
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => local, clockRefreshMs: 300_000 });
    expect(adapter.serverNow()).toBeNull();
    await adapter.fetchCandles('BTCUSDT', '1m', 0, MINUTE);
    expect(adapter.serverNow()).toBe(local + 30_000);
    await adapter.fetchCandles('BTCUSDT', '1m', 0, MINUTE);
    expect(timeCalls).toBe(1);
    local += 300_001;
    await adapter.fetchCandles('BTCUSDT', '1m', 0, MINUTE);
    expect(timeCalls).toBe(2);
  });
});
