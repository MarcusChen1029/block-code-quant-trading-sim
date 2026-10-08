import type { LiveCommand, LiveEvent } from './host';
import type { Timers } from './runner';
import type { LiveSessionRecord } from './session';

/** The worker posts a heartbeat this often. */
export const HEARTBEAT_MS = 5000;
/** No message at all for this long means the worker is dead or hung (catch-up yields between batches). */
export const HEARTBEAT_TIMEOUT_MS = 30_000;
const CHECK_EVERY_MS = 5000;

/** The part of a Worker the client uses (tests inject a fake). */
export interface WorkerLike {
  onmessage: ((ev: MessageEvent<LiveEvent>) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
  onmessageerror: ((ev: MessageEvent) => void) | null;
  postMessage(command: LiveCommand): void;
  terminate(): void;
}

export interface LiveWorkerOptions {
  createWorker?: () => WorkerLike;
  timers?: Timers;
  now?: () => number;
  heartbeatTimeoutMs?: number;
}

const REAL_TIMERS: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
};

const realWorker = (): WorkerLike =>
  new Worker(new URL('../worker/live.worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;

/**
 * Page side of one live worker: one session per worker; terminate() discards it. A worker that dies (error event,
 * unreadable message) or hangs (no message, heartbeats included, for HEARTBEAT_TIMEOUT_MS) is reported ONCE through
 * `onCrash` and terminated; nothing it sends afterwards is delivered.
 */
export class LiveWorkerClient {
  private readonly worker: WorkerLike;
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private terminated = false;
  private lastSeen: number;
  private lastCheck: number;
  private check: unknown = null;

  constructor(
    session: LiveSessionRecord,
    mode: 'live' | 'replay',
    onEvent: (event: LiveEvent) => void,
    private readonly onCrash: (message: string) => void,
    options: LiveWorkerOptions = {},
  ) {
    this.timers = options.timers ?? REAL_TIMERS;
    this.now = options.now ?? (() => Date.now());
    this.timeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.lastSeen = this.lastCheck = this.now();
    this.worker = (options.createWorker ?? realWorker)();
    this.worker.onmessage = (event) => {
      if (this.terminated) return;
      this.lastSeen = this.now();
      if (event.data.type !== 'heartbeat') onEvent(event.data);
    };
    this.worker.onerror = (event) => {
      event.preventDefault?.();
      this.crash(event.message || 'live worker crashed');
    };
    this.worker.onmessageerror = () => this.crash('live worker sent a message that could not be read');
    this.check = this.timers.setInterval(() => this.checkAlive(), CHECK_EVERY_MS);
    this.send({ type: 'start', session, mode });
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  resync(): void {
    this.send({ type: 'resync' });
  }

  /** Dev builds: make the worker throw or hang (crash-handling checks). */
  debug(action: 'throw' | 'hang'): void {
    this.send({ type: 'debug', action });
  }

  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;
    if (this.check !== null) this.timers.clearInterval(this.check);
    this.check = null;
    this.worker.terminate();
  }

  private checkAlive(): void {
    if (this.terminated) return;
    const now = this.now();
    // The check itself ran far too late: the whole page was frozen or asleep (so was the worker). Start over.
    if (now - this.lastCheck > CHECK_EVERY_MS * 3) this.lastSeen = now;
    this.lastCheck = now;
    if (now - this.lastSeen > this.timeoutMs) this.crash(`live worker is not responding (no message for ${Math.round((now - this.lastSeen) / 1000)} s)`);
  }

  private crash(message: string): void {
    if (this.terminated) return;
    this.terminate();
    this.onCrash(message);
  }

  private send(command: LiveCommand): void {
    if (!this.terminated) this.worker.postMessage(command);
  }
}
