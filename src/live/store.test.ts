import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, it, expect } from 'vitest';
import { BT } from '../blocks/blockTypes';
import { ifThen, indicator, num, slot, workspace } from '../blocks/testing';
import type { BlockState } from '../blocks/workspaceState';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { syncPineIndicators, type PineSourceRecord } from '../pine/library';
import { DOUBLE_EMA_SOURCE } from '../pine/templates';
import { createLiveHost, type LiveEvent } from './host';
import { blocksSnapshot, newSessionRecord, parseSessionRecord, smaCrossSnapshot, type LiveSessionRecord } from './session';
import { IndexedDbSessionStore, MemorySessionStore, openSessionStore } from './store';
import { FakeMarket, MINUTE, ManualTimers } from './testing';
import { syntheticCandles } from '../engine/syntheticCandles';

afterEach(() => {
  syncPineIndicators([]);
});

const BARS = syntheticCandles(500, 0, MINUTE);

function record(overrides: Partial<LiveSessionRecord> = {}): LiveSessionRecord {
  return {
    ...newSessionRecord(
      { name: 'BTC test', symbol: 'BTCUSDT', timeframe: '1m', startMs: 200 * MINUTE + 1234, warmupBars: 100, brokerConfig: DEFAULT_BROKER_CONFIG, strategy: smaCrossSnapshot() },
      300 * MINUTE,
      'sess-1',
    ),
    ...overrides,
  };
}

describe('session records', () => {
  it('align the start to the bar open, clamp warm-up and reject malformed storage', () => {
    const r = record();
    expect(r.startTime).toBe(200 * MINUTE);
    expect(r.status).toBe('running');
    expect(parseSessionRecord(structuredClone(r))).toEqual(r);
    expect(parseSessionRecord({ ...r, timeframe: '7m' })).toBeNull();
    expect(parseSessionRecord({ ...r, startTime: r.startTime + 1 })).toBeNull();
    expect(parseSessionRecord({ ...r, strategy: { kind: 'eval' } })).toBeNull();
    expect(parseSessionRecord(null)).toBeNull();
    const future = newSessionRecord({ name: '', symbol: 'ETHUSDT', timeframe: '5m', startMs: 9e15, warmupBars: 1e9, brokerConfig: DEFAULT_BROKER_CONFIG, strategy: smaCrossSnapshot() }, 3_000_000);
    expect(future.startTime).toBe(3_000_000); // never in the future: "now" is the forming bar
    expect(future.warmupBars).toBe(5000);
    expect(future.name).toMatch(/^ETHUSDT 5m /);
  });
});

describe('IndexedDB session store', () => {
  it('round-trips a definition (copies, newest first, updates, delete)', async () => {
    const store = await IndexedDbSessionStore.open(new IDBFactory());
    const a = record();
    const b = record({ id: 'sess-2', createdAt: a.createdAt + 1, name: 'second' });
    await store.put(a);
    await store.put(b);
    a.name = 'mutated after put';
    expect((await store.get('sess-1'))?.name).toBe('BTC test');
    expect((await store.list()).map((r) => r.id)).toEqual(['sess-2', 'sess-1']);
    await store.put({ ...b, status: 'stopped', stoppedAt: 5, lastBarTime: 250 * MINUTE, summary: { equity: 1, returnPct: 2, tradeCount: 3, bars: 4 } });
    expect(await store.get('sess-2')).toMatchObject({ status: 'stopped', stoppedAt: 5, lastBarTime: 250 * MINUTE, summary: { tradeCount: 3 } });
    await store.delete('sess-1');
    expect((await store.list()).map((r) => r.id)).toEqual(['sess-2']);
    store.close();
  });

  it('survives a "reload": a new connection to the same database sees the sessions', async () => {
    const factory = new IDBFactory();
    const first = await IndexedDbSessionStore.open(factory, 'reload-db');
    await first.put(record());
    first.close();
    const { store, notice } = await openSessionStore(factory, 'reload-db');
    expect(notice).toBeUndefined();
    expect(store.persistent).toBe(true);
    expect((await store.list()).map((r) => r.id)).toEqual(['sess-1']);
  });

  it('falls back to memory with a notice when IndexedDB is unavailable or broken', async () => {
    const none = await openSessionStore(undefined);
    expect(none.store).toBeInstanceOf(MemorySessionStore);
    expect(none.store.persistent).toBe(false);
    expect(none.notice).toMatch(/in memory only \(IndexedDB is not available\)/);

    const throwing = { open: () => { throw new Error('SecurityError: access denied'); } } as unknown as IDBFactory;
    const denied = await openSessionStore(throwing);
    expect(denied.notice).toMatch(/SecurityError: access denied/);
    await denied.store.put(record());
    expect((await denied.store.list()).map((r) => r.id)).toEqual(['sess-1']);
  });
});

// --- reload-resume and snapshot isolation, through the worker host ---

const crosses = (op: 'over' | 'under', a: BlockState, b: BlockState): BlockState => ({
  type: BT.crosses, id: `x-${op}`, fields: { OP: op }, inputs: { A: slot(a), B: slot(b) },
});
const order = (side: 'buy' | 'sell'): BlockState => ({
  type: BT.marketOrder, id: `order-${side}`, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: slot(num(100)) },
});
function pineCrossWorkspace(fast: number) {
  const line = (which: 'fast' | 'slow') => indicator('pine_double_ema', { OUT: `${which}_ema`, FASTLENGTH: fast, SLOWLENGTH: 21 });
  return workspace({
    onBar: [
      ifThen(crosses('over', line('fast'), line('slow')), order('buy')),
      ifThen(crosses('under', line('fast'), line('slow')), order('sell')),
    ],
  });
}

interface Collected { fills: unknown[]; trades: unknown[]; equity: unknown[]; lastBarTime: number | null; halts: unknown[] }

/** Runs a session through the worker host (as the page would) until idle; returns what the page received. */
async function runHost(session: LiveSessionRecord, market: FakeMarket, mode: 'live' | 'replay' = 'live', afterStart?: () => Promise<void>) {
  const events: LiveEvent[] = [];
  const host = createLiveHost((e) => events.push(structuredClone(e)), market, {
    now: () => market.now, timers: new ManualTimers(), yieldFn: () => Promise.resolve(), closeMarginMs: 0,
  });
  host.handle({ type: 'start', session: structuredClone(session), mode });
  await host.idle();
  if (afterStart) {
    await afterStart();
    await host.idle();
  }
  const out: Collected = { fills: [], trades: [], equity: [], lastBarTime: null, halts: [] };
  for (const e of events) {
    if (e.type === 'delta') {
      out.fills.push(...e.delta.fills);
      out.trades.push(...e.delta.trades);
      out.equity.push(...e.delta.equity);
      out.lastBarTime = e.delta.lastBarTime;
    }
    if (e.type === 'halt') out.halts.push(e.halt);
  }
  return { out, events, host };
}

describe('reload-resume', () => {
  it('a running session rebuilt from the store + candles equals the uninterrupted run', async () => {
    const editorPine: PineSourceRecord[] = [{ id: 'pine_double_ema', source: DOUBLE_EMA_SOURCE }];
    const session = record({ strategy: blocksSnapshot(pineCrossWorkspace(9), editorPine, []) });
    const store = await IndexedDbSessionStore.open(new IDBFactory());
    await store.put(session);

    // Uninterrupted: the page stays open from bar 300 to bar 499.
    const steady = new FakeMarket(BARS, MINUTE, 300 * MINUTE);
    const uninterrupted = await runHost(session, steady, 'live', async () => {
      for (let i = 300; i < 500; i++) steady.closeBar(i);
    });
    expect(uninterrupted.out.trades.length).toBeGreaterThan(3);
    expect(uninterrupted.out.lastBarTime).toBe(499 * MINUTE);

    // Interrupted: the page runs to bar 349, is closed, and reopens when bar 499 has closed.
    const first = new FakeMarket(BARS, MINUTE, 300 * MINUTE);
    const before = await runHost(session, first, 'live', async () => {
      for (let i = 300; i < 350; i++) first.closeBar(i);
    });
    expect(before.out.lastBarTime).toBe(349 * MINUTE);
    await store.put({ ...session, lastBarTime: before.out.lastBarTime }); // the page saves progress as it goes

    const reopened = (await store.list()).find((r) => r.status === 'running')!;
    const later = new FakeMarket(BARS, MINUTE, 500 * MINUTE);
    const after = await runHost(reopened, later);
    expect(after.out).toEqual(uninterrupted.out);
    expect(after.events.find((e) => e.type === 'program')).toBeDefined(); // overlays come from the snapshot
  });

  it('a stopped session replays to exactly its last bar', async () => {
    const session = record({ status: 'stopped', lastBarTime: 260 * MINUTE });
    const replay = await runHost(session, new FakeMarket(BARS, MINUTE, 500 * MINUTE), 'replay');
    expect(replay.out.lastBarTime).toBe(260 * MINUTE);
    expect(replay.out.halts).toEqual([{ reason: 'complete', lastBarTime: 260 * MINUTE }]);
  });

  it("a session's strategy snapshot is unaffected by later edits to the blocks and Pine scripts", async () => {
    const editorWorkspace = pineCrossWorkspace(9);
    const editorPine: PineSourceRecord[] = [{ id: 'pine_double_ema', source: DOUBLE_EMA_SOURCE }];
    const session = record({ strategy: blocksSnapshot(editorWorkspace, editorPine, []) });
    const store = new MemorySessionStore();
    await store.put(session);
    const reference = await runHost(session, new FakeMarket(BARS, MINUTE, 500 * MINUTE));

    // The user edits the blocks (fast length 9 -> 4) and the Pine script (the slow EMA becomes an SMA) afterwards.
    const edited = pineCrossWorkspace(4);
    Object.assign(editorWorkspace, edited);
    editorPine[0].source = DOUBLE_EMA_SOURCE.replace(/ta\.ema\(src, slowLength\)/, 'ta.sma(src, slowLength)');
    expect(editorPine[0].source).not.toBe(DOUBLE_EMA_SOURCE);
    syncPineIndicators(editorPine); // the page's registry now holds the edited script

    const stored = (await store.get(session.id))!;
    expect(stored.strategy).toEqual(session.strategy);
    const rerun = await runHost(stored, new FakeMarket(BARS, MINUTE, 500 * MINUTE));
    expect(rerun.out).toEqual(reference.out);

    // ...while a NEW session from the edited editor state trades differently.
    const fresh = record({ id: 'sess-new', strategy: blocksSnapshot(editorWorkspace, editorPine, []) });
    const changed = await runHost(fresh, new FakeMarket(BARS, MINUTE, 500 * MINUTE));
    expect(changed.out.trades).not.toEqual(reference.out.trades);
  });

  it('a snapshot that does not compile halts at start with the block id', async () => {
    const ws = pineCrossWorkspace(9);
    const session = record({ strategy: blocksSnapshot(ws, [], []) }); // the Pine script is missing
    const { out } = await runHost(session, new FakeMarket(BARS, MINUTE, 500 * MINUTE));
    expect(out.halts).toHaveLength(1);
    expect(out.halts[0]).toMatchObject({ reason: 'error', lastBarTime: null });
    expect((out.halts[0] as { message: string }).message).toMatch(/^strategy cannot start: /);
    expect((out.halts[0] as { blockId?: string }).blockId).toBeDefined();
  });
});
