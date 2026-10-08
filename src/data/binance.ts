import { MarketDataError, type CandleSubscription, type ConnectionState, type MarketDataAdapter } from './adapter';
import { timeframeToMs, type Candle, type Timeframe } from './types';

/** Max rows per /fapi/v1/klines request. */
export const BINANCE_MAX_LIMIT = 1500;

/** REST kline row: [openTime, open, high, low, close, volume, closeTime, ...ignored]. Prices are strings. */
export type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

/** Classifies a non-OK REST response (see MarketDataError). */
export async function httpError(res: Response): Promise<MarketDataError> {
  const text = await res.text().catch(() => '');
  let detail = text.slice(0, 300);
  try {
    const body = JSON.parse(text) as { msg?: unknown };
    if (typeof body?.msg === 'string') detail = body.msg;
  } catch {
    // not JSON: keep the raw text
  }
  const status = res.status;
  if (status === 418 || status === 429) {
    const seconds = Number(res.headers.get('Retry-After'));
    const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
    return new MarketDataError(`Binance rate limit (HTTP ${status})${detail ? `: ${detail}` : ''}`, 'rate-limited', status, retryAfterMs);
  }
  if (status >= 400 && status < 500 && status !== 408) {
    const what = status === 403 ? 'refused access (it may be blocked in your region)' : 'rejected the request';
    return new MarketDataError(`Binance ${what} (HTTP ${status})${detail ? `: ${detail}` : ''}`, 'terminal', status);
  }
  return new MarketDataError(`Binance HTTP ${status}${detail ? `: ${detail}` : ''}`, 'transient', status);
}

/** Minimal socket surface we use; lets tests inject a fake. */
export interface WebSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  /** Optional: sockets without it are reported open on their first message. */
  onopen?: (() => void) | null;
  close(): void;
}

export interface BinanceAdapterOptions {
  restBase?: string;
  wsBase?: string;
  fetchFn?: (url: string) => Promise<Response>;
  wsFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  reconnectDelayMs?: number;
  /**
   * A socket silent for this long is treated as dead (sleeping laptop, half-open TCP): it is dropped and a new
   * one is opened. Kline streams push several updates per second, so silence means a broken connection.
   */
  staleAfterMs?: number;
  /** How long a measured server-clock offset is trusted before it is measured again. */
  clockRefreshMs?: number;
}

/** A bar this close to its close by the server clock is still treated as possibly forming (offset error margin). */
const CLOSE_GUARD_MS = 2000;
/** After a failed /time request, do not ask again for this long. */
const CLOCK_RETRY_MS = 30_000;

export function parseKlineRow(row: BinanceKlineRow): Candle {
  return {
    time: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

interface KlinePayload {
  t: number; o: string; h: string; l: string; c: string; v: string; x: boolean;
}

/** Parses a kline stream message (raw or combined-stream). Returns null for anything else. */
export function parseKlineMessage(data: string): { candle: Candle; closed: boolean } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (msg && typeof msg === 'object' && 'data' in msg) msg = (msg as { data: unknown }).data;
  if (!msg || typeof msg !== 'object' || (msg as { e?: unknown }).e !== 'kline') return null;
  const k = (msg as { k: KlinePayload }).k;
  return {
    candle: { time: k.t, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) },
    closed: k.x,
  };
}

/**
 * A browser WebSocket behind WebSocketLike. close() on a socket still CONNECTING makes the browser log "WebSocket
 * is closed before the connection is established" (plus an error event): that happened on every quick stop / mode
 * switch and whenever the stale watchdog gave up on a slow handshake. So such a close is deferred until the socket
 * opens (or fails on its own), and the subscriber hears nothing more from it either way. Failures of the network
 * itself ("WebSocket connection to ... failed") are logged by the browser and cannot be suppressed from script;
 * they surface as 'reconnecting' in the UI and the adapter reconnects.
 */
export function browserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    like.onmessage = like.onclose = like.onerror = like.onopen = null;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.onopen = () => ws.close();
      ws.onmessage = ws.onerror = ws.onclose = null;
      return;
    }
    ws.close();
  };
  const like: WebSocketLike = { onmessage: null, onclose: null, onerror: null, onopen: null, close };
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  ws.onclose = () => like.onclose?.();
  ws.onerror = () => like.onerror?.();
  ws.onopen = () => like.onopen?.();
  return like;
}

/** Binance USD-M futures public market data (no API key). */
export class BinanceFuturesAdapter implements MarketDataAdapter {
  readonly name = 'binance-futures';
  private readonly restBase: string;
  private readonly wsBase: string;
  private readonly fetchFn: (url: string) => Promise<Response>;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly reconnectDelayMs: number;
  private readonly staleAfterMs: number;
  private readonly clockRefreshMs: number;
  /** serverTime - localTime, measured at the RTT midpoint; null until /fapi/v1/time answered once. */
  private clock: { offset: number; measuredAt: number } | null = null;
  private lastClockAttempt = -Infinity;

  constructor(options: BinanceAdapterOptions = {}) {
    this.restBase = options.restBase ?? 'https://fapi.binance.com';
    this.wsBase = options.wsBase ?? 'wss://fstream.binance.com/market/ws';
    this.fetchFn = options.fetchFn ?? ((url) => fetch(url));
    this.wsFactory = options.wsFactory ?? browserSocket;
    this.now = options.now ?? (() => Date.now());
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
    this.clockRefreshMs = options.clockRefreshMs ?? 5 * 60_000;
  }

  /** Binance server time now (local clock + measured offset), or null when it was never measured. */
  serverNow(): number | null {
    return this.clock === null ? null : this.now() + this.clock.offset;
  }

  /**
   * Measures the server clock offset from the public /fapi/v1/time (offset taken at the midpoint of the round
   * trip). Returns false when the endpoint is unreachable; a previous measurement is then kept.
   */
  async syncClock(): Promise<boolean> {
    this.lastClockAttempt = this.now();
    try {
      const t0 = this.now();
      const res = await this.fetchFn(`${this.restBase}/fapi/v1/time`);
      const t1 = this.now();
      if (!res.ok) return false;
      const body = (await res.json()) as { serverTime?: unknown };
      if (typeof body?.serverTime !== 'number' || !Number.isFinite(body.serverTime)) return false;
      this.clock = { offset: body.serverTime - (t0 + t1) / 2, measuredAt: t1 };
      return true;
    } catch {
      return false;
    }
  }

  /** Measures the clock when never done or stale (failed attempts are not repeated more than every 30 s). */
  private async ensureClock(): Promise<void> {
    const t = this.now();
    if (this.clock !== null && t - this.clock.measuredAt < this.clockRefreshMs) return;
    if (t - this.lastClockAttempt < CLOCK_RETRY_MS) return;
    await this.syncClock();
  }

  /**
   * Closed candles only. "Closed" is decided by the SERVER clock (local clocks drift): a row whose close time is
   * not before server-now is the forming bar. Without a server time (endpoint down) the rule is conservative:
   * the newest row the server returned is never accepted, because it may be the forming bar; it is picked up
   * once a later bar exists (or the websocket confirms it). A wrong local clock can only delay bars, never
   * let a forming one through.
   */
  async fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
    await this.ensureClock();
    const step = timeframeToMs(tf);
    const out: Candle[] = [];
    let cursor = startMs;
    while (cursor <= endMs) {
      const url =
        `${this.restBase}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}` +
        `&startTime=${cursor}&endTime=${endMs}&limit=${BINANCE_MAX_LIMIT}`;
      const res = await this.fetchFn(url);
      if (!res.ok) throw await httpError(res);
      const rows = (await res.json()) as BinanceKlineRow[];
      if (rows.length === 0) break;
      const serverNow = this.serverNow();
      const lastPage = rows.length < BINANCE_MAX_LIMIT;
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const newest = lastPage && i === rows.length - 1; // the latest bar the server has in range: maybe forming
        if (serverNow !== null ? row[6] >= serverNow - (newest ? CLOSE_GUARD_MS : 0) : newest) continue;
        if (out.length > 0 && row[0] <= out[out.length - 1].time) continue;
        out.push(parseKlineRow(row));
      }
      if (rows.length < BINANCE_MAX_LIMIT) break;
      cursor = rows[rows.length - 1][0] + step;
    }
    return out;
  }

  async firstBarAtOrAfter(symbol: string, tf: Timeframe, fromMs: number): Promise<number | null> {
    const url = `${this.restBase}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&startTime=${fromMs}&limit=1`;
    const res = await this.fetchFn(url);
    if (!res.ok) throw await httpError(res);
    const rows = (await res.json()) as BinanceKlineRow[];
    return rows.length > 0 && rows[0][0] >= fromMs ? rows[0][0] : null;
  }

  subscribeCandles(
    symbol: string,
    tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    onError?: (error: Error) => void,
    onStatus?: (state: ConnectionState) => void,
  ): CandleSubscription {
    const url = `${this.wsBase}/${symbol.toLowerCase()}@kline_${tf}`;
    let stopped = false;
    let socket: WebSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let open = false;
    let lastMessageAt = this.now();

    const scheduleReconnect = () => {
      open = false;
      onStatus?.('reconnecting');
      timer = setTimeout(connect, this.reconnectDelayMs);
    };
    const markOpen = () => {
      if (open) return;
      open = true;
      onStatus?.('open');
    };
    const connect = () => {
      timer = null;
      lastMessageAt = this.now();
      const s = this.wsFactory(url);
      socket = s;
      s.onopen = markOpen;
      s.onmessage = (ev) => {
        lastMessageAt = this.now();
        markOpen();
        const parsed = typeof ev.data === 'string' ? parseKlineMessage(ev.data) : null;
        if (parsed) onCandle(parsed.candle, parsed.closed);
      };
      s.onerror = () => onError?.(new Error(`WebSocket error on ${url}`));
      s.onclose = () => {
        if (!stopped && socket === s) scheduleReconnect();
      };
    };
    // A dead connection may never fire onclose (closing handshake on a half-open socket can hang): drop it ourselves.
    const watchdog = setInterval(() => {
      if (stopped || timer !== null || socket === null) return;
      if (this.now() - lastMessageAt < this.staleAfterMs) return;
      const dead = socket;
      socket = null;
      dead.onmessage = dead.onclose = dead.onerror = null;
      dead.onopen = null;
      dead.close();
      scheduleReconnect();
    }, Math.max(1000, Math.floor(this.staleAfterMs / 3)));
    onStatus?.('connecting');
    connect();

    return {
      close: () => {
        stopped = true;
        clearInterval(watchdog);
        if (timer !== null) clearTimeout(timer);
        socket?.close();
      },
    };
  }
}
