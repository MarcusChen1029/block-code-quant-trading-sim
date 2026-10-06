import type { CandleSubscription, ConnectionState, MarketDataAdapter } from '../data/adapter';
import type { Candle, Timeframe } from '../data/types';
import type { Strategy } from '../engine/strategy';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import type { HaltInfo, LiveStatus, RunnerHooks, Timers } from './runner';
import { smaCrossSnapshot, type LiveSessionRecord, type StrategySnapshot } from './session';
import type { SessionDelta } from './sessionEngine';

export const MINUTE = 60_000;

/**
 * Scriptable market for tests: REST serves the fixture bars that are closed at `now`; the websocket is driven
 * by hand (emit / drop / reconnect). `failNext` makes the next REST calls throw.
 */
export class FakeMarket implements MarketDataAdapter {
  readonly name = 'fake';
  now: number;
  failNext = 0;
  readonly fetchCalls: Array<[number, number]> = [];
  private onCandle: ((c: Candle, closed: boolean) => void) | null = null;
  private onStatus: ((s: ConnectionState) => void) | null = null;
  subscriptions = 0;
  closed = false;

  constructor(readonly bars: Candle[], readonly step = MINUTE, now = 0) {
    this.now = now;
  }

  async fetchCandles(_symbol: string, _tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
    this.fetchCalls.push([startMs, endMs]);
    await Promise.resolve();
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('Binance HTTP 503: unavailable');
    }
    return this.bars.filter((c) => c.time >= startMs && c.time <= endMs && c.time + this.step <= this.now).map((c) => ({ ...c }));
  }

  async firstBarAtOrAfter(_symbol: string, _tf: Timeframe, fromMs: number): Promise<number | null> {
    await Promise.resolve();
    return this.bars.find((c) => c.time >= fromMs)?.time ?? null;
  }

  subscribeCandles(
    _symbol: string,
    _tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    _onError?: (error: Error) => void,
    onStatus?: (state: ConnectionState) => void,
  ): CandleSubscription {
    this.subscriptions++;
    this.onCandle = onCandle;
    this.onStatus = onStatus ?? null;
    onStatus?.('connecting');
    return { close: () => { this.closed = true; this.onCandle = null; } };
  }

  /** Bar `index` closes: the clock moves to its close and the socket sends the final update. */
  closeBar(index: number): void {
    const bar = this.bars[index];
    this.now = bar.time + this.step;
    this.onStatus?.('open');
    this.onCandle?.({ ...bar }, true);
  }

  /** A forming update of bar `index` with a fake price (must never reach a strategy). */
  formingTick(index: number, close = 999_999): void {
    const bar = this.bars[index];
    this.now = Math.max(this.now, bar.time + 1);
    this.onCandle?.({ ...bar, close, high: Math.max(bar.high, close) }, false);
  }

  drop(): void {
    this.onStatus?.('reconnecting');
  }
}

/** Timers that only run when the test says so. */
export class ManualTimers implements Timers {
  private nextId = 1;
  readonly timeouts = new Map<number, () => void>();
  readonly intervals = new Map<number, () => void>();
  setTimeout(fn: () => void): unknown {
    const id = this.nextId++;
    this.timeouts.set(id, fn);
    return id;
  }
  clearTimeout(id: unknown): void {
    this.timeouts.delete(id as number);
  }
  setInterval(fn: () => void): unknown {
    const id = this.nextId++;
    this.intervals.set(id, fn);
    return id;
  }
  clearInterval(id: unknown): void {
    this.intervals.delete(id as number);
  }
  runTimeouts(): void {
    const fns = [...this.timeouts.values()];
    this.timeouts.clear();
    for (const fn of fns) fn();
  }
  runIntervals(): void {
    for (const fn of [...this.intervals.values()]) fn();
  }
}

/** Records everything a runner reports. */
export class Recorder implements RunnerHooks {
  readonly deltas: SessionDelta[] = [];
  readonly ticks: Array<{ candle: Candle; markEquity: number; closed: boolean }> = [];
  readonly statuses: LiveStatus[] = [];
  readonly halts: HaltInfo[] = [];
  delta(d: SessionDelta): void { this.deltas.push(d); }
  tick(candle: Candle, markEquity: number, closed: boolean): void { this.ticks.push({ candle, markEquity, closed }); }
  status(s: LiveStatus): void { this.statuses.push(s); }
  halt(h: HaltInfo): void { this.halts.push(h); }
  get processedTimes(): number[] {
    return this.deltas.flatMap((d) => d.candles.map((c) => c.time));
  }
}

/** Wraps a strategy and records the candles it was shown. */
export function spyStrategy(inner: Strategy, seen: Candle[]): Strategy {
  return {
    init: inner.init ? (ctx) => inner.init!(ctx) : undefined,
    onBar(ctx) {
      seen.push(ctx.candle);
      inner.onBar(ctx);
    },
  };
}

export function testSession(overrides: Partial<LiveSessionRecord> = {}, strategy: StrategySnapshot = smaCrossSnapshot()): LiveSessionRecord {
  return {
    id: 's1',
    name: 'test',
    symbol: 'BTCUSDT',
    timeframe: '1m',
    startTime: 0,
    warmupBars: 0,
    brokerConfig: DEFAULT_BROKER_CONFIG,
    strategy,
    createdAt: 0,
    status: 'running',
    lastBarTime: null,
    ...overrides,
  };
}
