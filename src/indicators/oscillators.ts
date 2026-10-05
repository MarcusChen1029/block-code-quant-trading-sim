import { Ema, Rma, Sma } from './averages';
import { Highest, Lowest } from './extremes';
import type { Hlc, SeriesIndicator } from './types';

/** ta.rsi(source, length): Wilder RSI using RMA of gains and losses. */
export class Rsi implements SeriesIndicator {
  private readonly up: Rma;
  private readonly down: Rma;
  private prev = NaN;

  constructor(readonly length = 14) {
    this.up = new Rma(length);
    this.down = new Rma(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    const prev = this.prev;
    this.prev = value;
    if (Number.isNaN(prev)) return NaN; // first bar: change is na
    const up = this.up.update(Math.max(value - prev, 0));
    const down = this.down.update(Math.max(prev - value, 0));
    if (Number.isNaN(up) || Number.isNaN(down)) return NaN;
    if (down === 0) return 100;
    if (up === 0) return 0;
    return 100 - 100 / (1 + up / down);
  }
}

export interface MacdValue {
  macd: number;
  signal: number;
  hist: number;
}

/** ta.macd(source, fast, slow, signal): EMA(fast) - EMA(slow), signal = EMA(macd). */
export class Macd {
  private readonly fast: Ema;
  private readonly slow: Ema;
  private readonly signal: Ema;

  constructor(fastLength = 12, slowLength = 26, signalLength = 9) {
    this.fast = new Ema(fastLength);
    this.slow = new Ema(slowLength);
    this.signal = new Ema(signalLength);
  }

  update(value: number): MacdValue {
    const macd = this.fast.update(value) - this.slow.update(value);
    const signal = this.signal.update(macd); // NaN macd is skipped, so the signal seeds on the first valid values
    return { macd, signal, hist: macd - signal };
  }
}

export interface StochValue {
  k: number;
  d: number;
}

/**
 * TradingView "Stoch": raw = 100 * (close - lowest(low, periodK)) / (highest(high, periodK) - lowest(low, periodK)),
 * %K = sma(raw, smoothK), %D = sma(%K, periodD). A zero range gives na.
 */
export class Stochastic {
  private readonly highest: Highest;
  private readonly lowest: Lowest;
  private readonly smoothK: Sma;
  private readonly smoothD: Sma;

  constructor(periodK = 14, smoothK = 1, periodD = 3) {
    this.highest = new Highest(periodK);
    this.lowest = new Lowest(periodK);
    this.smoothK = new Sma(smoothK);
    this.smoothD = new Sma(periodD);
  }

  update(bar: Hlc): StochValue {
    const hh = this.highest.update(bar.high);
    const ll = this.lowest.update(bar.low);
    const range = hh - ll;
    const raw = range === 0 ? NaN : (100 * (bar.close - ll)) / range;
    const k = this.smoothK.update(raw);
    const d = this.smoothD.update(k);
    return { k, d };
  }
}
