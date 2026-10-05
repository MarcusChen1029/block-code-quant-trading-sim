import type { Candle } from '../data/types';

/** Bar values a block can read: OHLCV plus Pine's composite sources. */
export const PRICE_SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume'] as const;

export type PriceSource = (typeof PRICE_SOURCES)[number];

export function isPriceSource(value: unknown): value is PriceSource {
  return typeof value === 'string' && (PRICE_SOURCES as readonly string[]).includes(value);
}

/** Value of `source` on `candle` (hl2 = (h+l)/2, hlc3 = (h+l+c)/3, ohlc4 = (o+h+l+c)/4, as in Pine). */
export function priceOf(candle: Candle, source: PriceSource): number {
  switch (source) {
    case 'hl2':
      return (candle.high + candle.low) / 2;
    case 'hlc3':
      return (candle.high + candle.low + candle.close) / 3;
    case 'ohlc4':
      return (candle.open + candle.high + candle.low + candle.close) / 4;
    default:
      return candle[source];
  }
}
