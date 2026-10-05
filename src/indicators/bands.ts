import { assertLength, type SeriesIndicator } from './types';
import { RingBuffer } from './window';

/** ta.stdev(source, length) with biased=true (population standard deviation), sliding Welford update. */
export class Stdev implements SeriesIndicator {
  private readonly window: RingBuffer;
  private mean = 0;
  private m2 = 0; // sum of squared deviations from the mean

  constructor(readonly length: number) {
    assertLength(length);
    this.window = new RingBuffer(length);
  }

  /** Mean of the current window (valid once the window is full). */
  get average(): number {
    return this.window.full ? this.mean : NaN;
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (!this.window.full) {
      this.window.push(value);
      const n = this.window.size;
      const delta = value - this.mean;
      this.mean += delta / n;
      this.m2 += delta * (value - this.mean);
    } else {
      const old = this.window.push(value);
      const oldMean = this.mean;
      this.mean += (value - old) / this.length;
      this.m2 += (value - old) * (value - this.mean + old - oldMean);
    }
    return this.window.full ? Math.sqrt(Math.max(this.m2, 0) / this.length) : NaN;
  }
}

export interface BandsValue {
  middle: number;
  upper: number;
  lower: number;
}

/** ta.bb(source, length, mult): middle = sma, bands = middle ± mult * stdev. */
export class BollingerBands {
  private readonly stdev: Stdev;

  constructor(readonly length = 20, readonly mult = 2) {
    this.stdev = new Stdev(length);
  }

  update(value: number): BandsValue {
    const sd = this.stdev.update(value);
    if (Number.isNaN(sd)) return { middle: NaN, upper: NaN, lower: NaN };
    const middle = this.stdev.average;
    return { middle, upper: middle + this.mult * sd, lower: middle - this.mult * sd };
  }
}
