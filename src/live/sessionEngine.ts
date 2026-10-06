import { timeframeToMs, type Candle } from '../data/types';
import { Engine, type BacktestResult } from '../engine/engine';
import type { EquityPoint, Stats } from '../engine/stats';
import { StrategyError, type Strategy } from '../engine/strategy';
import type { Fill, LogEntry, PositionView, Trade } from '../engine/types';
import { warmupStart, type LiveSessionDef } from './session';

/** Everything that changed since the previous drain; posted from the worker to the page. */
export interface SessionDelta {
  /** Closed candles processed since the last drain (warm-up included), ascending. */
  candles: Candle[];
  fills: Fill[];
  trades: Trade[];
  equity: EquityPoint[];
  log: LogEntry[];
  stats: Stats;
  position: PositionView;
  lastBarTime: number | null;
  /** Bars processed so far, warm-up included. */
  barsProcessed: number;
  wiped: boolean;
}

export type PushOutcome =
  /** Fed to the engine (warm-up or trading). */
  | 'processed'
  /** Open time <= the last processed bar: already seen, ignored. */
  | 'duplicate'
  /** Before the first warm-up bar, or after the replay end: ignored. */
  | 'out-of-range'
  /** The account is wiped or the strategy failed; nothing more is processed. */
  | 'halted';

export interface SessionFailure {
  message: string;
  blockId?: string;
  barTime: number;
}

/**
 * The live-session state machine, free of any I/O: closed candles in, deltas out. Feeding the same candles
 * yields the same state whether they arrive in one go or one by one, in any batching, with duplicates.
 */
export class SessionEngine {
  private readonly engine: Engine;
  private readonly firstBar: number;
  readonly step: number;
  private last: number | null = null;
  private failure: SessionFailure | null = null;
  private pendingCandles: Candle[] = [];
  private sent = { fills: 0, trades: 0, equity: 0, log: 0 };

  constructor(
    private readonly def: Pick<LiveSessionDef, 'symbol' | 'timeframe' | 'brokerConfig' | 'startTime' | 'warmupBars'>,
    strategy: Strategy,
    /** Inclusive replay bound (a stopped session's last bar); undefined = no end. */
    private readonly endTime?: number,
  ) {
    this.engine = new Engine(strategy, { symbol: def.symbol, timeframe: def.timeframe, broker: def.brokerConfig });
    this.firstBar = warmupStart(def);
    this.step = timeframeToMs(def.timeframe);
  }

  /** Open time of the first warm-up bar (or of the first trading bar without warm-up). */
  get firstBarTime(): number {
    return this.firstBar;
  }

  get replayEnd(): number | undefined {
    return this.endTime;
  }

  get lastBarTime(): number | null {
    return this.last;
  }

  get halted(): boolean {
    return this.failure !== null || this.engine.wiped;
  }

  get wiped(): boolean {
    return this.engine.wiped;
  }

  get error(): SessionFailure | null {
    return this.failure;
  }

  /** Open time of the first bar to request next. */
  get nextBarTime(): number {
    return this.last === null ? this.firstBar : this.last + this.step;
  }

  /** True once the replay bound is reached (never for open-ended sessions). */
  get complete(): boolean {
    return this.endTime !== undefined && this.last !== null && this.last >= this.endTime;
  }

  push(candle: Candle): PushOutcome {
    if (this.halted) return 'halted';
    if (this.last !== null && candle.time <= this.last) return 'duplicate';
    if (candle.time < this.firstBar || (this.endTime !== undefined && candle.time > this.endTime)) return 'out-of-range';
    this.last = candle.time;
    this.pendingCandles.push(candle);
    try {
      if (candle.time < this.def.startTime) this.engine.pushWarmupCandle(candle);
      else this.engine.pushCandle(candle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const blockId = err instanceof StrategyError ? err.blockId : undefined;
      this.failure = blockId === undefined ? { message, barTime: candle.time } : { message, blockId, barTime: candle.time };
      return 'halted';
    }
    return this.engine.wiped ? 'halted' : 'processed';
  }

  markEquity(price: number): number {
    return this.engine.markEquity(price);
  }

  /** New candles/fills/trades/equity/log since the previous drain, plus current stats. */
  drain(): SessionDelta {
    const e = this.engine;
    const delta: SessionDelta = {
      candles: this.pendingCandles,
      fills: e.fills.slice(this.sent.fills),
      trades: e.trades.slice(this.sent.trades),
      equity: e.equityPoints.slice(this.sent.equity),
      log: e.log.slice(this.sent.log),
      stats: e.stats(),
      position: e.position,
      lastBarTime: this.last,
      barsProcessed: e.barsProcessed,
      wiped: e.wiped,
    };
    this.pendingCandles = [];
    this.sent = { fills: e.fills.length, trades: e.trades.length, equity: e.equityPoints.length, log: e.log.length };
    return delta;
  }

  /** Full state (tests, determinism checks). */
  result(): BacktestResult {
    return this.engine.result();
  }
}
