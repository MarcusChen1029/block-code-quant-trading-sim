import type { Candle } from '../data/types';

const DAY_MS = 86_400_000;

/** ta.vwap(hlc3) anchored to the UTC day (TradingView's default "Session" anchor for 24/7 crypto). */
export class Vwap {
  private day = NaN;
  private priceVolume = 0;
  private volume = 0;

  update(candle: Candle): number {
    const day = Math.floor(candle.time / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.priceVolume = 0;
      this.volume = 0;
    }
    const hlc3 = (candle.high + candle.low + candle.close) / 3;
    this.priceVolume += hlc3 * candle.volume;
    this.volume += candle.volume;
    return this.volume === 0 ? NaN : this.priceVolume / this.volume;
  }
}
