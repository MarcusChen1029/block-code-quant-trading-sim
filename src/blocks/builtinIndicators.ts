import { Ema, Rma, Sma, Wma } from '../indicators/averages';
import { BollingerBands } from '../indicators/bands';
import { Highest, Lowest } from '../indicators/extremes';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Change } from '../indicators/primitives';
import type { SeriesIndicator } from '../indicators/types';
import { Atr } from '../indicators/volatility';
import { Vwap } from '../indicators/vwap';
import type { IndicatorBlockDef, IndicatorParam } from './registry';

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

/** Built-in indicators (TradingView formulas, see src/indicators). */
export const BUILTIN_INDICATORS: IndicatorBlockDef[] = [
  series('sma', 'SMA', 'Simple moving average (ta.sma).', 'price', 20, (n) => new Sma(n)),
  series('ema', 'EMA', 'Exponential moving average, seeded with an SMA (ta.ema).', 'price', 20, (n) => new Ema(n)),
  series('wma', 'WMA', 'Linearly weighted moving average (ta.wma).', 'price', 20, (n) => new Wma(n)),
  series('rma', 'RMA', "Wilder's moving average (ta.rma).", 'price', 14, (n) => new Rma(n)),
  series('rsi', 'RSI', 'Relative strength index, 0-100 (ta.rsi).', 'sub', 14, (n) => new Rsi(n)),
  {
    id: 'macd', label: 'MACD', tooltip: 'MACD line, signal line or histogram (ta.macd).', pane: 'sub', source: 'close',
    params: [
      { name: 'fast', label: 'fast', default: 12, min: 1, max: 5000, integer: true },
      { name: 'slow', label: 'slow', default: 26, min: 1, max: 5000, integer: true },
      { name: 'signal', label: 'signal', default: 9, min: 1, max: 5000, integer: true },
    ],
    outputs: [{ key: 'macd', label: 'line' }, { key: 'signal', label: 'signal' }, { key: 'hist', label: 'histogram' }],
    create(p) {
      const macd = new Macd(p.fast, p.slow, p.signal);
      return { step: (src) => ({ ...macd.update(src) }) };
    },
  },
  {
    id: 'bb', label: 'Bollinger', tooltip: 'Bollinger Bands: SMA ± mult × stdev (ta.bb).', pane: 'price', source: 'close',
    params: [length(20), { name: 'mult', label: 'mult', default: 2, min: 0.001, max: 100 }],
    outputs: [{ key: 'upper', label: 'upper' }, { key: 'middle', label: 'middle' }, { key: 'lower', label: 'lower' }],
    create(p) {
      const bb = new BollingerBands(p.length, p.mult);
      return { step: (src) => ({ ...bb.update(src) }) };
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
    create(p) {
      const st = new Stochastic(p.k, p.smooth, p.d);
      return { step: (_src, candle) => ({ ...st.update(candle) }) };
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
