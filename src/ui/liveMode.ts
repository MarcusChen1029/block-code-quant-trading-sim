import type { IndicatorUse } from '../blocks/generator';
import { getIndicator, PINE_ID_PREFIX, type IndicatorBlockDef } from '../blocks/registry';
import { timeframeToMs, type Candle, type Timeframe } from '../data/types';
import type { EquityPoint, Stats } from '../engine/stats';
import type { EngineActivity } from '../engine/engine';
import type { BrokerConfig, Fill, LogEntry, PositionView, Trade } from '../engine/types';
import type { LiveEvent } from '../live/host';
import type { HaltInfo, LiveStatus } from '../live/runner';
import { MAX_WARMUP_BARS, newSessionRecord, type LiveSessionRecord, type StrategySnapshot } from '../live/session';
import { browserLocks, claimSession, waitForSession, type SessionLock } from '../live/ownership';
import { openSessionStore, type SessionStore } from '../live/store';
import { LiveWorkerSupervisor } from '../live/supervisor';
import { compilePine } from '../pine/compile';
import { pineIndicatorDef } from '../pine/library';
import { blockIndicatorOverlays, liveSessionOverlays } from './blockOverlays';
import type { ChartPanel } from './chart';
import { fmtNum } from './format';
import { liveBadge, parseUtcDateTime, sessionRow } from './liveFormat';
import { exclusive } from './exclusive';
import { createLivePanel, type LiveForm, type LivePanel } from './livePanel';
import { fillsToMarkers, sessionStartMarker } from './markers';
import { smaOverlay, type OverlayDef } from './overlays';
import { MAX_BARS } from './settings';
import type { StatsPanel } from './statsPanel';
import { loadJson, saveJson } from './storage';
import { parseSavedView, preserveRange, restoreSavedView, saveView, type SavedView } from './viewRange';

/** Per-session chart views (zoom / scroll by bar time), so a reload shows the session as it was left. */
export const LIVE_VIEWS_STORAGE_KEY = 'quant-sim.live-views';
const MAX_SAVED_VIEWS = 50;

function loadSavedViews(): Record<string, unknown> {
  const raw = loadJson(LIVE_VIEWS_STORAGE_KEY);
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function storeSavedView(id: string, view: SavedView | null): void {
  const all = loadSavedViews();
  delete all[id];
  if (view) all[id] = view;
  const ids = Object.keys(all);
  for (const old of ids.slice(0, Math.max(0, ids.length - MAX_SAVED_VIEWS))) delete all[old];
  saveJson(LIVE_VIEWS_STORAGE_KEY, all);
}

export type SessionBase =
  | { ok: true; symbol: string; timeframe: Timeframe; brokerConfig: BrokerConfig; strategy: StrategySnapshot }
  | { ok: false; error: string };

export interface LiveModeDeps {
  chart: ChartPanel;
  stats: StatsPanel;
  setStatus(text: string, isError?: boolean): void;
  highlightBlock(blockId: string, message: string): void;
  /** Top-bar product/timeframe/account and a snapshot of the selected strategy (or why there is none). */
  sessionBase(): SessionBase;
  /** Overlays the user picked in the top bar. */
  extraOverlays(): OverlayDef[];
  confirm(message: string): boolean;
  now(): number;
}

/** Page-side state of one session shown or running (its worker is the source of truth). */
interface SessionView {
  record: LiveSessionRecord;
  mode: 'live' | 'replay';
  client: LiveWorkerSupervisor | null;
  candles: Candle[];
  fills: Fill[];
  trades: Trade[];
  equity: EquityPoint[];
  log: LogEntry[];
  stats: Stats | null;
  wiped: boolean;
  status: LiveStatus | null;
  forming: Candle | null;
  markEquity: number | null;
  indicators: IndicatorUse[] | null;
  overlays: OverlayDef[] | null;
  halt: HaltInfo | null;
  stopWaiters: Array<() => void>;
  /** What the chart/stats already show, for incremental drawing. */
  drawn: { candles: number; fills: number; trades: number; equity: number; log: number; chartTime: number; startMarked: boolean };
  /** Bars whose FINAL (closed) websocket update is already on the chart. */
  closedTicked: Set<number>;
  /** The view stored for this session before a reload, shown once its bars are loaded. */
  pendingView: SavedView | null;
  /** Shown instead of the status badge (worker restarting) until the session is live again. */
  notice: string | null;
  /** From the last delta: open position and order diagnostics (verdict). */
  position: PositionView | null;
  activity: EngineActivity | null;
}

const PERSIST_EVERY_MS = 2000;
const STOP_TIMEOUT_MS = 3000;

/**
 * Live mode: starts, resumes, views, stops and deletes paper-trading sessions. One session runs at a time (its
 * worker keeps going in Backtest mode too); one more can be viewed read-only (a stopped session replayed in
 * its own worker).
 *
 * Several tabs: a running session is run by ONE tab, the holder of its Web Lock. Other tabs show it read-only
 * ("running in another tab") and take it over if that tab closes. Writes merge in the store (a stop is final),
 * and tabs tell each other about changes on a BroadcastChannel.
 */
export class LiveMode {
  private store: SessionStore | null = null;
  private sessions: LiveSessionRecord[] = [];
  private running: SessionView | null = null;
  private viewed: SessionView | null = null;
  private active = false;
  private renderQueued = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** The session whose bars the chart shows right now (null: none, or Backtest mode drew over it). */
  private chartShows: SessionView | null = null;
  private viewSaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly panel: LivePanel;
  /** Start is guarded synchronously: a double submit never starts two sessions (two workers). */
  private readonly startOnce = exclusive((form: LiveForm) => this.start(form));
  private readonly locks = browserLocks();
  /** Sessions this tab runs, with their lock ('unsupported' = no Web Locks: merge-on-write only). */
  private readonly owned = new Map<string, SessionLock | 'unsupported'>();
  /** Sessions another tab runs that this tab will take over when that tab lets go. */
  private readonly takeovers = new Map<string, () => void>();
  private readonly channel: BroadcastChannel | null = typeof BroadcastChannel === 'function' ? new BroadcastChannel('quant-sim-live') : null;

  constructor(container: HTMLElement, private readonly deps: LiveModeDeps) {
    this.panel = createLivePanel(container, {
      onStart: (form) => void this.startOnce(form),
      onOpen: (id) => this.open(id),
      onStop: (id) => void this.stop(id),
      onDelete: (id) => void this.remove(id),
    }, deps.now());
    const resync = () => this.running?.client?.resync();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resync();
    });
    window.addEventListener('online', resync);
    deps.chart.onVisibleRangeChange(() => this.scheduleViewSave());
    if (import.meta.env.DEV) {
      // Dev-only checks from the console / browser automation: simulate a worker crash or hang, read the state.
      (window as unknown as { __quantLive?: unknown }).__quantLive = {
        crashWorker: (action: 'throw' | 'hang' = 'throw') => this.running?.client?.debug(action),
        state: () => {
          const v = this.viewed;
          return v && {
            id: v.record.id, mode: v.mode, status: v.status?.state ?? null, notice: v.notice, halt: v.halt, recordStatus: v.record.status,
            error: v.record.error ?? null, candles: v.candles.length, fills: v.fills.length, lastBarTime: v.record.lastBarTime,
            visibleRange: this.deps.chart.visibleRange(), barTimes: this.deps.chart.barTimes().length,
            zones: this.deps.chart.zoneCounts(), zoneRects: this.deps.chart.zoneRects().length, signals: this.deps.chart.signalCounts(),
          };
        },
      };
    }
    this.channel?.addEventListener('message', (ev: MessageEvent<{ id?: unknown }>) => {
      if (typeof ev.data?.id === 'string') void this.onRemoteChange(ev.data.id);
    });
  }

  /** Opens the store and resumes a session left running. Returns whether one was resumed. */
  async init(): Promise<boolean> {
    const { store, notice } = await openSessionStore();
    this.store = store;
    this.panel.setNotice(notice ?? null);
    try {
      this.sessions = await store.list();
    } catch (err) {
      this.panel.setNotice(`Could not read saved sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
    const running = this.sessions.filter((s) => s.status === 'running');
    // v1 runs one session; should storage hold more (e.g. an old bug, two tabs), keep the newest.
    for (const extra of running.slice(1)) {
      extra.status = 'stopped';
      extra.stoppedAt = this.deps.now();
      await this.persist(extra);
    }
    this.renderList();
    if (running.length > 0) {
      await this.resume(running[0]);
      return true;
    }
    return false;
  }

  /** Runs a 'running' session here unless another tab does; then it is shown read-only and taken over later. */
  private async resume(record: LiveSessionRecord): Promise<void> {
    const claim = this.running && this.running.record.id !== record.id ? null : await claimSession(this.locks, record.id);
    if (claim !== null) {
      this.owned.set(record.id, claim);
      this.openView(record, 'live');
      this.deps.setStatus(`Resumed live session "${record.name}": replaying its bars from ${record.symbol} history, then following the live stream.`);
      return;
    }
    this.openView(record, 'replay'); // read-only, up to its last saved bar
    this.deps.setStatus(`Live session "${record.name}" is running in another tab; it is shown read-only here.`);
    if (!this.takeovers.has(record.id)) {
      this.takeovers.set(record.id, waitForSession(this.locks, record.id, (lock) => void this.takeOver(record.id, lock)));
    }
  }

  /** The tab that ran session `id` let go (closed, or stopped it): run it here if it is still running. */
  private async takeOver(id: string, lock: SessionLock): Promise<void> {
    this.takeovers.delete(id);
    let fresh: LiveSessionRecord | null = null;
    try {
      fresh = (await this.store?.get(id)) ?? null;
    } catch {
      fresh = null;
    }
    if (!fresh || fresh.status !== 'running' || this.running) {
      lock.release();
      if (fresh) this.adoptRemote(fresh);
      else this.dropRemote(id);
      return;
    }
    this.owned.set(id, lock);
    const local = this.adoptRemote(fresh);
    if (this.viewed?.record.id === id) {
      this.viewed.client?.terminate();
      this.viewed.client = null;
    }
    this.openView(local, 'live');
    this.deps.setStatus(`Live session "${local.name}" was running in a tab that closed; it runs in this tab now.`);
  }

  private releaseOwnership(id: string): void {
    const owned = this.owned.get(id);
    if (owned && owned !== 'unsupported') owned.release();
    this.owned.delete(id);
  }

  private announce(id: string): void {
    this.channel?.postMessage({ type: 'changed', id });
  }

  /** Another tab changed session `id` in the store. */
  private async onRemoteChange(id: string): Promise<void> {
    let fresh: LiveSessionRecord | null;
    try {
      fresh = (await this.store?.get(id)) ?? null;
    } catch {
      return;
    }
    if (fresh === null) this.dropRemote(id);
    else this.adoptRemote(fresh);
  }

  /**
   * Brings a stored record into this tab. A stop made elsewhere halts the session if this tab runs it (its final
   * write merges into the stored stop, which keeps the stop's last bar).
   */
  private adoptRemote(fresh: LiveSessionRecord): LiveSessionRecord {
    let local = this.sessions.find((s) => s.id === fresh.id);
    if (!local) {
      local = fresh;
      this.sessions.push(fresh);
      this.sessions.sort((a, b) => b.createdAt - a.createdAt);
    } else if (this.running?.record === local) {
      if (fresh.status === 'stopped' && !this.running.halt) {
        Object.assign(local, fresh);
        this.running.client?.stop();
      }
    } else {
      Object.assign(local, fresh);
    }
    this.renderList();
    if (this.viewed?.record === local) this.updateBadge();
    return local;
  }

  /** Session `id` was deleted in another tab. */
  private dropRemote(id: string): void {
    for (const view of [this.running, this.viewed]) {
      if (view?.record.id === id) {
        view.client?.terminate();
        view.client = null;
      }
    }
    if (this.running?.record.id === id) this.running = null;
    this.releaseOwnership(id);
    this.takeovers.get(id)?.();
    this.takeovers.delete(id);
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.viewed?.record.id === id) {
      this.viewed = null;
      if (this.active) this.fullRender();
    }
    this.renderList();
  }

  get hasRunning(): boolean {
    return this.running !== null;
  }

  activate(): void {
    this.active = true;
    this.fullRender();
  }

  deactivate(): void {
    this.active = false;
    this.chartShows = null; // Backtest mode draws its own bars
  }

  /** Remembers the viewed session's zoom/scroll (debounced), for the next reload. */
  private scheduleViewSave(): void {
    if (!this.active || this.viewSaveTimer !== null) return;
    this.viewSaveTimer = setTimeout(() => {
      this.viewSaveTimer = null;
      const view = this.viewed;
      if (!this.active || !view || this.chartShows !== view || view.pendingView) return;
      storeSavedView(view.record.id, saveView(this.deps.chart.barTimes(), this.deps.chart.visibleRange()));
    }, 500);
  }

  /** Overlay choice or block indicators changed: redraw the session (its own overlays come from its snapshot). */
  redrawOverlays(): void {
    if (this.active && this.viewed) this.fullRender();
  }

  private async start(form: LiveForm): Promise<void> {
    const base = this.deps.sessionBase();
    if (!base.ok) {
      this.deps.setStatus(base.error, true);
      return;
    }
    const now = this.deps.now();
    const warmupBars = form.warmupBars.trim() === '' ? NaN : Number(form.warmupBars);
    if (!Number.isInteger(warmupBars) || warmupBars < 0 || warmupBars > MAX_WARMUP_BARS) {
      this.deps.setStatus(`warm-up bars must be a whole number from 0 to ${MAX_WARMUP_BARS}`, true);
      return;
    }
    let startMs = now;
    if (form.startMode === 'past') {
      startMs = parseUtcDateTime(form.pastStart);
      if (!Number.isFinite(startMs)) return this.deps.setStatus('pick the past start date and time (UTC)', true);
      if (startMs >= now) return this.deps.setStatus('the past start time must be before now', true);
      const bars = Math.floor((now - startMs) / timeframeToMs(base.timeframe)) + warmupBars;
      if (bars > MAX_BARS) return this.deps.setStatus(`replay too long: ${bars} bars (max ${MAX_BARS}); pick a later start or a larger timeframe`, true);
    }
    const other = this.running?.record ?? this.sessions.find((s) => s.status === 'running');
    if (other) {
      const where = this.running ? '' : ' in another tab';
      if (!this.deps.confirm(`"${other.name}" is running${where}. Only one live session can run at a time.\n\nStop it and start the new session?`)) return;
      this.panel.setBusy(true);
      await this.stop(other.id);
      this.panel.setBusy(false);
    }
    const record = newSessionRecord(
      { name: form.name, symbol: base.symbol, timeframe: base.timeframe, startMs, warmupBars, brokerConfig: base.brokerConfig, strategy: base.strategy },
      now,
    );
    this.sessions.unshift(record);
    this.owned.set(record.id, (await claimSession(this.locks, record.id)) ?? 'unsupported'); // a new id is free
    await this.persist(record, true);
    this.announce(record.id);
    this.openView(record, 'live');
    this.deps.setStatus(`Live session "${record.name}" started (${record.symbol} ${record.timeframe}). Paper trading: no real orders are sent.`);
  }

  private open(id: string): void {
    const record = this.sessions.find((s) => s.id === id);
    if (!record) return;
    if (this.running?.record.id === id) this.show(this.running);
    else if (record.status === 'running') void this.resume(record); // runs here only if no other tab runs it
    else this.openView(record, 'replay');
  }

  /** Stops the running session `id`; resolves once it is finalised (worker confirmed, or timed out). */
  private stop(id: string): Promise<void> {
    const view = this.running?.record.id === id ? this.running : null;
    if (!view || !view.client) {
      const record = this.sessions.find((s) => s.id === id);
      if (record && record.status === 'running') {
        // Run by another tab (or nobody): record the stop; the running tab obeys when it hears about it.
        record.status = 'stopped';
        record.stoppedAt = this.deps.now();
        this.renderList();
        return this.persist(record).then(() => this.announce(id));
      }
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      view.stopWaiters.push(resolve);
      view.client!.stop();
      setTimeout(() => {
        if (!view.halt) this.onHalt(view, { reason: 'stopped', lastBarTime: view.record.lastBarTime }); // worker unresponsive
      }, STOP_TIMEOUT_MS);
    });
  }

  private async remove(id: string): Promise<void> {
    const record = this.sessions.find((s) => s.id === id);
    if (!record || !this.deps.confirm(`Delete session "${record.name}"? Its definition is removed for good.`)) return;
    for (const view of [this.running, this.viewed]) {
      if (view?.record.id === id) {
        view.client?.terminate();
        view.client = null;
      }
    }
    if (this.running?.record.id === id) this.running = null;
    if (this.viewed?.record.id === id) {
      this.viewed = null;
      if (this.active) this.fullRender();
    }
    this.sessions = this.sessions.filter((s) => s.id !== id);
    this.takeovers.get(id)?.();
    this.takeovers.delete(id);
    try {
      await this.store?.delete(id);
    } catch (err) {
      this.panel.setNotice(`Could not delete the saved session: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.releaseOwnership(id);
    storeSavedView(id, null);
    this.announce(id);
    this.renderList();
  }

  private openView(record: LiveSessionRecord, mode: 'live' | 'replay'): void {
    const view: SessionView = {
      record, mode, client: null, candles: [], fills: [], trades: [], equity: [], log: [], stats: null, wiped: false,
      status: null, forming: null, markEquity: null, indicators: null, overlays: null, halt: null, stopWaiters: [],
      drawn: { candles: 0, fills: 0, trades: 0, equity: 0, log: 0, chartTime: -Infinity, startMarked: false }, closedTicked: new Set(),
      pendingView: parseSavedView(loadSavedViews()[record.id]), notice: null, position: null, activity: null,
    };
    view.client = new LiveWorkerSupervisor(record, mode, {
      event: (event) => this.onEvent(view, event),
      restarting: (message) => this.onWorkerRestart(view, message),
      fatal: (message) => this.onWorkerFatal(view, message),
    });
    if (mode === 'live') this.running = view;
    this.show(view);
  }

  /**
   * The session's worker crashed and a new one replays the session from its definition: everything this view
   * received is dropped (the new worker sends it all again, identically); the zoom is kept for when it is back.
   */
  private onWorkerRestart(view: SessionView, message: string): void {
    if (view === this.viewed && this.chartShows === view) {
      view.pendingView = saveView(this.deps.chart.barTimes(), this.deps.chart.visibleRange()) ?? view.pendingView;
    }
    Object.assign(view, {
      candles: [], fills: [], trades: [], equity: [], log: [], stats: null, wiped: false, status: null, forming: null, markEquity: null,
      position: null, activity: null,
      drawn: { candles: 0, fills: 0, trades: 0, equity: 0, log: 0, chartTime: -Infinity, startMarked: false },
      notice: `worker crashed — restarting (${message})`,
    });
    view.closedTicked.clear();
    this.deps.setStatus(`Live session "${view.record.name}": its worker crashed (${message}); restarting it — the session replays its bars.`, true);
    if (view === this.viewed && this.active) this.fullRender();
    else this.updateBadge();
  }

  /** The worker crashed again (or while stopping): the session stops, with the error stored and shown. */
  private onWorkerFatal(view: SessionView, message: string): void {
    view.client = null;
    if (view.stopWaiters.length > 0) {
      this.onHalt(view, { reason: 'stopped', lastBarTime: view.record.lastBarTime });
      return;
    }
    view.notice = null;
    this.onHalt(view, { reason: 'error', message: `live worker crashed twice: ${message}`, lastBarTime: view.record.lastBarTime }, true);
  }

  private show(view: SessionView): void {
    const previous = this.viewed;
    if (previous && previous !== view && previous !== this.running) {
      previous.client?.terminate(); // a replay view is only kept while it is on screen
      previous.client = null;
    }
    this.viewed = view;
    if (this.active) this.fullRender();
    this.renderList();
  }

  private onEvent(view: SessionView, event: LiveEvent): void {
    switch (event.type) {
      case 'program':
        view.indicators = event.indicators;
        view.overlays = null;
        if (view === this.viewed && this.active) this.fullRender();
        break;
      case 'delta': {
        const d = event.delta;
        view.candles.push(...d.candles);
        view.fills.push(...d.fills);
        view.trades.push(...d.trades);
        view.equity.push(...d.equity);
        view.log.push(...d.log);
        view.stats = d.stats;
        view.wiped = d.wiped;
        view.position = d.position;
        view.activity = d.activity;
        if (view.mode === 'live') {
          view.record.lastBarTime = d.lastBarTime;
          view.record.summary = { equity: d.stats.finalEquity, returnPct: d.stats.totalReturnPct, tradeCount: d.stats.tradeCount, bars: d.barsProcessed };
          this.schedulePersist();
        }
        this.queueRender();
        break;
      }
      case 'tick': {
        const last = view.candles.length > 0 ? view.candles[view.candles.length - 1].time : -Infinity;
        if (event.candle.time > last) view.forming = event.candle;
        view.markEquity = event.markEquity;
        if (view === this.viewed && this.active && event.candle.time >= view.drawn.chartTime) {
          this.deps.chart.updateCandle(event.candle);
          view.drawn.chartTime = event.candle.time;
          // A final (closed) update on screen means the bar needs no redraw when its delta arrives.
          if (event.closed) view.closedTicked.add(event.candle.time);
          else view.closedTicked.delete(event.candle.time);
        }
        this.updateBadge();
        break;
      }
      case 'status':
        view.status = event.status;
        if (view.notice && event.status.state === 'live') view.notice = null; // the restarted worker caught up
        if (view === this.viewed) this.updateBadge();
        break;
      case 'halt':
        this.onHalt(view, event.halt);
        break;
    }
  }

  private onHalt(view: SessionView, halt: HaltInfo, workerCrash = false): void {
    if (view.halt) return;
    view.halt = halt;
    view.notice = null;
    view.client?.terminate();
    view.client = null;
    const record = view.record;
    if (view.mode === 'live' && record.status === 'running') {
      record.status = 'stopped';
      record.stoppedAt = this.deps.now();
      if (halt.lastBarTime !== null) record.lastBarTime = halt.lastBarTime;
      if (halt.reason === 'error') {
        record.stopReason = 'error';
        record.error = halt.blockId !== undefined ? { message: halt.message ?? 'error', blockId: halt.blockId } : { message: halt.message ?? 'error' };
      } else if (halt.reason === 'wiped') {
        record.stopReason = 'wiped';
      }
      // Release the lock only after the stop is stored, so a waiting tab never takes over a stopped session.
      void this.persist(record).then(() => {
        this.releaseOwnership(record.id);
        this.announce(record.id);
      });
      if (this.running === view) this.running = null;
      if (halt.reason === 'error') {
        if (halt.blockId) this.deps.highlightBlock(halt.blockId, halt.message ?? 'error');
        this.deps.setStatus(workerCrash
          ? `Live session "${record.name}" stopped: ${halt.message}. The error is saved with the session; View replays it.`
          : `Live session "${record.name}" halted by its strategy: ${halt.message}`, true);
      } else if (halt.reason === 'wiped') {
        this.deps.setStatus(`Live session "${record.name}": ACCOUNT WIPED (equity <= 0). The session is stopped.`, true);
      } else {
        this.deps.setStatus(`Live session "${record.name}" stopped. It is read-only history now (View replays it).`);
      }
    } else if (view.mode === 'live') {
      // Stopped in another tab: the stored stop (and its last bar) stands.
      this.releaseOwnership(record.id);
      if (this.running === view) this.running = null;
      this.deps.setStatus(`Live session "${record.name}" was stopped in another tab.`);
    } else if (halt.reason === 'error' && view === this.viewed) {
      this.deps.setStatus(`Session "${record.name}" stopped with an error: ${halt.message}`, true);
    }
    for (const done of view.stopWaiters.splice(0)) done();
    if (view === this.viewed) {
      this.queueRender();
      this.updateBadge();
    }
    this.renderList();
  }

  private overlaysFor(view: SessionView): OverlayDef[] {
    if (view.overlays) return view.overlays;
    const strategy = view.record.strategy;
    if (strategy.kind === 'builtin-sma-cross') {
      view.overlays = [smaOverlay(strategy.params.fast, '#f5c542', 'strategy-fast'), smaOverlay(strategy.params.slow, '#42a5f5', 'strategy-slow')];
    } else if (view.indicators) {
      // The snapshot's own Pine code, compiled here without touching the editor's registry.
      const pine = new Map<string, IndicatorBlockDef | undefined>();
      const resolve = (id: string): IndicatorBlockDef | undefined => {
        if (!id.startsWith(PINE_ID_PREFIX)) return getIndicator(id);
        if (!pine.has(id)) {
          const record = strategy.pineScripts.find((r) => r.id === id);
          let def: IndicatorBlockDef | undefined;
          try {
            const compiled = record ? compilePine(record.source) : null;
            def = compiled?.ok ? pineIndicatorDef(id, compiled.script) : undefined;
          } catch {
            def = undefined;
          }
          pine.set(id, def);
        }
        return pine.get(id);
      };
      view.overlays = blockIndicatorOverlays(view.indicators, resolve);
    } else {
      return [];
    }
    return view.overlays;
  }

  private hasStartMarker(view: SessionView): boolean {
    const firstBar = view.candles[0]?.time;
    return firstBar !== undefined && view.record.startTime >= firstBar && view.record.warmupBars > 0;
  }

  private markers(view: SessionView) {
    const markers = fillsToMarkers(view.fills);
    if (this.hasStartMarker(view)) markers.push(sessionStartMarker(view.record.startTime));
    return markers.sort((a, b) => a.time - b.time);
  }

  private queueRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }

  /** Draws what changed since the last render; falls back to a full redraw when bars must be inserted. */
  private render(): void {
    const view = this.viewed;
    if (!this.active || !view) return;
    const d = view.drawn;
    const fresh = view.candles.slice(d.candles);
    if (fresh.length > 50 || fresh.some((c) => c.time < d.chartTime && !view.closedTicked.has(c.time))) {
      this.fullRender();
      return;
    }
    const { chart, stats } = this.deps;
    for (const c of fresh) {
      if (c.time >= d.chartTime) {
        chart.updateCandle(c);
        d.chartTime = c.time;
      }
      chart.updateOverlays(c);
    }
    d.candles = view.candles.length;
    // Trade markers: new fills are appended (signal markers were appended by updateOverlays); the full set only
    // once, when the session-start marker can first be placed.
    if (!d.startMarked && this.hasStartMarker(view)) {
      chart.setMarkers(this.markers(view));
      d.startMarked = true;
    } else if (view.fills.length > d.fills) {
      chart.appendMarkers(fillsToMarkers(view.fills.slice(d.fills)));
    }
    d.fills = view.fills.length;
    if (view.stats) stats.showStats(view.stats, view.wiped);
    stats.appendEquity(view.equity.slice(d.equity));
    d.equity = view.equity.length;
    if (view.trades.length !== d.trades) stats.setTrades(view.trades);
    d.trades = view.trades.length;
    stats.appendLog(view.log.slice(d.log));
    d.log = view.log.length;
    const lastClosed = view.candles[view.candles.length - 1]?.time ?? -Infinity;
    for (const t of view.closedTicked) if (t <= lastClosed) view.closedTicked.delete(t);
    this.updateBadge();
  }

  private fullRender(): void {
    if (!this.active) return;
    const { chart, stats } = this.deps;
    const view = this.viewed;
    if (!view) {
      chart.setCandles([]);
      chart.setOverlays([], []);
      chart.setMarkers([]);
      stats.clear('Live mode: start a paper-trading session above, or open one from the list.');
      this.panel.setBadge(null);
      this.panel.setMark(null);
      this.chartShows = null;
      return;
    }
    // Redrawing the session already on screen (gap fill, new program, halt): keep the user's zoom/scroll.
    const before = this.chartShows === view ? { times: [...chart.barTimes()], range: chart.visibleRange() } : null;
    chart.setCandles(view.candles, false);
    let chartTime = view.candles[view.candles.length - 1]?.time ?? -Infinity;
    if (view.forming && view.forming.time > chartTime) {
      chart.updateCandle(view.forming);
      chartTime = view.forming.time;
    }
    this.chartShows = view;
    this.placeView(view, before);
    chart.setOverlays(liveSessionOverlays(this.overlaysFor(view), this.deps.extraOverlays()), view.candles);
    chart.setMarkers(this.markers(view));
    stats.clear(view.stats ? '' : `Session "${view.record.name}": loading ${view.record.symbol} ${view.record.timeframe} bars…`);
    if (view.stats) {
      stats.showStats(view.stats, view.wiped);
      stats.setEquity(view.equity);
      stats.setTrades(view.trades);
      stats.appendLog(view.log);
    }
    view.drawn = {
      candles: view.candles.length, fills: view.fills.length, trades: view.trades.length, equity: view.equity.length, log: view.log.length, chartTime,
      startMarked: this.hasStartMarker(view),
    };
    view.closedTicked.clear();
    this.updateBadge();
  }

  /**
   * After the session's bars were (re)drawn: the view saved before a reload once its bars are there, else the
   * user's current view kept across the redraw (preserveRange), else fit everything.
   */
  private placeView(view: SessionView, before: { times: number[]; range: ReturnType<ChartPanel['visibleRange']> } | null): void {
    const { chart } = this.deps;
    if (view.pendingView) {
      const range = restoreSavedView(view.pendingView, chart.barTimes());
      if (range) {
        view.pendingView = null;
        chart.showRange(range);
      } else {
        chart.fit();
      }
      return;
    }
    const choice = before ? preserveRange(before.times, before.range, chart.barTimes()) : ({ kind: 'fit' } as const);
    if (choice.kind === 'range') chart.showRange(choice);
    else chart.fit();
  }

  private updateBadge(): void {
    const view = this.viewed;
    if (!view) {
      this.panel.setBadge(null);
      this.panel.setMark(null);
      return;
    }
    const status: LiveStatus = view.status ?? { state: view.mode === 'live' ? 'connecting' : 'catching-up', lastBarTime: null, barsProcessed: 0, behindBars: 0 };
    const replay = view.mode === 'replay' || view.halt !== null;
    let badge = liveBadge(view.halt && view.halt.reason !== 'complete' ? { ...status, state: 'stopped' } : status, replay);
    if (view.notice) badge = { ...badge, text: 'WORKER CRASHED — RESTARTING', tone: 'warn', detail: `${view.notice} · ${badge.detail}` };
    const stoppedWithError = view.record.status === 'stopped' && view.record.stopReason === 'error' && view.record.error;
    if (stoppedWithError && (view.halt || view.mode === 'replay')) badge = { ...badge, text: `STOPPED · error: ${view.record.error!.message}`, tone: 'error' };
    if (view.mode === 'replay' && view.record.status === 'running' && view.halt) {
      badge = { ...badge, text: 'RUNNING IN ANOTHER TAB · read-only (up to its last saved bar)', tone: 'busy' };
    }
    this.panel.setBadge({ ...badge, detail: `${view.record.name} · ${view.record.symbol} ${view.record.timeframe} · ${badge.detail}` });
    const showMark = view.mode === 'live' && !view.halt && view.markEquity !== null && status.state === 'live';
    this.panel.setMark(showMark ? `Mark equity ${fmtNum(view.markEquity!)} (live price; stats use closed bars)` : null);
  }

  private renderList(): void {
    const here = this.running?.record.id;
    this.panel.setSessions(this.sessions.map((r) => sessionRow(r, r.status === 'running' && r.id !== here)), this.viewed?.record.id ?? null);
  }

  private schedulePersist(): void {
    if (this.persistTimer !== null) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      if (this.running) {
        const id = this.running.record.id;
        void this.persist(this.running.record).then(() => this.announce(id));
      }
      this.renderList();
    }, PERSIST_EVERY_MS);
  }

  /**
   * Saves `record` (merge-on-write). Updates never recreate a session deleted elsewhere, and a stop stored by
   * another tab comes back here and halts this tab's run.
   */
  private async persist(record: LiveSessionRecord, create = false): Promise<void> {
    try {
      if (!this.store) return;
      const stored = await this.store.put(record, { onlyIfExists: !create });
      if (stored === null) this.dropRemote(record.id);
      else if (stored.status !== record.status) this.adoptRemote(stored);
    } catch (err) {
      this.panel.setNotice(`Could not save the session (${err instanceof Error ? err.message : String(err)}); it will not survive a reload.`);
    }
  }
}
