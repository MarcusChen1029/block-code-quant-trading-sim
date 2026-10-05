import { DEFAULT_LIMITS, type RuntimeLimits } from '../blocks/runtime';
import { priceOf, type PriceSource } from '../blocks/priceSource';
import type { Candle } from '../data/types';
import { Ema, Rma, Sma, Wma } from '../indicators/averages';
import { BollingerBands, Stdev } from '../indicators/bands';
import { Highest, Lowest } from '../indicators/extremes';
import { Macd, Rsi } from '../indicators/oscillators';
import { Change, CrossOver, CrossUnder, TrueRange } from '../indicators/primitives';
import type { SeriesIndicator } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { PineRuntimeError } from './diagnostics';

/** Largest history offset (`x[n]`) a script may use. */
export const MAX_HISTORY = 5000;
/** Largest ta.* length. */
export const MAX_TA_LENGTH = 5000;
/** for-loop iterations allowed per bar (same budget as block loops). */
export const MAX_PINE_ITERATIONS = DEFAULT_LIMITS.maxIterationsPerBar;

/** Last `capacity` values of any kind; get(0) is the newest. */
export class History {
  private readonly buf: unknown[];
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array<unknown>(Math.max(1, capacity));
  }

  push(value: unknown): void {
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.buf.length;
    if (this.count < this.buf.length) this.count++;
  }

  /** NaN (na) when that far back is not stored yet or `n` is not a valid integer. */
  get(n: number): unknown {
    if (!Number.isInteger(n) || n < 0 || n >= this.count) return NaN;
    return this.buf[(this.head - 1 - n + 2 * this.buf.length) % this.buf.length];
  }
}

/** ta.stoch(source, high, low, length): 100 * (source - lowest(low)) / (highest(high) - lowest(low)); zero range -> na. */
class RawStoch {
  private readonly hi: Highest;
  private readonly lo: Lowest;

  constructor(length: number) {
    this.hi = new Highest(length);
    this.lo = new Lowest(length);
  }

  update(source: number, high: number, low: number): number {
    const hh = this.hi.update(high);
    const ll = this.lo.update(low);
    const range = hh - ll;
    return range === 0 ? NaN : (100 * (source - ll)) / range;
  }
}

const EMPTY_CANDLE: Candle = { time: NaN, open: NaN, high: NaN, low: NaN, close: NaN, volume: NaN };

/**
 * The only object generated Pine code can reach (besides the parameter array). One instance per running
 * script instance: it holds the current bar, the candle history and the per-bar loop budget.
 */
export class PineRuntime {
  bar: Candle = EMPTY_CANDLE;
  /** Value of the first input.source (fed by the block's SOURCE input). */
  src = NaN;
  barIndex = -1;
  /** One value per plot, written each bar. */
  readonly out: number[];
  private readonly candles: History;
  private iterations = 0;
  private barStart = 0;

  constructor(
    private readonly title: string,
    maxBarsBack: number,
    plotCount: number,
    private readonly defaultSource: PriceSource,
    /** Same per-bar iteration and wall-clock budget as block strategies (src/blocks/runtime.ts). */
    private readonly limits: RuntimeLimits = DEFAULT_LIMITS,
  ) {
    this.candles = new History(maxBarsBack + 1);
    this.out = new Array<number>(plotCount).fill(NaN);
  }

  /** Starts a new closed bar. `source` overrides the first input.source's default. */
  begin(candle: Candle, source?: number): void {
    this.barIndex++;
    this.bar = candle;
    this.candles.push(candle);
    this.src = source === undefined ? priceOf(candle, this.defaultSource) : source;
    this.iterations = 0;
    this.barStart = this.limits.now();
    this.out.fill(NaN);
  }

  fail(line: number, col: number, message: string): never {
    throw new PineRuntimeError(line, col, `Pine script "${this.title}", line ${line}: ${message}`);
  }

  // ---- series --------------------------------------------------------------------------------------

  /** A bar value `offset` bars ago ('time' and Pine composites included). */
  px(field: string, offset: number): number {
    const candle = offset === 0 ? this.bar : (this.candles.get(offset) as Candle | number);
    if (typeof candle !== 'object') return NaN;
    switch (field) {
      case 'time':
        return candle.time;
      case 'hlcc4':
        return (candle.high + candle.low + 2 * candle.close) / 4;
      default:
        return priceOf(candle, field as PriceSource);
    }
  }

  /** bar_index[offset]. */
  bi(offset: number): number {
    return Number.isInteger(offset) && offset >= 0 && offset <= this.barIndex ? this.barIndex - offset : NaN;
  }

  /** A history buffer for one variable (generated code never uses `new`). */
  history(capacity: number): History {
    return new History(capacity);
  }

  /** `x[offset]` for a variable whose committed past values are in `h`. */
  hist(h: History, current: unknown, offset: number): unknown {
    if (offset === 0) return current;
    return h.get(offset - 1);
  }

  // ---- values --------------------------------------------------------------------------------------

  /** Numeric view of a value: booleans 1/0, anything non-numeric na. */
  num(x: unknown): number {
    if (typeof x === 'number') return x;
    if (typeof x === 'boolean') return x ? 1 : 0;
    return NaN;
  }

  na(x: unknown): boolean {
    return x === undefined || x === null || (typeof x === 'number' && Number.isNaN(x));
  }

  nz(x: unknown, replacement: unknown = 0): unknown {
    return this.na(x) ? replacement : x;
  }

  /** Pine v5 `and` / `or` evaluate both sides (both are function arguments here); na counts as false. */
  and(a: unknown, b: unknown): boolean {
    return Boolean(a) && Boolean(b);
  }

  or(a: unknown, b: unknown): boolean {
    return Boolean(a) || Boolean(b);
  }

  color(): string {
    return 'color';
  }

  // ---- loops ---------------------------------------------------------------------------------------

  loop(line: number, col: number): void {
    const max = this.limits.maxIterationsPerBar;
    if (++this.iterations > max) this.fail(line, col, `more than ${max.toLocaleString('en-US')} loop iterations in one bar`);
    // The clock is read every 256 iterations, as in the block runtime.
    if ((this.iterations & 255) === 0 && this.limits.now() - this.barStart > this.limits.maxBarMs) {
      this.fail(line, col, `one bar took longer than ${this.limits.maxBarMs} ms`);
    }
  }

  /** |by| for a for loop (direction comes from the bounds). */
  forStep(by: unknown, line: number, col: number): number {
    const step = Math.abs(this.num(by));
    if (!(step > 0) || !Number.isFinite(step)) this.fail(line, col, `for loop step must be a non-zero number, got ${String(by)}`);
    return step;
  }

  // ---- math.* --------------------------------------------------------------------------------------

  m_abs = (x: number) => Math.abs(x);
  m_sqrt = (x: number) => Math.sqrt(x);
  m_log = (x: number) => Math.log(x);
  m_log10 = (x: number) => Math.log10(x);
  m_exp = (x: number) => Math.exp(x);
  m_floor = (x: number) => Math.floor(x);
  m_ceil = (x: number) => Math.ceil(x);
  m_sign = (x: number) => Math.sign(x);
  m_sin = (x: number) => Math.sin(x);
  m_cos = (x: number) => Math.cos(x);
  m_tan = (x: number) => Math.tan(x);
  m_asin = (x: number) => Math.asin(x);
  m_acos = (x: number) => Math.acos(x);
  m_atan = (x: number) => Math.atan(x);
  m_todegrees = (x: number) => (x * 180) / Math.PI;
  m_toradians = (x: number) => (x * Math.PI) / 180;
  m_pow = (x: number, y: number) => Math.pow(x, y);
  m_max = (...xs: number[]) => Math.max(...xs);
  m_min = (...xs: number[]) => Math.min(...xs);
  m_avg = (...xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  /** Rounds half away from zero, optionally to `precision` decimals. */
  m_round = (x: number, precision?: number) => {
    const p = precision === undefined ? 1 : 10 ** Math.max(0, Math.trunc(precision));
    return (Math.sign(x) * Math.round(Math.abs(x) * p)) / p;
  };

  // ---- ta.* (one instance per call site, created once per script instance) ------------------------

  private length(fn: string, value: unknown, line: number, col: number, what = 'length'): number {
    const n = this.num(value);
    if (!Number.isInteger(n) || n < 1 || n > MAX_TA_LENGTH) {
      this.fail(line, col, `ta.${fn} ${what} must be a whole number from 1 to ${MAX_TA_LENGTH}, got ${String(value)}`);
    }
    return n;
  }

  sma(len: unknown, line: number, col: number): SeriesIndicator { return new Sma(this.length('sma', len, line, col)); }
  ema(len: unknown, line: number, col: number): SeriesIndicator { return new Ema(this.length('ema', len, line, col)); }
  rma(len: unknown, line: number, col: number): SeriesIndicator { return new Rma(this.length('rma', len, line, col)); }
  wma(len: unknown, line: number, col: number): SeriesIndicator { return new Wma(this.length('wma', len, line, col)); }
  rsi(len: unknown, line: number, col: number): SeriesIndicator { return new Rsi(this.length('rsi', len, line, col)); }
  stdev(len: unknown, line: number, col: number): SeriesIndicator { return new Stdev(this.length('stdev', len, line, col)); }
  change(len: unknown, line: number, col: number): SeriesIndicator {
    return new Change(len === undefined ? 1 : this.length('change', len, line, col));
  }
  highest(len: unknown, line: number, col: number): SeriesIndicator { return new Highest(this.length('highest', len, line, col)); }
  lowest(len: unknown, line: number, col: number): SeriesIndicator { return new Lowest(this.length('lowest', len, line, col)); }

  atr(len: unknown, line: number, col: number): { update(bar: Candle): number } {
    return new Atr(this.length('atr', len, line, col));
  }

  macd(fast: unknown, slow: unknown, signal: unknown, line: number, col: number): { update(v: number): number[] } {
    const m = new Macd(
      this.length('macd', fast, line, col, 'fast length'),
      this.length('macd', slow, line, col, 'slow length'),
      this.length('macd', signal, line, col, 'signal length'),
    );
    return { update: (v) => { const r = m.update(v); return [r.macd, r.signal, r.hist]; } };
  }

  bb(len: unknown, mult: unknown, line: number, col: number): { update(v: number): number[] } {
    const k = this.num(mult);
    if (!Number.isFinite(k)) this.fail(line, col, `ta.bb mult must be a number, got ${String(mult)}`);
    const b = new BollingerBands(this.length('bb', len, line, col), k);
    return { update: (v) => { const r = b.update(v); return [r.middle, r.upper, r.lower]; } };
  }

  stoch(len: unknown, line: number, col: number): RawStoch {
    return new RawStoch(this.length('stoch', len, line, col));
  }

  crossover(): CrossOver { return new CrossOver(); }
  crossunder(): CrossUnder { return new CrossUnder(); }
  tr(handleNa: boolean): TrueRange { return new TrueRange(handleNa); }
}
