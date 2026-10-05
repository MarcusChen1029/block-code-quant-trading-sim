import { assertLength, type SeriesIndicator } from './types';
import { RingBuffer } from './window';

/** ta.sma: arithmetic mean of the last `length` values. */
export class Sma implements SeriesIndicator {
  private readonly window: RingBuffer;
  private total = 0;
  private sinceResync = 0;

  constructor(readonly length: number) {
    assertLength(length);
    this.window = new RingBuffer(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    const evicted = this.window.push(value);
    this.total += Number.isNaN(evicted) ? value : value - evicted;
    // Recompute the exact sum once per window to stop floating-point drift (amortised O(1)).
    if (++this.sinceResync >= this.length) {
      this.total = this.window.sum();
      this.sinceResync = 0;
    }
    return this.window.full ? this.total / this.length : NaN;
  }
}

/** Exponential smoothing seeded with the SMA of the first `length` values (TradingView seeding). */
class SeededSmoothing implements SeriesIndicator {
  private readonly seed: Sma;
  private value = NaN;

  constructor(readonly length: number, private readonly alpha: number) {
    this.seed = new Sma(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (Number.isNaN(this.value)) {
      this.value = this.seed.update(value);
      return this.value;
    }
    this.value = this.alpha * value + (1 - this.alpha) * this.value;
    return this.value;
  }
}

/** ta.ema: alpha = 2 / (length + 1). */
export class Ema extends SeededSmoothing {
  constructor(length: number) {
    super(length, 2 / (length + 1));
  }
}

/** ta.rma (Wilder): alpha = 1 / length. Used by RSI and ATR. */
export class Rma extends SeededSmoothing {
  constructor(length: number) {
    super(length, 1 / length);
  }
}

/** ta.wma: linearly weighted, newest value has weight `length`, oldest weight 1. */
export class Wma implements SeriesIndicator {
  private readonly window: RingBuffer;
  private readonly denominator: number;
  private total = 0;
  private weighted = 0;

  constructor(readonly length: number) {
    assertLength(length);
    this.window = new RingBuffer(length);
    this.denominator = (length * (length + 1)) / 2;
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (!this.window.full) {
      this.window.push(value);
      this.total += value;
      this.weighted += this.window.size * value;
      return this.window.full ? this.weighted / this.denominator : NaN;
    }
    const evicted = this.window.push(value);
    // Shifting every weight down by one subtracts the old total; the new value enters with weight `length`.
    this.weighted = this.weighted - this.total + this.length * value;
    this.total = this.total - evicted + value;
    return this.weighted / this.denominator;
  }
}
