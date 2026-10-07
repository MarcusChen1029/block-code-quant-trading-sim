import { Ema, Rma, Sma, Wma } from '../indicators/averages';
import { BollingerBands } from '../indicators/bands';
import { Highest, Lowest } from '../indicators/extremes';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Change, CrossOver, CrossUnder } from '../indicators/primitives';
import { Supertrend } from '../indicators/supertrend';
import type { SeriesIndicator } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { Vwap } from '../indicators/vwap';
import type { IndicatorBlockDef, IndicatorParam, SignalOutput } from './registry';

const VALUE = [{ key: 'value', label: 'value' }];
const length = (def: number): IndicatorParam => ({ name: 'length', label: 'length', default: def, min: 1, max: 5000, integer: true });

/** A one-input, one-output series indicator (SMA, EMA, ...). */
function series(
  id: string,
  label: string,
  tooltip: string,
  pane: 'price' | 'sub',
  defaultLength: number,
  make: (length: number) => SeriesIndicator,
  source: 'close' | 'high' | 'low' = 'close',
): IndicatorBlockDef {
  return {
    id, label, tooltip, pane, source,
    params: [length(defaultLength)],
    outputs: VALUE,
    create(p) {
      const ind = make(p.length);
      return { step: (src) => ({ value: ind.update(src) }) };
    },
  };
}

const UP = { shape: 'arrowUp', location: 'belowBar', color: '#26a69a' } as const;
const DOWN = { shape: 'arrowDown', location: 'aboveBar', color: '#ef5350' } as const;
const buySignal = (key: string, label: string, text = label): SignalOutput => ({ key, label, marker: { ...UP, text } });
const sellSignal = (key: string, label: string, text = label): SignalOutput => ({ key, label, marker: { ...DOWN, text } });
const bit = (b: boolean) => (b ? 1 : 0);

/** Built-in indicators (TradingView formulas, see src/indicators). */
export const BUILTIN_INDICATORS: IndicatorBlockDef[] = [
  series('sma', 'SMA', 'Simple moving average (ta.sma).', 'price', 20, (n) => new Sma(n)),
  series('ema', 'EMA', 'Exponential moving average, seeded with an SMA (ta.ema).', 'price', 20, (n) => new Ema(n)),
  series('wma', 'WMA', 'Linearly weighted moving average (ta.wma).', 'price', 20, (n) => new Wma(n)),
  series('rma', 'RMA', "Wilder's moving average (ta.rma).", 'price', 14, (n) => new Rma(n)),
  {
    id: 'rsi', label: 'RSI', tooltip: 'Relative strength index, 0-100 (ta.rsi).', pane: 'sub', source: 'close',
    params: [
      length(14),
      { name: 'overbought', label: 'overbought', default: 70, min: 0, max: 100, signalOnly: true },
      { name: 'oversold', label: 'oversold', default: 30, min: 0, max: 100, signalOnly: true },
    ],
    outputs: VALUE,
    signals: [
      buySignal('up_oversold', 'crossed above oversold', 'RSI up'),
      sellSignal('down_overbought', 'crossed below overbought', 'RSI down'),
    ],
    create(p) {
      const rsi = new Rsi(p.length);
      const [ob, os] = [p.overbought ?? 70, p.oversold ?? 30];
      const up = new CrossOver();
      const down = new CrossUnder();
      return {
        step: (src) => {
          const value = rsi.update(src);
          return { value, up_oversold: bit(up.update(value, os)), down_overbought: bit(down.update(value, ob)) };
        },
      };
    },
  },
  {
    id: 'macd', label: 'MACD', tooltip: 'MACD line, signal line or histogram (ta.macd).', pane: 'sub', source: 'close',
    params: [
      { name: 'fast', label: 'fast', default: 12, min: 1, max: 5000, integer: true },
      { name: 'slow', label: 'slow', default: 26, min: 1, max: 5000, integer: true },
      { name: 'signal', label: 'signal', default: 9, min: 1, max: 5000, integer: true },
    ],
    outputs: [{ key: 'macd', label: 'line' }, { key: 'signal', label: 'signal' }, { key: 'hist', label: 'histogram' }],
    signals: [buySignal('bull_cross', 'bullish cross (line over signal)', 'MACD up'), sellSignal('bear_cross', 'bearish cross (line under signal)', 'MACD down')],
    create(p) {
      const macd = new Macd(p.fast, p.slow, p.signal);
      const up = new CrossOver();
      const down = new CrossUnder();
      return {
        step: (src) => {
          const v = macd.update(src);
          return { ...v, bull_cross: bit(up.update(v.macd, v.signal)), bear_cross: bit(down.update(v.macd, v.signal)) };
        },
      };
    },
  },
  {
    id: 'bb', label: 'Bollinger', tooltip: 'Bollinger Bands: SMA ± mult × stdev (ta.bb).', pane: 'price', source: 'close',
    params: [length(20), { name: 'mult', label: 'mult', default: 2, min: 0.001, max: 100 }],
    outputs: [{ key: 'upper', label: 'upper' }, { key: 'middle', label: 'middle' }, { key: 'lower', label: 'lower' }],
    signals: [sellSignal('above_upper', 'close crosses above upper', 'BB upper'), buySignal('below_lower', 'close crosses below lower', 'BB lower')],
    create(p) {
      const bb = new BollingerBands(p.length, p.mult);
      const over = new CrossOver();
      const under = new CrossUnder();
      return {
        step: (src, candle) => {
          const v = bb.update(src);
          return { ...v, above_upper: bit(over.update(candle.close, v.upper)), below_lower: bit(under.update(candle.close, v.lower)) };
        },
      };
    },
  },
  {
    id: 'supertrend', label: 'Supertrend', pane: 'price', source: 'hl2',
    tooltip: 'Supertrend: ATR bands around the source (hl2) that trail price; same rules as the Pine "Supertrend" template. direction is 1 (up) or -1 (down).',
    params: [
      { name: 'length', label: 'ATR length', default: 10, min: 1, max: 5000, integer: true },
      { name: 'factor', label: 'factor', default: 3, min: 0.01, max: 100 },
    ],
    outputs: [{ key: 'line', label: 'line' }, { key: 'direction', label: 'direction' }],
    signals: [buySignal('buy', 'Buy (trend flips up)', 'Buy'), sellSignal('sell', 'Sell (trend flips down)', 'Sell')],
    create(p) {
      const st = new Supertrend(p.length, p.factor);
      return {
        step: (src, candle) => {
          const v = st.update(src, candle);
          return { line: v.line, direction: v.direction, buy: bit(v.flippedUp), sell: bit(v.flippedDown) };
        },
      };
    },
  },
  {
    id: 'atr', label: 'ATR', tooltip: 'Average true range, Wilder smoothing (ta.atr).', pane: 'sub',
    params: [length(14)],
    outputs: VALUE,
    create(p) {
      const atr = new Atr(p.length);
      return { step: (_src, candle) => ({ value: atr.update(candle) }) };
    },
  },
  {
    id: 'stoch', label: 'Stochastic', tooltip: 'Stochastic %K / %D (TradingView "Stoch").', pane: 'sub',
    params: [
      { name: 'k', label: '%K length', default: 14, min: 1, max: 5000, integer: true },
      { name: 'smooth', label: 'smooth', default: 1, min: 1, max: 5000, integer: true },
      { name: 'd', label: '%D length', default: 3, min: 1, max: 5000, integer: true },
    ],
    outputs: [{ key: 'k', label: '%K' }, { key: 'd', label: '%D' }],
    signals: [buySignal('k_over_d', '%K crosses above %D', 'Stoch up'), sellSignal('k_under_d', '%K crosses below %D', 'Stoch down')],
    create(p) {
      const st = new Stochastic(p.k, p.smooth, p.d);
      const over = new CrossOver();
      const under = new CrossUnder();
      return {
        step: (_src, candle) => {
          const v = st.update(candle);
          return { ...v, k_over_d: bit(over.update(v.k, v.d)), k_under_d: bit(under.update(v.k, v.d)) };
        },
      };
    },
  },
  {
    id: 'vwap', label: 'VWAP', tooltip: 'Volume-weighted average price of hlc3, reset each UTC day (ta.vwap).', pane: 'price',
    params: [],
    outputs: VALUE,
    create() {
      const vwap = new Vwap();
      return { step: (_src, candle) => ({ value: vwap.update(candle) }) };
    },
  },
  series('highest', 'highest', 'Highest value of the last N bars, including this one (ta.highest).', 'price', 20, (n) => new Highest(n), 'high'),
  series('lowest', 'lowest', 'Lowest value of the last N bars, including this one (ta.lowest).', 'price', 20, (n) => new Lowest(n), 'low'),
  series('change', 'change', 'Value now minus value N bars ago (ta.change).', 'sub', 1, (n) => new Change(n)),
];
