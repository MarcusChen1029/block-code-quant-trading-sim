import { describe, it, expect } from 'vitest';
import type { CandleSubscription, MarketDataAdapter } from '../data/adapter';
import type { Candle } from '../data/types';
import { createSmaCross } from '../engine/strategies/smaCross';
import { exclusive } from '../ui/exclusive';
import { LiveRunner } from './runner';
import { SessionEngine } from './sessionEngine';
import { ManualTimers, MINUTE, Recorder, testSession } from './testing';

describe('start is guarded against double submits', () => {
  it('a second call while the first is still in flight is ignored', async () => {
    let starts = 0;
    let release!: () => void;
    const start = exclusive(async () => {
      starts++;
      await new Promise<void>((r) => { release = r; }); // e.g. stopping the old session, saving the new one
    });
    const a = start();
    const b = start(); // double click / Enter twice
    expect(starts).toBe(1);
    release();
    await Promise.all([a, b]);
    expect(starts).toBe(1);
    const c = start(); // later calls work again
    release();
    await c;
    expect(starts).toBe(2);
  });

  it('frees the guard after a failure', async () => {
    let calls = 0;
    const start = exclusive(async () => {
      calls++;
      throw new Error('boom');
    });
    await expect(start()).rejects.toThrow('boom');
    await expect(start()).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});

describe('unexpected failures inside the runner', () => {
  it('surface as a session error instead of an unhandled rejection', async () => {
    const broken: MarketDataAdapter = {
      name: 'broken',
      fetchCandles: async () => undefined as unknown as Candle[], // a bug or a malformed answer
      subscribeCandles: (): CandleSubscription => ({ close: () => {} }),
    };
    const rec = new Recorder();
    const runner = new LiveRunner(new SessionEngine(testSession(), createSmaCross()), broken, rec, {
      mode: 'live', symbol: 'BTCUSDT', timeframe: '1m', now: () => 50 * MINUTE, timers: new ManualTimers(), yieldFn: () => Promise.resolve(),
    });
    runner.start();
    await runner.idle();
    expect(rec.halts).toHaveLength(1);
    expect(rec.halts[0].reason).toBe('error');
    expect(rec.halts[0].message).toMatch(/^live runner failed: /);
    expect(rec.statuses[rec.statuses.length - 1].state).toBe('stopped');
  });
});
