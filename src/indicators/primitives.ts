import { assertLength, type Hlc, type SeriesIndicator } from './types';
import { RingBuffer } from './window';

/** ta.change(source, length): source - source[length]. */
export class Change implements SeriesIndicator {
  private readonly window: RingBuffer;

  constructor(readonly length = 1) {
    assertLength(length);
    this.window = new RingBuffer(length + 1);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    this.window.push(value);
    return this.window.full ? value - this.window.get(this.length) : NaN;
  }
}

/**
 * ta.tr(handle_na): max(high - low, |high - close[1]|, |low - close[1]|).
 * On the first bar close[1] is na: returns high - low if handleNa, else NaN (Pine's `ta.tr` variable).
 */
export class TrueRange {
  private prevClose = NaN;

  constructor(private readonly handleNa = false) {}

  update(bar: Hlc): number {
    const pc = this.prevClose;
    this.prevClose = bar.close;
    if (Number.isNaN(pc)) return this.handleNa ? bar.high - bar.low : NaN;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
  }
}

/** ta.crossover(a, b): a > b on this bar and a <= b on the previous bar. */
export class CrossOver {
  private prevA = NaN;
  private prevB = NaN;

  update(a: number, b: number): boolean {
    const result = this.prevA <= this.prevB && a > b;
    this.prevA = a;
    this.prevB = b;
    return result;
  }
}

/** ta.crossunder(a, b): a < b on this bar and a >= b on the previous bar. */
export class CrossUnder {
  private prevA = NaN;
  private prevB = NaN;

  update(a: number, b: number): boolean {
    const result = this.prevA >= this.prevB && a < b;
    this.prevA = a;
    this.prevB = b;
    return result;
  }
}
