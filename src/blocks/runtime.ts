import type { Candle } from '../data/types';
import { StrategyError, type EntryRequest, type StrategyContext } from '../engine/strategy';
import { CrossOver, CrossUnder } from '../indicators/primitives';
import { MAX_LOOP_ITERATIONS_PER_BAR } from './blockTypes';
import { priceOf, type PriceSource } from './priceSource';
import { getIndicator, type IndicatorInstance } from './registry';

export interface RuntimeLimits {
  /** Loop iterations + function calls allowed per bar (spec: 10,000). */
  maxIterationsPerBar: number;
  /** Wall-clock budget per bar in ms, checked inside loops and calls. */
  maxBarMs: number;
  /** Clock used for the time budget (injectable for tests). */
  now: () => number;
}

export const DEFAULT_LIMITS: RuntimeLimits = {
  maxIterationsPerBar: MAX_LOOP_ITERATIONS_PER_BAR,
  maxBarMs: 1000,
  now: () => performance.now(),
};

/** Last `capacity` candles, newest at offset 0. */
class CandleHistory {
  private readonly buf: Candle[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array<Candle>(capacity);
  }

  push(candle: Candle): void {
    this.buf[this.head] = candle;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get(offset: number): Candle | undefined {
    if (offset < 0 || offset >= this.count) return undefined;
    return this.buf[(this.head - 1 - offset + this.capacity) % this.capacity];
  }
}

/**
 * The only object generated code can reach besides `ctx`. Tracks which block is executing (`at`) so any
 * error is reported against it, enforces the per-bar iteration and time limits, and owns the price history.
 */
export class BlockRuntime {
  private current = -1;
  private iterations = 0;
  private barStart = 0;
  private lastBar = -1;
  private readonly history: CandleHistory;
  /** Per block index: actions skipped so far because a value was na (see skipNa). */
  private readonly naSkips = new Map<number, number>();

  constructor(private readonly blockIds: readonly string[], maxOffset: number, private readonly limits: RuntimeLimits = DEFAULT_LIMITS) {
    this.history = new CandleHistory(maxOffset + 1);
  }

  /** Called at the top of init/onBar; true once per new bar (then the caller runs hoist()). */
  beginBar(ctx: StrategyContext): boolean {
    if (ctx.barIndex === this.lastBar) return false;
    this.lastBar = ctx.barIndex;
    this.iterations = 0;
    this.barStart = this.limits.now();
    this.history.push(ctx.candle);
    return true;
  }

  /** Marks block #i as executing. */
  at(i: number): void {
    this.current = i;
  }

  /** Restores block #i as current after a function call inside an expression returned. */
  ret<T>(value: T, i: number): T {
    this.current = i;
    return value;
  }

  /** One loop iteration of block #i. */
  loop(i: number): void {
    this.current = i;
    this.spend(i, 'loop iterations');
  }

  /** Entry into function #i (calls share the loop budget, which also bounds recursion). */
  call(i: number): void {
    this.current = i;
    this.spend(i, 'loop iterations and function calls');
  }

  /** Repeat count: NaN/negative -> 0, fractions rounded down. */
  times(n: unknown): number {
    const v = Math.floor(Number(n));
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** `field` of the bar `offset` bars ago (0 = the bar that just closed); NaN before the first bar. */
  price(field: PriceSource, offset: number): number {
    const candle = this.history.get(offset);
    return candle ? priceOf(candle, field) : NaN;
  }

  indicator(id: string, params: Record<string, number>): IndicatorInstance {
    const def = getIndicator(id);
    if (!def) throw new Error(`unknown indicator "${id}"`);
    return def.create(params);
  }

  cross(kind: 'over' | 'under'): CrossOver | CrossUnder {
    return kind === 'over' ? new CrossOver() : new CrossUnder();
  }

  /**
   * A market / limit order block. `na` (NaN) as the size or the limit price (e.g. "nearest zone bottom" with no zone)
   * skips THIS order with a warning and the run goes on; every other value goes to the broker unchanged, so finite
   * invalid ones (<= 0, Infinity) still halt the run with this block's id. Returns the order id, or -1 when skipped.
   */
  order(ctx: StrategyContext, side: 'buy' | 'sell', request: EntryRequest): number {
    const kind = request.type === 'limit' ? 'limit order' : 'market order';
    if (isNa(request.size)) return this.skipNa(ctx, kind, kind, 'size');
    if (request.type === 'limit' && isNa(request.price)) return this.skipNa(ctx, kind, kind, 'limit price');
    return side === 'sell' ? ctx.sell(request) : ctx.buy(request);
  }

  /** Stop-loss / take-profit block: na skips it with a warning (see order); any other non-positive price halts. */
  setExit(ctx: StrategyContext, kind: 'stopLoss' | 'takeProfit', price: unknown): void {
    const label = kind === 'stopLoss' ? 'stop-loss' : 'take-profit';
    if (isNa(price)) {
      this.skipNa(ctx, `set ${label}`, 'set stop-loss / take-profit', 'price');
      return;
    }
    const p = Number(price);
    if (!(Number.isFinite(p) && p > 0)) throw new Error(`${label} price must be a positive number, got ${String(price)}`);
    if (kind === 'stopLoss') ctx.setStopLoss(p);
    else ctx.setTakeProfit(p);
  }

  /**
   * Logs that the current block's action was skipped because its `what` was na: the first time with the whole story,
   * then only at the 10th, 100th, 1000th... skip with the count (a strategy that is na on most bars must not flood the
   * log). Warm-up bars (live) drop warnings: those skips are not counted, so the first trading bar still warns.
   */
  private skipNa(ctx: StrategyContext, action: string, blockLabel: string, what: string): -1 {
    const i = this.current;
    const n = (this.naSkips.get(i) ?? 0) + 1;
    const block = `block '${blockLabel}' (id ${this.blockIds[i]})`;
    let message: string | null = null;
    if (n === 1) message = `${action} skipped: its ${what} is na (no value) — ${block}. Further skips by this block are only counted.`;
    else if (isPowerOf10(n)) message = `${action} skipped ${n.toLocaleString('en-US')} times so far: its ${what} is na — ${block}.`;
    if (message !== null && !warn(ctx, message)) return -1;
    this.naSkips.set(i, n);
    return -1;
  }

  /** Text for log messages: numbers print as JS does, NaN as Pine's "na". */
  text(value: unknown): string {
    if (typeof value === 'number' && Number.isNaN(value)) return 'na';
    return String(value);
  }

  /** Wraps any error thrown by generated code with the id of the block that was executing. */
  toError(err: unknown): StrategyError {
    if (err instanceof StrategyError) return err;
    const message = err instanceof Error ? err.message : String(err);
    return new StrategyError(message, this.blockIds[this.current]);
  }

  private spend(i: number, what: string): void {
    if (++this.iterations > this.limits.maxIterationsPerBar) {
      throw new StrategyError(`more than ${this.limits.maxIterationsPerBar.toLocaleString('en-US')} ${what} in one bar`, this.blockIds[i]);
    }
    if ((this.iterations & 255) === 0 && this.limits.now() - this.barStart > this.limits.maxBarMs) {
      throw new StrategyError(`one bar took longer than ${this.limits.maxBarMs} ms`, this.blockIds[i]);
    }
  }
}

/** Pine's na: only a real NaN number (other bad values keep their hard errors). */
function isNa(value: unknown): boolean {
  return typeof value === 'number' && Number.isNaN(value);
}

function isPowerOf10(n: number): boolean {
  for (let p = 10; p <= n; p *= 10) if (p === n) return true;
  return false;
}

/** A warning in the run log; contexts without warn() get it as a plain log line. False when dropped (warm-up). */
function warn(ctx: StrategyContext, message: string): boolean {
  if (ctx.warn) return ctx.warn(message);
  ctx.log(`warning: ${message}`);
  return true;
}
