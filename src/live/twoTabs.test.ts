import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect } from 'vitest';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { claimSession, waitForSession, type LockManagerLike } from './ownership';
import { newSessionRecord, smaCrossSnapshot, type LiveSessionRecord } from './session';
import { IndexedDbSessionStore, MemorySessionStore, type SessionStore } from './store';
import { MINUTE } from './testing';

function record(): LiveSessionRecord {
  return newSessionRecord(
    { name: 'shared', symbol: 'BTCUSDT', timeframe: '1m', startMs: 100 * MINUTE, warmupBars: 10, brokerConfig: DEFAULT_BROKER_CONFIG, strategy: smaCrossSnapshot() },
    100 * MINUTE,
    'shared-1',
  );
}

const stores: Array<[string, () => Promise<SessionStore>]> = [
  ['IndexedDB', async () => IndexedDbSessionStore.open(new IDBFactory())],
  ['memory', async () => new MemorySessionStore()],
];

describe.each(stores)('two tabs writing the same session (%s store): merge on write', (_name, open) => {
  it("a tab still holding status 'running' cannot resurrect a session another tab stopped", async () => {
    const store = await open();
    const tabA = record();
    await store.put(tabA);
    // tab B stops it at bar 130
    const tabB = { ...tabA, status: 'stopped' as const, stoppedAt: 5, lastBarTime: 130 * MINUTE };
    await store.put(tabB);
    // tab A, unaware, saves its progress 2 s later
    const stored = await store.put({ ...tabA, lastBarTime: 131 * MINUTE, summary: { equity: 1, returnPct: 0, tradeCount: 0, bars: 1 } }, { onlyIfExists: true });
    expect(await store.get(tabA.id)).toMatchObject({ status: 'stopped', stoppedAt: 5, lastBarTime: 130 * MINUTE });
    expect(stored).toMatchObject({ status: 'stopped', stoppedAt: 5, lastBarTime: 130 * MINUTE });
  });

  it('keeps the later lastBarTime when two running copies race', async () => {
    const store = await open();
    const base = record();
    await store.put({ ...base, lastBarTime: 140 * MINUTE });
    const stored = await store.put({ ...base, lastBarTime: 120 * MINUTE }, { onlyIfExists: true });
    expect((await store.get(base.id))?.lastBarTime).toBe(140 * MINUTE);
    expect(stored?.lastBarTime).toBe(140 * MINUTE);
  });

  it('an update never recreates a session another tab deleted', async () => {
    const store = await open();
    const r = record();
    await store.put(r);
    await store.delete(r.id);
    const result = await store.put({ ...r, lastBarTime: 150 * MINUTE }, { onlyIfExists: true });
    expect(await store.list()).toEqual([]);
    expect(result).toBeNull();
  });
});

/** Web Locks as two tabs of one browser see them: one shared lock table. */
class FakeLocks implements LockManagerLike {
  private held = new Set<string>();
  private waiting = new Map<string, Array<() => void>>();
  request(name: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: { name: string } | null) => Promise<unknown>): Promise<unknown> {
    if (this.held.has(name)) {
      if (options.ifAvailable) return Promise.resolve(callback(null));
      return new Promise((resolve, reject) => {
        const grant = () => resolve(this.run(name, callback));
        options.signal?.addEventListener('abort', () => {
          this.waiting.set(name, (this.waiting.get(name) ?? []).filter((g) => g !== grant));
          reject(new DOMException('aborted', 'AbortError'));
        });
        this.waiting.set(name, [...(this.waiting.get(name) ?? []), grant]);
      });
    }
    return this.run(name, callback);
  }
  private run(name: string, callback: (lock: { name: string } | null) => Promise<unknown>): Promise<unknown> {
    this.held.add(name);
    return Promise.resolve(callback({ name })).finally(() => {
      this.held.delete(name);
      const next = this.waiting.get(name)?.shift();
      next?.();
    });
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('one owner tab per session (Web Locks)', () => {
  it('only the first tab owns a session; the other gets it when the owner lets go', async () => {
    const locks = new FakeLocks();
    const tab1 = await claimSession(locks, 'shared-1');
    expect(tab1).not.toBeNull();
    expect(tab1).not.toBe('unsupported');
    expect(await claimSession(locks, 'shared-1')).toBeNull(); // tab 2: read-only

    let tab2: Awaited<ReturnType<typeof claimSession>> = null;
    const cancel = waitForSession(locks, 'shared-1', (lock) => { tab2 = lock; });
    await tick();
    expect(tab2).toBeNull();
    if (tab1 && tab1 !== 'unsupported') tab1.release(); // tab 1 closed or stopped it
    await tick();
    await tick();
    expect(tab2).not.toBeNull();
    cancel();
  });

  it('a cancelled wait never takes the session', async () => {
    const locks = new FakeLocks();
    const owner = await claimSession(locks, 'x');
    let got = false;
    const cancel = waitForSession(locks, 'x', () => { got = true; });
    cancel();
    if (owner && owner !== 'unsupported') owner.release();
    await tick();
    await tick();
    expect(got).toBe(false);
  });

  it("without Web Locks it reports 'unsupported' (merge-on-write still protects the data)", async () => {
    expect(await claimSession(undefined, 'x')).toBe('unsupported');
  });
});
