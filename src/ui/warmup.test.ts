import { describe, it, expect } from 'vitest';
import { getIndicator } from '../blocks/registry';
import { walkCandles } from '../engine/fixtures';
import { priceOf } from '../blocks/priceSource';
import { indicatorWarmup, maxWarmup } from './warmup';

const CANDLES = walkCandles(400, 5, 0, 0.01);

/** First bar index at which every numeric output of the indicator is a number, + 1 (measured, not assumed). */
function measured(id: string, params: Record<string, number>): number {
  const def = getIndicator(id)!;
  const inst = def.create(params);
  for (let i = 0; i < CANDLES.length; i++) {
    const c = CANDLES[i];
    const out = inst.step(def.source ? priceOf(c, def.source) : NaN, c);
    if (def.outputs.every((o) => Number.isFinite(out[o.key]))) return i + 1;
  }
  return -1;
}

const CASES: Array<[string, Record<string, number>]> = [
  ['sma', { length: 30 }], ['ema', { length: 20 }], ['wma', { length: 9 }], ['rma', { length: 14 }],
  ['rsi', { length: 14, overbought: 70, oversold: 30 }], ['macd', { fast: 12, slow: 26, signal: 9 }], ['macd', { fast: 30, slow: 10, signal: 4 }],
  ['bb', { length: 20, mult: 2 }], ['supertrend', { length: 10, factor: 3 }], ['atr', { length: 14 }],
  ['stoch', { k: 14, smooth: 3, d: 3 }], ['stoch', { k: 5, smooth: 1, d: 1 }], ['vwap', {}],
  ['highest', { length: 20 }], ['lowest', { length: 7 }], ['change', { length: 3 }],
];

describe('indicator warm-up', () => {
  for (const [id, params] of CASES) {
    it(`${id} ${JSON.stringify(params)} matches the implementation`, () => {
      expect(indicatorWarmup({ indicatorId: id, params })!.bars).toBe(measured(id, params));
    });
  }

  it('labels with the block parameters (signal-only levels left out)', () => {
    expect(indicatorWarmup({ indicatorId: 'sma', params: { length: 30 } })!.label).toBe('SMA 30');
    expect(indicatorWarmup({ indicatorId: 'rsi', params: { length: 14, overbought: 70, oversold: 30 } })!.label).toBe('RSI 14');
    expect(indicatorWarmup({ indicatorId: 'macd', params: { fast: 12, slow: 26, signal: 9 } })!.label).toBe('MACD 12 26 9');
  });

  it('knows no warm-up for zone indicators, Pine scripts or unknown ids (no guessing)', () => {
    expect(indicatorWarmup({ indicatorId: 'orderblock', params: { swing: 5 } })).toBeNull();
    expect(indicatorWarmup({ indicatorId: 'pine_abc', params: {} })).toBeNull();
  });

  it('picks the largest', () => {
    expect(maxWarmup([{ indicatorId: 'sma', params: { length: 10 } }, { indicatorId: 'sma', params: { length: 30 } }, { indicatorId: 'fvg', params: {} }]))
      .toEqual({ label: 'SMA 30', bars: 30 });
    expect(maxWarmup([])).toBeNull();
  });
});
