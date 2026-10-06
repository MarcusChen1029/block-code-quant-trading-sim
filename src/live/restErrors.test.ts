import { describe, it, expect } from 'vitest';
import { MarketDataError } from '../data/adapter';
import { BinanceFuturesAdapter } from '../data/binance';
import { liveBadge } from '../ui/liveFormat';
import { fakeBinance, liveSetup } from './binanceFake';
import { MINUTE } from './testing';

const INVALID_SYMBOL = '{"code":-1121,"msg":"Invalid symbol."}';

describe('Binance REST errors are classified', () => {
  const adapterFailing = (status: number, body = '', headers: Record<string, string> = {}) => {
    const srv = fakeBinance({ serverNow: 10 * MINUTE, fail: [{ status, body, headers }] });
    return new BinanceFuturesAdapter({ fetchFn: srv.fetchFn, now: () => 10 * MINUTE });
  };
  const failure = async (adapter: BinanceFuturesAdapter) => {
    try {
      await adapter.fetchCandles('BTCUSDT', '1m', 0, 5 * MINUTE);
    } catch (err) {
      return err;
    }
    throw new Error('expected a rejection');
  };

  it('429 / 418 are rate limits and carry Retry-After', async () => {
    const e429 = await failure(adapterFailing(429, '{"code":-1003,"msg":"Too many requests"}', { 'Retry-After': '7' }));
    expect(e429).toBeInstanceOf(MarketDataError);
    expect(e429).toMatchObject({ kind: 'rate-limited', status: 429, retryAfterMs: 7000 });
    const e418 = await failure(adapterFailing(418, '', { 'Retry-After': '120' }));
    expect(e418).toMatchObject({ kind: 'rate-limited', status: 418, retryAfterMs: 120_000 });
  });

  it('400 invalid symbol and other 4xx are terminal with a clear message; 5xx is transient', async () => {
    const bad = await failure(adapterFailing(400, INVALID_SYMBOL));
    expect(bad).toMatchObject({ kind: 'terminal', status: 400 });
    expect((bad as Error).message).toBe('Binance rejected the request (HTTP 400): Invalid symbol.');
    expect(await failure(adapterFailing(403, 'blocked'))).toMatchObject({ kind: 'terminal', status: 403 });
    expect(await failure(adapterFailing(503, 'down'))).toMatchObject({ kind: 'transient', status: 503 });
  });
});

describe('the runner honours rate limits and stops on terminal errors', () => {
  it('rate limited: shows the state, waits at least Retry-After, then recovers', async () => {
    const state = { serverNow: 100 * MINUTE + 30_000, fail: [{ status: 429, body: 'slow down', headers: { 'Retry-After': '30' } }] };
    const { runner, rec, timers, engine } = liveSetup(state, 0, undefined, { random: () => 0.5 });
    runner.start();
    await runner.idle();
    const s = rec.statuses[rec.statuses.length - 1];
    expect(s.state).toBe('rate-limited');
    expect(s.retryInMs).toBeGreaterThanOrEqual(30_000);
    expect(engine.lastBarTime).toBeNull();
    expect(liveBadge(s, false).text).toBe('RATE LIMITED · retry in 30s');
    timers.runTimeouts();
    await runner.idle();
    expect(engine.lastBarTime).toBe(99 * MINUTE);
  });

  it('transient failures back off exponentially with jitter up to a cap', async () => {
    const fail = Array.from({ length: 7 }, () => ({ status: 503, body: 'unavailable' }));
    const { runner, rec, timers } = liveSetup({ serverNow: 100 * MINUTE + 30_000, fail }, 0, undefined, { random: () => 1 });
    runner.start();
    const delays: number[] = [];
    for (let i = 0; i < 7; i++) {
      await runner.idle();
      delays.push(rec.statuses[rec.statuses.length - 1].retryInMs!);
      timers.runTimeouts();
    }
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000]);
    const jittered = liveSetup({ serverNow: 100 * MINUTE + 30_000, fail: [{ status: 503 }] }, 0, undefined, { random: () => 0 });
    jittered.runner.start();
    await jittered.runner.idle();
    expect(jittered.rec.statuses[jittered.rec.statuses.length - 1].retryInMs).toBe(1000); // jitter: half to full delay
  });

  it('an invalid symbol halts the session with the reason and does not retry', async () => {
    const state = { serverNow: 100 * MINUTE + 30_000, fail: [{ status: 400, body: INVALID_SYMBOL }] };
    const { runner, rec, timers, srv } = liveSetup(state, 0);
    runner.start();
    await runner.idle();
    expect(rec.halts).toEqual([{ reason: 'error', message: 'market data: Binance rejected the request (HTTP 400): Invalid symbol.', lastBarTime: null }]);
    expect(timers.timeouts.size).toBe(0);
    expect(timers.intervals.size).toBe(0);
    const calls = srv.calls.length;
    timers.runTimeouts();
    timers.runIntervals();
    await runner.idle();
    expect(srv.calls.length).toBe(calls);
  });
});
