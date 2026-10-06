import { BinanceFuturesAdapter, type BinanceKlineRow, type WebSocketLike } from '../data/binance';
import type { Candle } from '../data/types';
import type { Strategy } from '../engine/strategy';
import { LiveRunner, type RunnerOptions } from './runner';
import { SessionEngine } from './sessionEngine';
import { ManualTimers, MINUTE, Recorder, testSession } from './testing';

/**
 * Fake Binance futures (based on the reviewer's rv3 scenarios): klines from 0 up to and including the bar that
 * contains serverNow; the FORMING bar carries price 5000, closed bars 100 + (i % 50). /fapi/v1/time answers
 * serverNow unless `timeDown`. `emptyFirst` makes the next kline responses an empty 200.
 */
export interface FakeBinanceState {
  serverNow: number;
  timeDown?: boolean;
  /** Next N kline responses are an empty 200 (transient glitch). */
  emptyFirst?: number;
  /** No bars after this index. */
  maxBar?: number;
  /** No bars before this index (symbol listed later). */
  firstBar?: number;
}

export function fakeBinance(state: FakeBinanceState) {
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
    for (let t = Math.max((state.firstBar ?? 0) * MINUTE, Math.ceil(start / MINUTE) * MINUTE); t <= end && t <= now && rows.length < limit; t += MINUTE) {
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

export class Socket implements WebSocketLike {
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

export function liveSetup(state: FakeBinanceState, skewMs: number, session = testSession(), options: Partial<RunnerOptions> = {}) {
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
    mode: 'live', symbol: 'BTCUSDT', timeframe: '1m', now: local, timers, yieldFn: () => Promise.resolve(), ...options,
  });
  return { runner, engine, rec, seen, srv, sockets, timers, adapter };
}

export const lastSeen = (seen: Candle[]) => seen[seen.length - 1];
export const noForming = (seen: Candle[]) => seen.every((c) => c.close === finalPrice(c.time));
