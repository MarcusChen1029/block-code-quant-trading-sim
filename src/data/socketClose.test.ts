import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BinanceFuturesAdapter, browserSocket } from './binance';

/**
 * Browser WebSocket stand-in: readyState CONNECTING until open(). A real browser logs "WebSocket is closed before
 * the connection is established" (and fires error) when close() is called in CONNECTING: that is the console noise.
 */
class FakeBrowserSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static all: FakeBrowserSocket[] = [];
  readyState = FakeBrowserSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  /** close() calls made while still CONNECTING (each one is a console error in a browser). */
  closedWhileConnecting = 0;
  closeCalls = 0;
  constructor(readonly url: string) {
    FakeBrowserSocket.all.push(this);
  }
  close(): void {
    this.closeCalls++;
    if (this.readyState === FakeBrowserSocket.CONNECTING) {
      this.closedWhileConnecting++;
      this.readyState = FakeBrowserSocket.CLOSED;
      this.onerror?.();
      this.onclose?.();
      return;
    }
    if (this.readyState === FakeBrowserSocket.OPEN) {
      this.readyState = FakeBrowserSocket.CLOSED;
      this.onclose?.();
    }
  }
  open(): void {
    if (this.readyState !== FakeBrowserSocket.CONNECTING) return;
    this.readyState = FakeBrowserSocket.OPEN;
    this.onopen?.();
  }
  fail(): void {
    this.readyState = FakeBrowserSocket.CLOSED;
    this.onerror?.();
    this.onclose?.();
  }
}

const original = (globalThis as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  FakeBrowserSocket.all = [];
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeBrowserSocket;
});

afterEach(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = original;
  vi.useRealTimers();
});

describe('WebSocket close without console noise', () => {
  it('a socket closed while CONNECTING is closed only once it opens (no "closed before established" error)', () => {
    const like = browserSocket('wss://x');
    const raw = FakeBrowserSocket.all[0];
    like.close();
    expect(raw.closedWhileConnecting).toBe(0);
    raw.open();
    expect(raw.closeCalls).toBe(1);
    expect(raw.readyState).toBe(FakeBrowserSocket.CLOSED);
  });

  it('a deferred close never reports the late open or close to the subscriber', () => {
    const like = browserSocket('wss://x');
    const seen: string[] = [];
    like.onopen = () => seen.push('open');
    like.onclose = () => seen.push('close');
    like.onerror = () => seen.push('error');
    like.close();
    FakeBrowserSocket.all[0].open();
    expect(seen).toEqual([]);
  });

  it('a deferred close of a socket that then fails on its own does nothing more', () => {
    const like = browserSocket('wss://x');
    like.close();
    const raw = FakeBrowserSocket.all[0];
    raw.fail();
    expect(raw.closedWhileConnecting).toBe(0);
  });

  it('stopping a subscription right after it started (mode switch, stop) closes no CONNECTING socket', () => {
    vi.useFakeTimers();
    const adapter = new BinanceFuturesAdapter();
    const sub = adapter.subscribeCandles('BTCUSDT', '1m', () => {});
    sub.close();
    FakeBrowserSocket.all[0].open();
    vi.advanceTimersByTime(60_000);
    expect(FakeBrowserSocket.all.map((s) => s.closedWhileConnecting)).toEqual([0]);
    expect(FakeBrowserSocket.all).toHaveLength(1); // no reconnect after close()
  });

  it('the stale-socket watchdog never closes a socket that is still CONNECTING (slow handshake)', () => {
    vi.useFakeTimers();
    let now = 0;
    const adapter = new BinanceFuturesAdapter({ now: () => now, staleAfterMs: 30_000, reconnectDelayMs: 3000 });
    const states: string[] = [];
    const sub = adapter.subscribeCandles('BTCUSDT', '1m', () => {}, undefined, (s) => states.push(s));
    for (let i = 0; i < 40; i++) {
      now += 1000;
      vi.advanceTimersByTime(1000);
    }
    sub.close();
    expect(FakeBrowserSocket.all.reduce((n, s) => n + s.closedWhileConnecting, 0)).toBe(0);
    expect(states[0]).toBe('connecting');
    expect(states).toContain('reconnecting'); // the stuck handshake was still given up on
  });
});
