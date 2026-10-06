import { describe, it, expect } from 'vitest';
import { liveSetup, noForming } from './binanceFake';
import { MINUTE, testSession } from './testing';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('empty REST chunks are holes only when a later bar proves it', () => {
  it('a transient empty answer on the first 5000-bar chunk skips nothing (E3)', async () => {
    const state = { serverNow: 8000 * MINUTE + 30_000, emptyFirst: 1 };
    const { runner, seen, timers, rec } = liveSetup(state, 0, testSession({ startTime: 6000 * MINUTE, warmupBars: 5000 }));
    runner.start();
    await runner.idle();
    expect(seen).toHaveLength(0); // nothing skipped, nothing processed yet
    expect(rec.statuses[rec.statuses.length - 1].state).toBe('error');
    timers.runTimeouts();
    await runner.idle();
    expect(seen.map((c) => c.time / MINUTE)).toEqual(range(1000, 7999)); // warm-up included, contiguous, once
    expect(noForming(seen)).toBe(true);
  });

  it('a real gap (symbol listed later than the warm-up start) is skipped to the first existing bar', async () => {
    const state = { serverNow: 9000 * MINUTE + 30_000, firstBar: 7000 };
    const { runner, seen } = liveSetup(state, 0, testSession({ startTime: 8000 * MINUTE, warmupBars: 7000 }));
    runner.start();
    await runner.idle();
    expect(seen.map((c) => c.time / MINUTE)).toEqual(range(7000, 8999));
  });

  it('never advances while every answer is empty; resumes where it was once data comes back', async () => {
    const state = { serverNow: 300 * MINUTE + 30_000, emptyFirst: 8 }; // 4 rounds of (chunk + probe)
    const { runner, seen, timers, engine, srv } = liveSetup(state, 0, testSession(), { fetchChunkBars: 50 });
    runner.start();
    for (let i = 0; i < 3; i++) {
      await runner.idle();
      timers.runTimeouts();
    }
    await runner.idle();
    expect(engine.lastBarTime).toBeNull();
    expect(srv.calls.filter((u) => u.includes('limit=1&') || u.endsWith('limit=1')).length).toBeGreaterThan(0); // probed
    for (let i = 0; i < 4; i++) {
      timers.runTimeouts();
      await runner.idle();
    }
    expect(seen.map((c) => c.time / MINUTE)).toEqual(range(0, 299));
  });
});
