import type { IndicatorUse } from '../../src/blocks/generator';
import type { Candle } from '../../src/data/types';
import type { EngineActivity } from '../../src/engine/engine';
import type { EquityPoint, Stats } from '../../src/engine/stats';
import type { Fill, LogEntry, PositionView, Trade } from '../../src/engine/types';
import type { LiveEvent } from '../../src/live/host';
import type { HaltInfo, LiveStatus } from '../../src/live/runner';
import { newSessionRecord, type LiveSessionRecord, type NewSessionInput } from '../../src/live/session';
import type { SessionStore } from '../../src/live/store';
import { LiveWorkerSupervisor, type ClientFactory } from '../../src/live/supervisor';

/**
 * Caps on the per-session history the server keeps in memory for snapshots. A 24/7 session processes unbounded
 * bars, but a viewer only ever needs a recent window, so the arrays are bounded here (connected viewers still get
 * every bar/trade live as incremental SSE deltas). Rough memory per full session: candles ~0.9 MB, equity ~0.5 MB,
 * trades up to ~6 MB, log ~1 MB — a few MB, so QS_MAX_RUNNING sessions stay well under the worker heap caps.
 */
export const HISTORY_CAPS = { candles: 20_000, equity: 20_000, trades: 50_000, fills: 50_000, log: 5_000 } as const;

/** Keeps the last `max` of `arr` in place (drops oldest). Returns how many were dropped. */
function capTail<T>(arr: T[], max: number): number {
  if (arr.length <= max) return 0;
  const drop = arr.length - max;
  arr.splice(0, drop);
  return drop;
}

/**
 * Downsamples `points` in place to at most `max`, keeping the newest `max/2` at full resolution and decimating the
 * older part (so the equity curve keeps its recent detail and its overall shape without growing without bound).
 */
function downsampleHead<T>(arr: T[], max: number): void {
  if (arr.length <= max) return;
  const keepTail = Math.floor(max / 2);
  const tail = arr.slice(arr.length - keepTail);
  const headCount = max - keepTail;
  const head = arr.slice(0, arr.length - keepTail);
  const step = head.length / headCount;
  const kept: T[] = [];
  for (let i = 0; i < headCount; i++) kept.push(head[Math.floor(i * step)]);
  arr.length = 0;
  arr.push(...kept, ...tail);
}

/** Everything a viewer needs to draw a session from scratch (the browser's SessionView data). */
export interface SessionSnapshot {
  record: LiveSessionRecord;
  mode: 'live' | 'replay';
  indicators: IndicatorUse[] | null;
  candles: Candle[];
  fills: Fill[];
  trades: Trade[];
  equity: EquityPoint[];
  log: LogEntry[];
  stats: Stats | null;
  wiped: boolean;
  position: PositionView | null;
  activity: EngineActivity | null;
  status: LiveStatus | null;
  forming: Candle | null;
  markEquity: number | null;
  halt: HaltInfo | null;
  /** Worker crashed and is replaying (shown instead of the status until live again). */
  notice: string | null;
  /** Older trades were dropped from this snapshot (the history cap was reached). */
  historyTrimmed: boolean;
}

/** What a watcher of one session receives after its snapshot. */
export type SessionMessage =
  | { type: 'snapshot'; snapshot: SessionSnapshot }
  | { type: 'event'; id: string; event: Exclude<LiveEvent, { type: 'heartbeat' }> }
  /** The worker crashed and a new one replays the session: drop what was received, a new snapshot follows. */
  | { type: 'restarting'; id: string; message: string }
  /** The record changed (progress summary, stop). */
  | { type: 'record'; record: LiveSessionRecord }
  | { type: 'deleted'; id: string }
  /** The session cannot be shown right now (e.g. too many replays at once). */
  | { type: 'unavailable'; id: string; message: string };

export type ListListener = (sessions: LiveSessionRecord[]) => void;
export type SessionListener = (message: SessionMessage) => void;

export interface SessionManagerOptions {
  store: SessionStore;
  createClient: ClientFactory;
  now?: () => number;
  /** Sessions allowed to run at once. */
  maxRunning?: number;
  /** Stopped sessions replayed at once (for viewers). */
  maxReplays?: number;
  /** Sessions kept in the database. */
  maxSessions?: number;
  persistEveryMs?: number;
  /** A replay nobody watches is dropped after this long. */
  replayIdleMs?: number;
  stopTimeoutMs?: number;
  /** Forming-candle ticks forwarded to watchers at most this often per session (closed ones always). */
  tickEveryMs?: number;
}

export class SessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionLimitError';
  }
}

interface Run {
  record: LiveSessionRecord;
  mode: 'live' | 'replay';
  supervisor: LiveWorkerSupervisor | null;
  view: Omit<SessionSnapshot, 'record' | 'mode'>;
  watchers: Set<SessionListener>;
  stopWaiters: Array<() => void>;
  lastTickSent: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const emptyView = (): Run['view'] => ({
  indicators: null, candles: [], fills: [], trades: [], equity: [], log: [], stats: null, wiped: false, position: null,
  activity: null, status: null, forming: null, markEquity: null, halt: null, notice: null, historyTrimmed: false,
});

/**
 * Runs live sessions on the server. Each running session has its own worker under the browser's supervisor (one
 * restart after a crash, a hung worker detected by its missing heartbeat). The session state is a pure function of
 * its definition and the closed candles, so a worker restart or a server restart replays it deterministically from
 * the candle cache and REST. Stopped sessions are replayed on demand for viewers.
 */
export class SessionManager {
  private sessions: LiveSessionRecord[] = [];
  private readonly runs = new Map<string, Run>();
  private readonly listListeners = new Set<ListListener>();
  private readonly now: () => number;
  private readonly opt: Required<Omit<SessionManagerOptions, 'store' | 'createClient' | 'now'>>;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly dirty = new Set<string>();
  private closed = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.now = options.now ?? (() => Date.now());
    this.opt = {
      maxRunning: options.maxRunning ?? 5,
      maxReplays: options.maxReplays ?? 2,
      maxSessions: options.maxSessions ?? 200,
      persistEveryMs: options.persistEveryMs ?? 2000,
      replayIdleMs: options.replayIdleMs ?? 60_000,
      stopTimeoutMs: options.stopTimeoutMs ?? 3000,
      tickEveryMs: options.tickEveryMs ?? 1000,
    };
  }

  /** Loads the sessions and resumes every one left running (server restart). */
  async init(): Promise<void> {
    this.sessions = await this.options.store.list();
    for (const record of this.sessions.filter((s) => s.status === 'running').slice(0, this.opt.maxRunning)) this.startRun(record, 'live');
    for (const extra of this.sessions.filter((s) => s.status === 'running' && !this.runs.has(s.id))) {
      await this.finalise(extra, { reason: 'error', message: 'not resumed: too many running sessions', lastBarTime: extra.lastBarTime });
    }
  }

  list(): LiveSessionRecord[] {
    return this.sessions.map((r) => structuredClone(r));
  }

  get(id: string): LiveSessionRecord | null {
    const r = this.sessions.find((s) => s.id === id);
    return r ? structuredClone(r) : null;
  }

  onList(listener: ListListener): () => void {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  }

  /** Validated input (see validate.ts) -> a running session. */
  async create(input: NewSessionInput): Promise<LiveSessionRecord> {
    if (this.closed) throw new SessionLimitError('the server is shutting down');
    const running = [...this.runs.values()].filter((r) => r.mode === 'live').length;
    if (running >= this.opt.maxRunning) throw new SessionLimitError(`at most ${this.opt.maxRunning} sessions can run at once; stop one first`);
    if (this.sessions.length >= this.opt.maxSessions) throw new SessionLimitError(`at most ${this.opt.maxSessions} sessions can be kept; delete old ones first`);
    const record = newSessionRecord(input, this.now());
    await this.options.store.put(record);
    this.sessions.unshift(record);
    this.startRun(record, 'live');
    this.emitList();
    return structuredClone(record);
  }

  /** Stops a running session; resolves once it is finalised (worker confirmed, or timed out). */
  async stop(id: string): Promise<LiveSessionRecord | null> {
    const record = this.sessions.find((s) => s.id === id);
    if (!record) return null;
    const run = this.runs.get(id);
    if (run && run.mode === 'live' && run.supervisor && !run.view.halt) {
      await new Promise<void>((resolve) => {
        run.stopWaiters.push(resolve);
        run.supervisor!.stop();
        setTimeout(() => {
          if (!run.view.halt) this.onHalt(run, { reason: 'stopped', lastBarTime: run.record.lastBarTime });
        }, this.opt.stopTimeoutMs);
      });
    } else if (record.status === 'running') {
      await this.finalise(record, { reason: 'stopped', lastBarTime: record.lastBarTime });
    }
    return this.get(id);
  }

  async delete(id: string): Promise<boolean> {
    const index = this.sessions.findIndex((s) => s.id === id);
    if (index < 0) return false;
    const run = this.runs.get(id);
    if (run) {
      this.dropRun(run);
      for (const w of run.watchers) w({ type: 'deleted', id });
    }
    this.sessions.splice(index, 1);
    this.dirty.delete(id);
    await this.options.store.delete(id);
    this.emitList();
    return true;
  }

  /**
   * Subscribes to one session: a snapshot now (or once a replay of a stopped session starts), then its events.
   * Returns the unsubscribe function, or null when the session does not exist.
   */
  watch(id: string, listener: SessionListener): (() => void) | null {
    const record = this.sessions.find((s) => s.id === id);
    if (!record) return null;
    let run = this.runs.get(id);
    if (!run) {
      const replays = [...this.runs.values()].filter((r) => r.mode === 'replay').length;
      if (replays >= this.opt.maxReplays) {
        listener({ type: 'unavailable', id, message: `too many sessions are being viewed at once (max ${this.opt.maxReplays} replays); close one and retry` });
        return () => {};
      }
      run = this.startRun(record, 'replay');
    }
    const r = run;
    if (r.idleTimer !== null) {
      clearTimeout(r.idleTimer);
      r.idleTimer = null;
    }
    r.watchers.add(listener);
    listener({ type: 'snapshot', snapshot: this.snapshot(r) });
    return () => {
      r.watchers.delete(listener);
      if (r.mode === 'replay' && r.watchers.size === 0) this.idleDrop(r);
    };
  }

  /** Graceful shutdown: workers stop, progress is flushed; running sessions STAY running and resume next start. */
  async close(): Promise<void> {
    this.closed = true;
    for (const run of [...this.runs.values()]) {
      if (run.mode === 'live') this.dirty.add(run.record.id);
      this.dropRun(run);
    }
    await this.flush();
  }

  private snapshot(run: Run): SessionSnapshot {
    return structuredClone({ record: run.record, mode: run.mode, ...run.view });
  }

  private startRun(record: LiveSessionRecord, mode: 'live' | 'replay'): Run {
    const run: Run = { record, mode, supervisor: null, view: emptyView(), watchers: new Set(), stopWaiters: [], lastTickSent: -Infinity, idleTimer: null };
    this.runs.set(record.id, run);
    run.supervisor = new LiveWorkerSupervisor(record, mode, {
      event: (event) => this.onEvent(run, event),
      restarting: (message) => this.onRestart(run, message),
      fatal: (message) => this.onFatal(run, message),
    }, this.options.createClient);
    return run;
  }

  /** A replay nobody watches is kept a while (a viewer coming back, or polling) and then dropped. */
  private idleDrop(run: Run): void {
    if (run.idleTimer !== null || this.runs.get(run.record.id) !== run) return;
    run.idleTimer = setTimeout(() => {
      run.idleTimer = null;
      if (run.watchers.size === 0) this.dropRun(run);
    }, this.opt.replayIdleMs);
  }

  private dropRun(run: Run): void {
    run.supervisor?.terminate();
    run.supervisor = null;
    if (run.idleTimer !== null) clearTimeout(run.idleTimer);
    run.idleTimer = null;
    if (this.runs.get(run.record.id) === run) this.runs.delete(run.record.id);
  }

  private send(run: Run, message: SessionMessage): void {
    for (const w of run.watchers) w(message);
  }

  private onEvent(run: Run, event: LiveEvent): void {
    const v = run.view;
    switch (event.type) {
      case 'heartbeat':
        return;
      case 'program':
        v.indicators = event.indicators;
        break;
      case 'delta': {
        const d = event.delta;
        v.candles.push(...d.candles);
        v.fills.push(...d.fills);
        v.trades.push(...d.trades);
        v.equity.push(...d.equity);
        v.log.push(...d.log);
        // Bound the in-memory history so a 24/7 session never grows without limit (viewers still got every item
        // live as a delta; a fresh snapshot shows the recent window).
        capTail(v.candles, HISTORY_CAPS.candles);
        capTail(v.fills, HISTORY_CAPS.fills);
        if (capTail(v.trades, HISTORY_CAPS.trades) > 0 && !v.historyTrimmed) v.historyTrimmed = true;
        capTail(v.log, HISTORY_CAPS.log);
        downsampleHead(v.equity, HISTORY_CAPS.equity);
        v.stats = d.stats;
        v.wiped = d.wiped;
        v.position = d.position;
        v.activity = d.activity;
        if (v.forming && v.forming.time <= (d.lastBarTime ?? -Infinity)) v.forming = null;
        if (run.mode === 'live') {
          run.record.lastBarTime = d.lastBarTime;
          run.record.summary = { equity: d.stats.finalEquity, returnPct: d.stats.totalReturnPct, tradeCount: d.stats.tradeCount, bars: d.barsProcessed };
          this.schedulePersist(run.record.id);
        }
        break;
      }
      case 'tick': {
        const last = v.candles.length > 0 ? v.candles[v.candles.length - 1].time : -Infinity;
        if (event.candle.time > last) v.forming = event.candle;
        v.markEquity = event.markEquity;
        const t = this.now();
        if (!event.closed && t - run.lastTickSent < this.opt.tickEveryMs) return;
        run.lastTickSent = t;
        break;
      }
      case 'status':
        v.status = event.status;
        if (v.notice && event.status.state === 'live') v.notice = null;
        break;
      case 'halt':
        this.onHalt(run, event.halt);
        return;
    }
    this.send(run, { type: 'event', id: run.record.id, event });
  }

  private onRestart(run: Run, message: string): void {
    run.view = { ...emptyView(), notice: `worker crashed — restarting (${message})` };
    this.send(run, { type: 'restarting', id: run.record.id, message });
    this.send(run, { type: 'snapshot', snapshot: this.snapshot(run) });
  }

  private onFatal(run: Run, message: string): void {
    run.supervisor = null;
    if (run.stopWaiters.length > 0) {
      this.onHalt(run, { reason: 'stopped', lastBarTime: run.record.lastBarTime });
      return;
    }
    run.view.notice = null;
    this.onHalt(run, { reason: 'error', message: `live worker crashed twice: ${message}`, lastBarTime: run.record.lastBarTime });
  }

  private onHalt(run: Run, halt: HaltInfo): void {
    if (run.view.halt) return;
    run.view.halt = halt;
    run.view.notice = null;
    run.supervisor?.terminate();
    run.supervisor = null;
    this.send(run, { type: 'event', id: run.record.id, event: { type: 'halt', halt } });
    const waiters = run.stopWaiters.splice(0);
    if (run.mode === 'live') {
      // The finished view stays available as a replay for current watchers; a new one is built on demand.
      run.mode = 'replay';
      if (run.watchers.size === 0) this.dropRun(run);
      void this.finalise(run.record, halt).then(() => {
        for (const done of waiters) done();
      });
    } else {
      for (const done of waiters) done();
      if (run.watchers.size === 0) this.idleDrop(run);
    }
  }

  /** A running session stops for good: the record is stored stopped with its last bar and reason. */
  private async finalise(record: LiveSessionRecord, halt: HaltInfo): Promise<void> {
    if (record.status === 'running') {
      record.status = 'stopped';
      record.stoppedAt = this.now();
      if (halt.lastBarTime !== null) record.lastBarTime = halt.lastBarTime;
      if (halt.reason === 'error') {
        record.stopReason = 'error';
        record.error = halt.blockId !== undefined ? { message: halt.message ?? 'error', blockId: halt.blockId } : { message: halt.message ?? 'error' };
      } else if (halt.reason === 'wiped') {
        record.stopReason = 'wiped';
      }
    }
    this.dirty.delete(record.id);
    try {
      const stored = await this.options.store.put(record, { onlyIfExists: true });
      if (stored) Object.assign(record, stored);
    } catch (err) {
      console.error(`could not store session ${record.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const run = this.runs.get(record.id);
    if (run) this.send(run, { type: 'record', record: structuredClone(record) });
    this.emitList();
  }

  private schedulePersist(id: string): void {
    this.dirty.add(id);
    if (this.persistTimer !== null || this.closed) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.flush().then(() => this.emitList());
    }, this.opt.persistEveryMs);
  }

  private async flush(): Promise<void> {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    for (const id of [...this.dirty]) {
      this.dirty.delete(id);
      const record = this.sessions.find((s) => s.id === id);
      if (!record) continue;
      try {
        await this.options.store.put(record, { onlyIfExists: true });
      } catch (err) {
        console.error(`could not store session ${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private emitList(): void {
    if (this.listListeners.size === 0) return;
    const list = this.list();
    for (const l of this.listListeners) l(list);
  }
}
