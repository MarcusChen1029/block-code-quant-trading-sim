import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BT } from '../../src/blocks/blockTypes';
import { indicator, ifThen, num, slot, workspace } from '../../src/blocks/testing';
import type { BlockState } from '../../src/blocks/workspaceState';
import { DEFAULT_BROKER_CONFIG } from '../../src/engine/types';
import { MINUTE } from '../../src/live/testing';
import { DOUBLE_EMA_SOURCE } from '../../src/pine/templates';
import type { SessionSnapshot } from './sessions';
import { ensurePassword, login, openSse, startHarness, tempDir, waitFor, type Harness } from './testing';

/** Bar open times well after 2017 (validation refuses older starts); T0 is minute-aligned. */
const T0 = Date.UTC(2025, 0, 1);
const at = (minutes: number) => T0 + minutes * MINUTE;

const order = (side: 'buy' | 'sell'): BlockState => ({
  type: BT.marketOrder, id: `order-${side}`, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: slot(num(100)) },
});
const crosses = (op: 'over' | 'under', a: BlockState, b: BlockState): BlockState => ({
  type: BT.crosses, id: `x-${op}`, fields: { OP: op }, inputs: { A: slot(a), B: slot(b) },
});
const dema = (which: 'fast' | 'slow') => indicator('pine_double_ema', { OUT: `${which}_ema`, FASTLENGTH: 5, SLOWLENGTH: 13 });

/** Blocks strategy on a Pine indicator (Double EMA cross), as the browser sends it. */
const SESSION = {
  name: 'pine cross',
  symbol: 'BTCUSDT',
  timeframe: '1m',
  startMs: at(100),
  warmupBars: 20,
  brokerConfig: DEFAULT_BROKER_CONFIG,
  strategy: {
    kind: 'blocks',
    workspace: workspace({ onBar: [ifThen(crosses('over', dema('fast'), dema('slow')), order('buy')), ifThen(crosses('under', dema('fast'), dema('slow')), order('sell'))] }),
    pineScripts: [{ id: 'pine_double_ema', source: DOUBLE_EMA_SOURCE }],
    pineRetired: [],
  },
};

const open: Harness[] = [];
const dirs: Array<ReturnType<typeof tempDir>> = [];

afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
  for (const d of dirs.splice(0)) d.remove();
});

async function harness(serverNow: number, dbPath?: string): Promise<Harness> {
  if (!dbPath) {
    const d = tempDir();
    dirs.push(d);
    dbPath = join(d.dir, 'db.sqlite');
    await ensurePassword(dbPath);
  }
  const h = await startHarness({ serverNow }, dbPath);
  open.push(h);
  return h;
}

/** The session's current state (a snapshot through the manager), once `ready` holds. */
function snapshotWhen(h: Harness, id: string, ready: (s: SessionSnapshot) => boolean, what: string): Promise<SessionSnapshot> {
  return waitFor(() => {
    let snap: SessionSnapshot | null = null;
    const off = h.app.manager.watch(id, (m) => {
      if (m.type === 'snapshot') snap = m.snapshot;
    });
    off?.();
    return snap !== null && ready(snap) ? snap : null;
  }, 15_000, what);
}

describe('server sessions', { timeout: 30_000 }, () => {
  it('a blocks + Pine session runs; SSE delivers its bars and trades; stop and delete work', async () => {
    const h = await harness(at(300));
    const c = await login(h.base);
    const created = await c.call('POST', '/api/sessions', SESSION);
    expect(created.status).toBe(201);
    const id = created.json.session.id as string;
    expect(created.json.session.status).toBe('running');

    const sse = openSse(`${h.base}/api/stream?session=${id}`, c.cookie);
    expect(await sse.status).toBe(200);
    const sessionEvents = () => sse.events.filter((e) => e.event === 'session').map((e) => e.data);
    await waitFor(() => sse.events.some((e) => e.event === 'sessions' && e.data.sessions.some((s: { id: string }) => s.id === id)), 5000, 'session list');
    await waitFor(() => sessionEvents().some((m) => m.type === 'event' && m.event.type === 'status' && m.event.status.lastBarTime === at(298))
      || sessionEvents().some((m) => m.type === 'snapshot' && m.snapshot.status?.lastBarTime === at(298)), 15_000, 'caught up');
    const deltas = sessionEvents().filter((m) => m.type === 'event' && m.event.type === 'delta').map((m) => m.event.delta);
    const snap0 = sessionEvents().find((m) => m.type === 'snapshot').snapshot as SessionSnapshot;
    const bars = [...snap0.candles, ...deltas.flatMap((d) => d.candles)];
    expect(bars[0].time).toBe(at(80)); // first warm-up bar
    expect(bars[bars.length - 1].time).toBe(at(298)); // bar 299 closes exactly now: the close guard waits
    const trades = [...snap0.trades, ...deltas.flatMap((d) => d.trades)];
    expect(trades.length).toBeGreaterThan(0);
    expect(sessionEvents().some((m) => m.type === 'event' && m.event.type === 'program')
      || snap0.indicators !== null).toBe(true);

    // A bar closes on the (fake) websocket: it reaches the viewer over SSE.
    h.market.serverNow = at(301) + 5_000;
    const socket = await waitFor(() => h.sockets[h.sockets.length - 1], 5000, 'socket');
    socket.kline(at(300), false);
    socket.kline(at(300), true);
    await waitFor(() => sessionEvents().some((m) => m.type === 'event' && m.event.type === 'delta' && m.event.delta.candles.some((k: { time: number }) => k.time === at(300))), 10_000, 'websocket bar delta');
    expect(sessionEvents().some((m) => m.type === 'event' && m.event.type === 'tick')).toBe(true);

    const stopped = await c.call('POST', `/api/sessions/${id}/stop`);
    expect(stopped.status).toBe(200);
    expect(stopped.json.session.status).toBe('stopped');
    expect(stopped.json.session.lastBarTime).toBe(at(300));
    await waitFor(() => sessionEvents().some((m) => m.type === 'event' && m.event.type === 'halt' && m.event.halt.reason === 'stopped'), 5000, 'halt over SSE');
    expect((await c.call('GET', `/api/sessions/${id}`)).json.session.status).toBe('stopped');

    expect((await c.call('DELETE', `/api/sessions/${id}`)).status).toBe(204);
    await waitFor(() => sessionEvents().some((m) => m.type === 'deleted'), 5000, 'deleted over SSE');
    expect((await c.call('GET', '/api/sessions')).json.sessions).toEqual([]);
    expect((await c.call('GET', `/api/sessions/${id}`)).status).toBe(404);
    sse.close();
  });

  it('a stopped session is replayed for viewers up to its last bar', async () => {
    const h = await harness(at(300));
    const c = await login(h.base);
    const id = (await c.call('POST', '/api/sessions', SESSION)).json.session.id as string;
    const live = await snapshotWhen(h, id, (s) => s.status?.lastBarTime === at(298), 'caught up');
    await c.call('POST', `/api/sessions/${id}/stop`);
    // nobody watches now: the finished run is dropped, a viewer gets a fresh replay of the stored definition
    const replay = await snapshotWhen(h, id, (s) => s.mode === 'replay' && s.halt?.reason === 'complete', 'replay complete');
    expect(JSON.stringify(replay.trades)).toBe(JSON.stringify(live.trades));
    expect(replay.candles[replay.candles.length - 1].time).toBe(at(298));
  });

  it('after a server restart a running session resumes and its trades equal an uninterrupted run', async () => {
    const d = tempDir();
    dirs.push(d);
    const dbPath = join(d.dir, 'db.sqlite');
    await ensurePassword(dbPath);
    const first = await harness(at(300), dbPath);
    const c1 = await login(first.base);
    const id = (await c1.call('POST', '/api/sessions', SESSION)).json.session.id as string;
    await snapshotWhen(first, id, (s) => s.status?.lastBarTime === at(298), 'first run live');
    await first.close();
    open.splice(open.indexOf(first), 1);

    // 100 minutes later a new server process opens the same database.
    const second = await harness(at(400), dbPath);
    expect(second.app.manager.get(id)?.status).toBe('running');
    const resumed = await snapshotWhen(second, id, (s) => s.status?.lastBarTime === at(398), 'resumed and caught up');

    const control = await harness(at(400));
    const c3 = await login(control.base);
    const controlId = (await c3.call('POST', '/api/sessions', SESSION)).json.session.id as string;
    const uninterrupted = await snapshotWhen(control, controlId, (s) => s.status?.lastBarTime === at(398), 'uninterrupted run');

    expect(uninterrupted.trades.length).toBeGreaterThan(2);
    expect(JSON.stringify(resumed.trades)).toBe(JSON.stringify(uninterrupted.trades));
    expect(JSON.stringify(resumed.fills)).toBe(JSON.stringify(uninterrupted.fills));
    expect(JSON.stringify(resumed.equity)).toBe(JSON.stringify(uninterrupted.equity));
    expect(resumed.candles.length).toBe(uninterrupted.candles.length);
  });
});
