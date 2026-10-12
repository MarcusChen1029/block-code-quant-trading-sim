import type { LiveEvent } from './host';
import type { HaltInfo, LiveStatus } from './runner';
import type { LiveSessionRecord } from './session';
import type { IndicatorUse } from '../blocks/generator';
import type { Candle } from '../data/types';
import type { EngineActivity } from '../engine/engine';
import type { EquityPoint, Stats } from '../engine/stats';
import type { Fill, LogEntry, PositionView, Trade } from '../engine/types';

/** What the server sends for one watched session (mirrors server/src/sessions.ts). */
export interface RemoteSnapshot {
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
  notice: string | null;
}

export type RemoteMessage =
  | { type: 'snapshot'; snapshot: RemoteSnapshot }
  | { type: 'event'; id: string; event: LiveEvent }
  | { type: 'restarting'; id: string; message: string }
  | { type: 'record'; record: LiveSessionRecord }
  | { type: 'deleted'; id: string }
  | { type: 'unavailable'; id: string; message: string };

export type ConnectionState = 'unknown' | 'logged-out' | 'connecting' | 'connected' | 'reconnecting' | 'unreachable';

export interface WatchHandlers {
  message(message: RemoteMessage): void;
}

/** A watched session, as the live view uses its worker supervisor (stop / resync / terminate). */
export interface RemoteFeed {
  stop(): void;
  resync(): void;
  debug(action: 'throw' | 'hang'): void;
  terminate(): void;
}

export class ServerApiError extends Error {
  constructor(message: string, readonly status: number, readonly blockId?: string) {
    super(message);
    this.name = 'ServerApiError';
  }
}

/** The parts of EventSource used here (tests inject a fake). */
export interface EventSourceLike {
  readyState: number;
  onerror: ((ev: Event) => void) | null;
  onopen: ((ev: Event) => void) | null;
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void;
  close(): void;
}

export interface ServerClientOptions {
  fetchFn?: typeof fetch;
  eventSource?: (url: string) => EventSourceLike;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (id: unknown) => void;
  /** Reconnect delays: base * 2^attempt, capped. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

const SERVER_HEADER = 'x-quant-sim-server';

/**
 * Browser side of server mode: the JSON API (cookie login + CSRF header) and ONE Server-Sent Events stream that
 * carries the session list and the watched session. The stream reconnects with exponential backoff; a 401 means
 * logged out (no retries until the next login). Every (re)connect starts with a fresh snapshot, so a view that
 * simply replaces its data on 'snapshot' never double-counts.
 */
export class ServerClient {
  private csrf: string | null = null;
  private source: EventSourceLike | null = null;
  private retryTimer: unknown = null;
  private attempt = 0;
  private watched: { id: string; handlers: WatchHandlers } | null = null;
  private state: ConnectionState = 'unknown';
  private readonly stateListeners = new Set<(state: ConnectionState, detail?: string) => void>();
  private readonly listListeners = new Set<(sessions: LiveSessionRecord[]) => void>();
  private readonly fetchFn: typeof fetch;
  private readonly makeSource: (url: string) => EventSourceLike;
  private readonly timers: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
  private readonly backoffBase: number;
  private readonly backoffCap: number;

  /** `base`: '' for the page's own origin, else e.g. 'http://localhost:8787'. */
  constructor(readonly base: string, options: ServerClientOptions = {}) {
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
    this.makeSource = options.eventSource ?? ((url) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike);
    this.timers = {
      set: options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms)),
      clear: options.clearTimeout ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
    };
    this.backoffBase = options.backoffBaseMs ?? 1000;
    this.backoffCap = options.backoffCapMs ?? 30_000;
  }

  get connection(): ConnectionState {
    return this.state;
  }

  get loggedIn(): boolean {
    return this.csrf !== null;
  }

  onState(listener: (state: ConnectionState, detail?: string) => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onSessions(listener: (sessions: LiveSessionRecord[]) => void): () => void {
    this.listListeners.add(listener);
    return () => this.listListeners.delete(listener);
  }

  private setState(state: ConnectionState, detail?: string): void {
    this.state = state;
    for (const l of this.stateListeners) l(state, detail);
  }

  private url(path: string): string {
    return `${this.base.replace(/\/+$/, '')}${path}`;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && this.csrf) headers['x-csrf-token'] = this.csrf;
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'include' });
    } catch (err) {
      throw new ServerApiError(`server unreachable (${err instanceof Error ? err.message : String(err)})`, 0);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json ?? {}) as { error?: unknown; blockId?: unknown };
      if (res.status === 401 && path !== '/api/login') this.loggedOut();
      throw new ServerApiError(typeof err.error === 'string' ? err.error : `HTTP ${res.status}`, res.status, typeof err.blockId === 'string' ? err.blockId : undefined);
    }
    return json;
  }

  /** True when `base` answers as a quant-sim server (its API marks itself), whether or not we are logged in. */
  async probe(): Promise<boolean> {
    try {
      const res = await this.fetchFn(this.url('/api/me'), { credentials: 'include' });
      const ours = res.headers.get(SERVER_HEADER) === '1';
      if (ours && res.ok) {
        const me = (await res.json()) as { csrf?: unknown };
        if (typeof me.csrf === 'string') {
          this.csrf = me.csrf;
          this.connect();
        }
      } else if (ours) {
        this.setState('logged-out');
      }
      return ours;
    } catch {
      return false;
    }
  }

  async login(password: string): Promise<void> {
    const res = (await this.request('POST', '/api/login', { password })) as { csrf: string };
    this.csrf = res.csrf;
    this.attempt = 0;
    this.connect();
  }

  async logout(): Promise<void> {
    try {
      await this.request('POST', '/api/logout');
    } finally {
      this.loggedOut();
    }
  }

  async create(input: unknown): Promise<LiveSessionRecord> {
    return ((await this.request('POST', '/api/sessions', input)) as { session: LiveSessionRecord }).session;
  }

  async stop(id: string): Promise<LiveSessionRecord> {
    return ((await this.request('POST', `/api/sessions/${encodeURIComponent(id)}/stop`)) as { session: LiveSessionRecord }).session;
  }

  async remove(id: string): Promise<void> {
    await this.request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  }

  async list(): Promise<LiveSessionRecord[]> {
    return ((await this.request('GET', '/api/sessions')) as { sessions: LiveSessionRecord[] }).sessions;
  }

  /** Streams session `id` to `handlers` (snapshot first) until the returned feed is terminated. */
  watch(id: string, handlers: WatchHandlers): RemoteFeed {
    const entry = { id, handlers };
    this.watched = entry;
    if (this.csrf) this.connect();
    return {
      stop: () => {
        void this.stop(id).catch(() => {});
      },
      resync: () => {},
      debug: () => {},
      terminate: () => {
        if (this.watched !== entry) return;
        this.watched = null;
        if (this.csrf) this.connect();
      },
    };
  }

  /** Stops streaming (switching back to 'This browser'). The login stays. */
  disconnect(): void {
    this.closeSource();
    if (this.csrf) this.setState('unknown');
  }

  private loggedOut(): void {
    this.csrf = null;
    this.closeSource();
    this.setState('logged-out');
  }

  private closeSource(): void {
    if (this.retryTimer !== null) this.timers.clear(this.retryTimer);
    this.retryTimer = null;
    this.source?.close();
    this.source = null;
  }

  /** (Re)opens the stream for the current watch. */
  connect(): void {
    this.closeSource();
    if (!this.csrf) return;
    const watched = this.watched;
    const query = watched ? `?session=${encodeURIComponent(watched.id)}` : '';
    this.setState(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const source = this.makeSource(this.url(`/api/stream${query}`));
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.attempt = 0;
      this.setState('connected');
    };
    source.addEventListener('sessions', (ev) => {
      if (this.source !== source) return;
      const data = JSON.parse(ev.data) as { sessions: LiveSessionRecord[] };
      for (const l of this.listListeners) l(data.sessions);
    });
    source.addEventListener('session', (ev) => {
      if (this.source !== source || this.watched !== watched || !watched) return;
      watched.handlers.message(JSON.parse(ev.data) as RemoteMessage);
    });
    source.onerror = () => {
      if (this.source !== source) return;
      // EventSource retries by itself without telling why; take over: check the login, then back off.
      this.closeSource();
      this.setState('reconnecting');
      void this.afterDrop();
    };
  }

  private async afterDrop(): Promise<void> {
    let status = 0;
    try {
      const res = await this.fetchFn(this.url('/api/me'), { credentials: 'include' });
      status = res.status;
    } catch {
      status = 0;
    }
    if (status === 401) {
      this.loggedOut();
      return;
    }
    if (!this.csrf) return;
    const delay = Math.min(this.backoffCap, this.backoffBase * 2 ** this.attempt);
    this.attempt++;
    this.setState(status === 0 ? 'unreachable' : 'reconnecting', `retrying in ${Math.round(delay / 1000)} s`);
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }
}
