import { MarketDataError, type CandleSubscription, type ConnectionState, type MarketDataAdapter } from '../data/adapter';
import type { Candle, Timeframe } from '../data/types';
import type { SessionDelta, SessionEngine } from './sessionEngine';

export type LiveState =
  /** Websocket not up yet. */
  | 'connecting'
  /** Fetching / processing closed bars from REST (history, replay, or a gap after a drop). */
  | 'catching-up'
  /** Up to date; processing each bar as it closes. */
  | 'live'
  /** Websocket dropped; the adapter is reconnecting (missed bars are backfilled afterwards). */
  | 'reconnecting'
  /** A REST request failed; nothing was half-applied and it is retried automatically. */
  | 'error'
  /** Binance asked us to slow down (HTTP 418/429); retried after its Retry-After. */
  | 'rate-limited'
  | 'stopped';

export interface LiveStatus {
  state: LiveState;
  lastBarTime: number | null;
  barsProcessed: number;
  /** Closed bars known to exist but not processed yet (catching-up). */
  behindBars: number;
  /** 'error' / 'rate-limited': what failed. */
  message?: string;
  /** 'error' / 'rate-limited': delay before the next attempt. */
  retryInMs?: number;
}

export type HaltReason = 'stopped' | 'error' | 'wiped' | 'complete';

export interface HaltInfo {
  reason: HaltReason;
  message?: string;
  blockId?: string;
  /** Last processed bar: the replay bound of the stopped session. */
  lastBarTime: number | null;
}

export interface RunnerHooks {
  delta(delta: SessionDelta): void;
  /** Every websocket update (forming or closed) for the chart and the mark-to-market readout; never fed to the strategy. */
  tick(candle: Candle, markEquity: number, closed: boolean): void;
  status(status: LiveStatus): void;
  halt(info: HaltInfo): void;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

export interface RunnerOptions {
  /** 'live': catch up, then follow the websocket forever. 'replay': process up to the session's replay end, then halt 'complete'. */
  mode: 'live' | 'replay';
  symbol: string;
  timeframe: Timeframe;
  now?: () => number;
  /** Bars processed between deltas / yields during catch-up. */
  batchSize?: number;
  /** Bars per REST request window. */
  fetchChunkBars?: number;
  /** Lets the event loop breathe between batches (stop commands, ticks). */
  yieldFn?: () => Promise<void>;
  /** Backoff after REST failures: base * 2^attempt, capped, with jitter (half to full delay). */
  retryBaseMs?: number;
  retryCapMs?: number;
  /** Jitter source (tests pin it). */
  random?: () => number;
  /** When REST does not have a bar the websocket says is closed yet. */
  restLagRetryMs?: number;
  /** Clock check for bars that closed while the socket was silent (sleep, stalled socket). */
  heartbeatMs?: number;
  /** A bar counts as closed by the local clock only this long after its close (clock skew guard). */
  closeMarginMs?: number;
  /** Websocket updates newer than this make the socket the authority on which bars are closed. */
  wsFreshMs?: number;
  timers?: Timers;
}

/**
 * Drives one session: feeds every CLOSED bar exactly once and in order to the SessionEngine.
 * - Start: REST history from the first warm-up bar, in chunks, processed in batches with yields.
 * - Live: a websocket close (`x=true`) of the next bar is processed directly; any hole (drop, sleep, missed
 *   message) is backfilled from REST before newer bars. Forming candles only go to `hooks.tick`.
 * - Dedup by bar open time (SessionEngine). REST failures leave the state untouched and are retried.
 */
export class LiveRunner {
  private readonly step: number;
  private readonly now: () => number;
  private readonly timers: Timers;
  private readonly opt: Required<Omit<RunnerOptions, 'timers' | 'now' | 'yieldFn'>>;
  private readonly yieldFn: () => Promise<void>;
  /** Newest bar open time known to be closed. */
  private target: number | null = null;
  /** Next bar open time to obtain (moves past exchange holes, so it can be ahead of the engine). */
  private cursor: number;
  /** Websocket-closed bars waiting for their turn. */
  private readonly pending = new Map<number, Candle>();
  private busy = false;
  private again = false;
  private current: Promise<void> = Promise.resolve();
  private stopped = false;
  private sub: CandleSubscription | null = null;
  private ws: ConnectionState | 'none' = 'none';
  private lastWsAt = -Infinity;
  private retryTimer: unknown = null;
  private retryKind: 'lag' | 'error' = 'lag';
  private clockChecked = false;
  private heartbeat: unknown = null;
  private retryAttempt = 0;
  private error: { message: string; retryInMs: number; rateLimited: boolean } | null = null;
  private lastStatusKey = '';

  constructor(
    private readonly session: SessionEngine,
    private readonly adapter: MarketDataAdapter,
    private readonly hooks: RunnerHooks,
    options: RunnerOptions,
  ) {
    this.step = session.step;
    this.now = options.now ?? (() => Date.now());
    this.timers = options.timers ?? REAL_TIMERS;
    this.yieldFn = options.yieldFn ?? (() => new Promise<void>((resolve) => this.timers.setTimeout(resolve, 0)));
    this.opt = {
      mode: options.mode,
      symbol: options.symbol,
      timeframe: options.timeframe,
      batchSize: options.batchSize ?? 500,
      fetchChunkBars: options.fetchChunkBars ?? 5000,
      retryBaseMs: options.retryBaseMs ?? 2000,
      retryCapMs: options.retryCapMs ?? 60_000,
      random: options.random ?? Math.random,
      restLagRetryMs: options.restLagRetryMs ?? 2000,
      heartbeatMs: options.heartbeatMs ?? 10_000,
      closeMarginMs: options.closeMarginMs ?? 10_000,
      wsFreshMs: options.wsFreshMs ?? 30_000,
    };
    this.cursor = session.nextBarTime;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  start(): void {
    if (this.opt.mode === 'replay') {
      const end = this.session.replayEnd;
      if (end === undefined || end < this.session.firstBarTime) {
        this.finish('complete');
        return;
      }
      this.raiseTarget(end);
    } else {
      this.ws = 'connecting';
      this.sub = this.adapter.subscribeCandles(
        this.opt.symbol,
        this.opt.timeframe,
        (candle, closed) => this.onCandle(candle, closed),
        undefined, // socket errors are followed by a close -> 'reconnecting'
        (state) => {
          this.ws = state;
          this.emitStatus();
        },
      );
      this.heartbeat = this.timers.setInterval(() => this.resync(), this.opt.heartbeatMs);
      // The first target comes from the SERVER clock, measured before the first catch-up (see kick).
    }
    this.emitStatus();
    this.kick();
  }

  /** User stop: no more bars are processed. */
  stop(): void {
    this.finish('stopped');
  }

  /**
   * Re-checks the clock for bars that closed while nothing arrived (page woke up, socket silent). The websocket
   * is trusted instead while it is fresh, so a skewed local clock cannot mark a forming bar as closed.
   */
  resync(): void {
    if (this.stopped) return;
    if (this.now() - this.lastWsAt > this.opt.wsFreshMs) this.raiseTarget(this.clockTarget());
    this.kick();
  }

  /** Resolves when no catch-up work is in flight (tests). */
  async idle(): Promise<void> {
    while (this.busy) await this.current;
  }

  private onCandle(candle: Candle, closed: boolean): void {
    if (this.stopped) return;
    this.lastWsAt = this.now();
    this.hooks.tick(candle, this.session.markEquity(candle.close), closed);
    if (closed) {
      const last = this.session.lastBarTime;
      if (last === null || candle.time > last) this.pending.set(candle.time, candle);
      this.raiseTarget(candle.time);
    } else {
      // The forming bar's existence proves every earlier bar is closed.
      this.raiseTarget(candle.time - this.step);
    }
    this.kick();
  }

  /**
   * Latest bar that closed at least closeMarginMs ago, by the exchange clock when the adapter measured it
   * (local clock otherwise). This only bounds what is REQUESTED: whether a returned bar is closed is decided
   * by the adapter (server time, or the conservative newest-row rule), so a wrong clock can delay bars but
   * never feed a forming one.
   */
  private clockTarget(): number {
    const now = this.adapter.serverNow?.() ?? this.now();
    return Math.floor((now - this.opt.closeMarginMs) / this.step) * this.step - this.step;
  }

  private raiseTarget(time: number): void {
    const end = this.opt.mode === 'replay' ? this.session.replayEnd : undefined;
    const t = end !== undefined ? Math.min(time, end) : time;
    if (this.target === null || t > this.target) this.target = t;
  }

  private behind(): number {
    if (this.target === null || this.target < this.cursor) return 0;
    return Math.floor((this.target - this.cursor) / this.step) + 1;
  }

  private kick(): void {
    if (this.stopped) return;
    if (this.busy) {
      this.again = true;
      return;
    }
    if (this.retryTimer !== null) {
      // An error backoff always waits; a "REST is lagging" wait gives way when the socket delivered the next bar.
      if (this.retryKind !== 'lag' || !this.pending.has(Math.max(this.cursor, this.session.nextBarTime))) return;
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.busy = true;
    this.current = (async () => {
      try {
        if (this.opt.mode === 'live' && !this.clockChecked) {
          this.clockChecked = true;
          await this.adapter.syncClock?.();
          this.raiseTarget(this.clockTarget());
        }
        do {
          this.again = false;
          await this.catchUp();
        } while (this.again && !this.stopped && this.retryTimer === null);
      } catch (err) {
        // A bug or a malformed answer: stop visibly instead of leaving an unhandled rejection and a stuck session.
        this.finish('error', `live runner failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.busy = false;
        this.emitStatus();
      }
    })();
  }

  private async catchUp(): Promise<void> {
    while (!this.stopped && this.behind() > 0) {
      this.cursor = Math.max(this.cursor, this.session.nextBarTime);
      if (this.behind() === 0) break;
      // Fast path: the next bars arrived closed on the websocket.
      if (this.pending.has(this.cursor)) {
        const run: Candle[] = [];
        for (let t = this.cursor; this.pending.has(t) && t <= this.target!; t += this.step) run.push(this.pending.get(t)!);
        await this.feed(run);
        continue;
      }
      const from = this.cursor;
      const to = Math.min(this.target!, from + (this.opt.fetchChunkBars - 1) * this.step);
      this.emitStatus();
      let bars: Candle[];
      try {
        // One bar past `to`: then `to` is not the newest row, so the adapter can accept it without a server clock.
        bars = await this.adapter.fetchCandles(this.opt.symbol, this.opt.timeframe, from, to + this.step);
      } catch (err) {
        this.scheduleRetry(err);
        return;
      }
      if (this.stopped) return;
      if (this.opt.mode === 'live') this.raiseTarget(this.clockTarget()); // the clock may be known (or better) now
      if (this.error) {
        this.error = null;
        this.retryAttempt = 0;
      }
      const fresh = bars.filter((b) => b.time >= from && b.time <= to).sort((a, b) => a.time - b.time);
      if (fresh.length === 0) {
        if (to < this.target!) {
          // Empty although later bars are known to exist: a real hole (before listing, maintenance) only if the
          // exchange shows the first bar after it. A glitchy empty answer must never make us skip bars.
          let next: number | null = null;
          try {
            next = (await this.adapter.firstBarAtOrAfter?.(this.opt.symbol, this.opt.timeframe, from)) ?? null;
          } catch (err) {
            this.scheduleRetry(err);
            return;
          }
          if (this.stopped) return;
          if (next !== null && next > from) {
            this.cursor = Math.floor((next - from) / this.step) * this.step + from; // jump to the first existing bar
            continue;
          }
          this.scheduleRetry(new Error('Binance returned no bars for a range that should have some; retrying'));
          return;
        }
        // Closed per the socket/clock but not served by REST yet: wait a moment, keep everything as is.
        this.scheduleRetry(null);
        return;
      }
      await this.feed(fresh);
      if (!this.stopped) this.cursor = Math.max(this.cursor, fresh[fresh.length - 1].time + this.step);
    }
    if (!this.stopped && this.opt.mode === 'replay' && this.behind() === 0) this.finish('complete');
  }

  /** Processes bars in order in batches; emits a delta per batch. */
  private async feed(bars: readonly Candle[]): Promise<void> {
    for (let i = 0; i < bars.length && !this.stopped; i += this.opt.batchSize) {
      for (const bar of bars.slice(i, i + this.opt.batchSize)) {
        const outcome = this.session.push(bar);
        this.pending.delete(bar.time);
        if (outcome === 'halted') {
          this.finish(this.session.wiped ? 'wiped' : 'error');
          return;
        }
      }
      this.flush();
      this.cursor = Math.max(this.cursor, this.session.nextBarTime);
      this.emitStatus();
      if (i + this.opt.batchSize < bars.length) await this.yieldFn();
    }
    const last = this.session.lastBarTime;
    if (last !== null) for (const t of this.pending.keys()) if (t <= last) this.pending.delete(t);
  }

  private flush(): void {
    const delta = this.session.drain();
    if (delta.candles.length > 0 || delta.log.length > 0) this.hooks.delta(delta);
  }

  /**
   * `failure` null = not an error, just REST lagging behind the socket. Terminal errors (invalid symbol, other
   * 4xx) stop the session instead: retrying cannot help.
   */
  private scheduleRetry(failure: unknown): void {
    let delay = this.opt.restLagRetryMs;
    this.retryKind = failure === null ? 'lag' : 'error';
    if (failure !== null) {
      const message = failure instanceof Error ? failure.message : String(failure);
      if (failure instanceof MarketDataError && failure.kind === 'terminal') {
        this.finish('error', `market data: ${message}`);
        return;
      }
      const ceiling = Math.min(this.opt.retryCapMs, this.opt.retryBaseMs * 2 ** this.retryAttempt);
      delay = Math.round(ceiling / 2 + this.opt.random() * (ceiling / 2));
      const rateLimited = failure instanceof MarketDataError && failure.kind === 'rate-limited';
      if (rateLimited) delay = Math.max(delay, failure.retryAfterMs ?? 0);
      this.retryAttempt++;
      this.error = { message, retryInMs: delay, rateLimited };
    }
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, delay);
    this.emitStatus();
  }

  private finish(reason: HaltReason, message?: string): void {
    if (this.stopped) return;
    this.stopped = true;
    this.sub?.close();
    this.sub = null;
    if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
    if (this.retryTimer !== null) this.timers.clearTimeout(this.retryTimer);
    this.heartbeat = this.retryTimer = null;
    this.flush();
    const failure = this.session.error;
    const info: HaltInfo = { reason, lastBarTime: this.session.lastBarTime };
    if (reason === 'error' && failure) {
      info.message = failure.message;
      if (failure.blockId !== undefined) info.blockId = failure.blockId;
    } else if (message !== undefined) {
      info.message = message;
    }
    if (reason === 'wiped') info.message = 'account wiped: equity <= 0, session stopped';
    this.emitStatus();
    this.hooks.halt(info);
  }

  private status(): LiveStatus {
    const base = { lastBarTime: this.session.lastBarTime, barsProcessed: this.session.barsProcessed, behindBars: this.behind() };
    if (this.stopped) return { ...base, state: 'stopped', behindBars: 0 };
    if (this.error) return { ...base, state: this.error.rateLimited ? 'rate-limited' : 'error', message: this.error.message, retryInMs: this.error.retryInMs };
    if (base.behindBars > 0 && (this.busy || this.opt.mode === 'replay')) return { ...base, state: 'catching-up' };
    if (this.ws === 'reconnecting') return { ...base, state: 'reconnecting' };
    if (this.ws === 'connecting') return { ...base, state: 'connecting' };
    if (base.behindBars > 0) return { ...base, state: 'catching-up' };
    return { ...base, state: 'live' };
  }

  private emitStatus(): void {
    const status = this.status();
    const key = JSON.stringify(status);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.hooks.status(status);
  }
}
