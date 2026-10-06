import type { CandleSubscription, ConnectionState, MarketDataAdapter } from './adapter';
import { timeframeToMs, type Candle, type Timeframe } from './types';

/** Max rows per /fapi/v1/klines request. */
export const BINANCE_MAX_LIMIT = 1500;

/** REST kline row: [openTime, open, high, low, close, volume, closeTime, ...ignored]. Prices are strings. */
export type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

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
}

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

function browserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = { onmessage: null, onclose: null, onerror: null, onopen: null, close: () => ws.close() };
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

  constructor(options: BinanceAdapterOptions = {}) {
    this.restBase = options.restBase ?? 'https://fapi.binance.com';
    this.wsBase = options.wsBase ?? 'wss://fstream.binance.com/market/ws';
    this.fetchFn = options.fetchFn ?? ((url) => fetch(url));
    this.wsFactory = options.wsFactory ?? browserSocket;
    this.now = options.now ?? (() => Date.now());
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
    this.staleAfterMs = options.staleAfterMs ?? 30_000;
  }

  async fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
    const step = timeframeToMs(tf);
    const out: Candle[] = [];
    let cursor = startMs;
    while (cursor <= endMs) {
      const url =
        `${this.restBase}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}` +
        `&startTime=${cursor}&endTime=${endMs}&limit=${BINANCE_MAX_LIMIT}`;
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as BinanceKlineRow[];
      if (rows.length === 0) break;
      const nowMs = this.now();
      for (const row of rows) {
        if (row[6] >= nowMs) continue; // bar not closed yet
        if (out.length > 0 && row[0] <= out[out.length - 1].time) continue;
        out.push(parseKlineRow(row));
      }
      if (rows.length < BINANCE_MAX_LIMIT) break;
      cursor = rows[rows.length - 1][0] + step;
    }
    return out;
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
