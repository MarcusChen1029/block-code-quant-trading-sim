import type { Hlc } from './types';
import { Atr } from './volatility';

export interface SupertrendValue {
  /** The trailing band of the current trend (lower band in an up trend, upper band in a down trend). */
  line: number;
  /** 1 = up trend, -1 = down trend. */
  direction: number;
  /** The trend flipped up / down on this bar. */
  flippedUp: boolean;
  flippedDown: boolean;
}

/**
 * Supertrend with exactly the rules of the Pine "Supertrend" template (src/pine/templates.ts): bands
 * src ± factor × ATR that only ratchet towards price while the trend holds; the trend flips when the close
 * crosses the previous opposite band. `src` is normally hl2. The first bar never flips.
 */
export class Supertrend {
  private readonly atr: Atr;
  private upper = NaN;
  private lower = NaN;
  private trend = 1;
  private prevClose = NaN;

  constructor(readonly length = 10, readonly factor = 3) {
    this.atr = new Atr(length);
  }

  update(src: number, bar: Hlc): SupertrendValue {
    const a = this.atr.update(bar);
    const basicUpper = src + this.factor * a;
    const basicLower = src - this.factor * a;
    const prevUpper = this.upper;
    const prevLower = this.lower;
    const prevClose = this.prevClose;
    this.prevClose = bar.close;
    this.upper = Number.isNaN(prevUpper) || prevClose > prevUpper ? basicUpper : Math.min(basicUpper, prevUpper);
    this.lower = Number.isNaN(prevLower) || prevClose < prevLower ? basicLower : Math.max(basicLower, prevLower);
    const before = this.trend;
    if (Number.isNaN(a)) this.trend = 1;
    else if (this.trend === -1 && bar.close > prevUpper) this.trend = 1;
    else if (this.trend === 1 && bar.close < prevLower) this.trend = -1;
    return {
      line: this.trend === 1 ? this.lower : this.upper,
      direction: this.trend,
      flippedUp: before === -1 && this.trend === 1,
      flippedDown: before === 1 && this.trend === -1,
    };
  }
}
