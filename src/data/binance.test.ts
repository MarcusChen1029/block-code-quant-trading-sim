import { describe, it, expect, vi } from 'vitest';
import {
  BinanceFuturesAdapter,
  BINANCE_MAX_LIMIT,
  parseKlineMessage,
  parseKlineRow,
  type BinanceKlineRow,
  type WebSocketLike,
} from './binance';

// Recorded from GET https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2 (2026-10-05)
const RECORDED_ROWS: BinanceKlineRow[] = [
  [1791172800000, '86050.20', '86107.00', '85448.70', '85500.00', '11166.988', 1791176399999, '957328993.75470', 193260, '5038.520', '431876711.84260', '0'],
  [1791176400000, '85500.00', '85751.70', '85369.00', '85734.10', '6976.275', 1791179999999, '596963669.57250', 125316, '4083.423', '349447215.99690', '0'],
];

// Shape documented for wss://fstream.binance.com/market/ws/<symbol>@kline_<interval>
const RECORDED_WS_MESSAGE = JSON.stringify({
  e: 'kline', E: 1791176460000, s: 'BTCUSDT',
  k: {
    t: 1791176400000, T: 1791179999999, s: 'BTCUSDT', i: '1h', f: 1, L: 2,
    o: '85500.00', c: '85734.10', h: '85751.70', l: '85369.00', v: '6976.275',
    n: 125316, x: false, q: '596963669.57250', V: '4083.423', Q: '349447215.99690', B: '0',
  },
});

const HOUR = 3_600_000;

/** Fake /fapi/v1/klines: one 1h bar per hour from `firstOpen`, `count` bars total, honours startTime/endTime/limit. */
/** `serverNow` answers /fapi/v1/time (default: well after the last bar, so every bar is closed). */
function fakeKlinesServer(firstOpen: number, count: number, serverNow = () => firstOpen + (count + 10) * HOUR) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string) => {
    calls.push(input);
    const url = new URL(input);
    if (url.pathname === '/fapi/v1/time') return new Response(JSON.stringify({ serverTime: serverNow() }), { status: 200 });
    const start = Number(url.searchParams.get('startTime'));
    const end = Number(url.searchParams.get('endTime'));
    const limit = Number(url.searchParams.get('limit'));
    const rows: BinanceKlineRow[] = [];
    for (let i = 0; i < count && rows.length < limit; i++) {
      const t = firstOpen + i * HOUR;
      if (t < start || t > end) continue;
      const p = String(100 + i);
      rows.push([t, p, p, p, p, '1', t + HOUR - 1, '0', 1, '0', '0', '0']);
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  });
  return { fetchFn, calls };
}

describe('parseKlineRow', () => {
  it('converts a recorded REST row into a numeric Candle', () => {
    expect(parseKlineRow(RECORDED_ROWS[0])).toEqual({
      time: 1791172800000, open: 86050.2, high: 86107, low: 85448.7, close: 85500, volume: 11166.988,
    });
  });
});

describe('parseKlineMessage', () => {
  it('parses a raw kline stream message', () => {
    expect(parseKlineMessage(RECORDED_WS_MESSAGE)).toEqual({
      candle: { time: 1791176400000, open: 85500, high: 85751.7, low: 85369, close: 85734.1, volume: 6976.275 },
      closed: false,
    });
  });

  it('unwraps combined-stream messages', () => {
    const wrapped = JSON.stringify({ stream: 'btcusdt@kline_1h', data: JSON.parse(RECORDED_WS_MESSAGE) });
    expect(parseKlineMessage(wrapped)?.candle.close).toBe(85734.1);
  });

  it('returns null for non-kline messages', () => {
    expect(parseKlineMessage('{"result":null,"id":1}')).toBeNull();
    expect(parseKlineMessage('not json')).toBeNull();
  });
});

describe('BinanceFuturesAdapter.fetchCandles', () => {
  it('builds the futures klines URL', async () => {
    const { fetchFn, calls } = fakeKlinesServer(0, 2);
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => 10 * HOUR });
    await adapter.fetchCandles('BTCUSDT', '1h', 0, HOUR);
    expect(calls[0]).toBe('https://fapi.binance.com/fapi/v1/time'); // server clock first: it decides what is closed
    expect(calls[1]).toBe(
      `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&startTime=0&endTime=${HOUR}&limit=${BINANCE_MAX_LIMIT}`,
    );
  });

  it('paginates past the 1500-row limit without gaps or duplicates', async () => {
    const total = 3200;
    const { fetchFn } = fakeKlinesServer(0, total);
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => (total + 10) * HOUR });
    const candles = await adapter.fetchCandles('BTCUSDT', '1h', 0, (total - 1) * HOUR);
    expect(fetchFn).toHaveBeenCalledTimes(4); // /time + 3 kline pages
    expect(candles).toHaveLength(total);
    for (let i = 0; i < total; i++) expect(candles[i].time).toBe(i * HOUR);
  });

  it('drops the still-forming last candle', async () => {
    // SERVER time is inside bar 4 (opened at 4h, closes at 5h - 1); the local clock is 2 h fast and must not matter
    const { fetchFn } = fakeKlinesServer(0, 5, () => 4 * HOUR + 1000);
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => 6 * HOUR + 1000 });
    const candles = await adapter.fetchCandles('BTCUSDT', '1h', 0, 10 * HOUR);
    expect(candles.map((c) => c.time)).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
  });

  it('throws with status and body on HTTP errors', async () => {
    const fetchFn = vi.fn(async () => new Response('{"code":-1121,"msg":"Invalid symbol."}', { status: 400 }));
    const adapter = new BinanceFuturesAdapter({ fetchFn });
    await expect(adapter.fetchCandles('NOPE', '1h', 0, HOUR)).rejects.toThrow('Binance rejected the request (HTTP 400): Invalid symbol.');
  });
});

class FakeSocket implements WebSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

describe('BinanceFuturesAdapter.subscribeCandles', () => {
  it('connects to the market kline stream and forwards parsed candles', () => {
    const sockets: FakeSocket[] = [];
    const adapter = new BinanceFuturesAdapter({ wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; } });
    const received: Array<[number, boolean]> = [];
    const sub = adapter.subscribeCandles('BTCUSDT', '1h', (c, closed) => received.push([c.close, closed]));
    expect(sockets[0].url).toBe('wss://fstream.binance.com/market/ws/btcusdt@kline_1h');
    sockets[0].onmessage?.({ data: RECORDED_WS_MESSAGE });
    expect(received).toEqual([[85734.1, false]]);
    sub.close(); // also stops the stale-socket watchdog timer
  });

  it('reconnects after an unexpected close but not after close()', () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const adapter = new BinanceFuturesAdapter({
        reconnectDelayMs: 1000,
        wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      });
      const sub = adapter.subscribeCandles('ETHUSDT', '5m', () => {});
      sockets[0].onclose?.(); // server dropped us
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
      sub.close();
      expect(sockets[1].closed).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports connecting -> open -> reconnecting -> open across a drop', () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const adapter = new BinanceFuturesAdapter({
        reconnectDelayMs: 1000,
        wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      });
      const states: string[] = [];
      const sub = adapter.subscribeCandles('BTCUSDT', '1m', () => {}, undefined, (s) => states.push(s));
      expect(states).toEqual(['connecting']);
      sockets[0].onmessage?.({ data: RECORDED_WS_MESSAGE }); // no onopen support: the first message counts
      sockets[0].onmessage?.({ data: RECORDED_WS_MESSAGE });
      sockets[0].onclose?.();
      vi.advanceTimersByTime(1000);
      (sockets[1] as WebSocketLike).onopen?.();
      expect(states).toEqual(['connecting', 'open', 'reconnecting', 'open']);
      sub.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a socket that went silent (sleep / half-open connection) and opens a new one', () => {
    vi.useFakeTimers();
    try {
      let now = 0;
      const sockets: FakeSocket[] = [];
      const adapter = new BinanceFuturesAdapter({
        now: () => now,
        reconnectDelayMs: 500,
        staleAfterMs: 9000,
        wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      });
      const states: string[] = [];
      const sub = adapter.subscribeCandles('BTCUSDT', '1m', () => {}, undefined, (s) => states.push(s));
      sockets[0].onmessage?.({ data: RECORDED_WS_MESSAGE });
      now = 5000;
      vi.advanceTimersByTime(6000);
      expect(sockets).toHaveLength(1); // still fresh
      now = 10_000;
      vi.advanceTimersByTime(3000); // watchdog sees 10 s of silence
      expect(sockets[0].closed).toBe(true);
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(2);
      expect(states).toEqual(['connecting', 'open', 'reconnecting']);
      sub.close();
      vi.advanceTimersByTime(60_000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
