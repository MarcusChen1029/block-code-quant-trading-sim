import { describe, it, expect } from 'vitest';
import { BinanceFuturesAdapter, type BinanceKlineRow, type WebSocketLike } from '../data/binance';
import type { Candle } from '../data/types';
import type { Strategy } from '../engine/strategy';
import { LiveRunner } from './runner';
import { SessionEngine } from './sessionEngine';
import { ManualTimers, MINUTE, Recorder, testSession } from './testing';

/**
 * Fake Binance futures (based on the reviewer's rv3 scenarios): klines from 0 up to and including the bar that
 * contains serverNow; the FORMING bar carries price 5000, closed bars 100 + (i % 50). /fapi/v1/time answers
 * serverNow unless `timeDown`. `emptyFirst` makes the next kline responses an empty 200.
 */
export function fakeBinance(state: { serverNow: number; timeDown?: boolean; emptyFirst?: number; maxBar?: number }) {
  const calls: string[] = [];
  const fetchFn = async (input: string) => {
    calls.push(input);
    const u = new URL(input);
    if (u.pathname === '/fapi/v1/time') {
      if (state.timeDown) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify({ serverTime: state.serverNow }), { status: 200 });
    }
    if ((state.emptyFirst ?? 0) > 0) {
      state.emptyFirst!--;
      return new Response('[]', { status: 200 });
    }
    const start = Number(u.searchParams.get('startTime'));
    const end = u.searchParams.has('endTime') ? Number(u.searchParams.get('endTime')) : Infinity;
    const limit = Number(u.searchParams.get('limit'));
    const rows: BinanceKlineRow[] = [];
    const now = state.serverNow;
    for (let t = Math.max(0, Math.ceil(start / MINUTE) * MINUTE); t <= end && t <= now && rows.length < limit; t += MINUTE) {
      if (state.maxBar !== undefined && t > state.maxBar * MINUTE) break;
      rows.push(klineRow(t, t + MINUTE > now));
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  return { fetchFn, calls };
}

export const finalPrice = (t: number) => 100 + ((t / MINUTE) % 50);

function klineRow(t: number, forming: boolean): BinanceKlineRow {
  const p = forming ? '5000' : String(finalPrice(t));
  return [t, p, p, p, p, '1', t + MINUTE - 1, '0', 1, '0', '0', '0'];
}

class Socket implements WebSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onopen: (() => void) | null = null;
  close(): void {}
  /** Sends the final (x=true) or forming update of bar `t`. */
  kline(t: number, closed: boolean): void {
    const p = closed ? String(finalPrice(t)) : '5000';
    this.onmessage?.({ data: JSON.stringify({ e: 'kline', k: { t, o: p, h: p, l: p, c: p, v: '1', x: closed } }) });
  }
}

export function liveSetup(state: Parameters<typeof fakeBinance>[0], skewMs: number, session = testSession()) {
  const srv = fakeBinance(state);
  const local = () => state.serverNow + skewMs;
  const sockets: Socket[] = [];
  const adapter = new BinanceFuturesAdapter({
    fetchFn: srv.fetchFn,
    now: local,
    wsFactory: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
    staleAfterMs: 1e12,
  });
  const seen: Candle[] = [];
  const strategy: Strategy = { onBar: (ctx) => { seen.push(ctx.candle); } };
  const engine = new SessionEngine(session, strategy);
  const rec = new Recorder();
  const timers = new ManualTimers();
  const runner = new LiveRunner(engine, adapter, rec, {
    mode: 'live', symbol: 'BTCUSDT', timeframe: '1m', now: local, timers, yieldFn: () => Promise.resolve(),
  });
  return { runner, engine, rec, seen, srv, sockets, timers, adapter };
}

const lastSeen = (seen: Candle[]) => seen[seen.length - 1];
const noForming = (seen: Candle[]) => seen.every((c) => c.close === finalPrice(c.time));

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
