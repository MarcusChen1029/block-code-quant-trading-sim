import type { Candle } from '../data/types';
import { FairValueGaps, OrderBlocks, SwingStructure, type Zone, type ZoneBookValue } from '../indicators/zones';
import type { IndicatorBlockDef, IndicatorParam, SignalOutput } from './registry';

/**
 * Zone indicators (native TypeScript; definitions in docs/superpowers/specs/2026-10-07-zones.md). They read the bar's
 * OHLC (no SOURCE input), expose numeric outputs + true/false signals, and report zone lifecycle events for drawing.
 * Values at bar t only use bars 0..t; a swing pivot is used only from the bar that confirms it.
 */

const bit = (b: boolean) => (b ? 1 : 0);
const int = (name: string, label: string, def: number, min: number, max: number): IndicatorParam => ({ name, label, default: def, min, max, integer: true });
const maxAge = int('max_age', 'max age (bars)', 300, 1, 5000);
const maxActive = int('max_active', 'max active per side', 5, 1, 50);

const UP = { shape: 'arrowUp', location: 'belowBar', color: '#26a69a' } as const;
const DOWN = { shape: 'arrowDown', location: 'aboveBar', color: '#ef5350' } as const;
/** A signal without a marker: usable in blocks, drawn on the chart as the zone itself (not as markers). */
const quiet = (key: string, label: string): SignalOutput => ({ key, label });

/** The numeric outputs and signals shared by the order block and FVG indicators. */
function bookOutputs(noun: string): Pick<IndicatorBlockDef, 'outputs' | 'signals'> {
  return {
    outputs: [
      { key: 'bull_top', label: `nearest bullish ${noun} top` },
      { key: 'bull_bottom', label: `nearest bullish ${noun} bottom` },
      { key: 'bear_top', label: `nearest bearish ${noun} top` },
      { key: 'bear_bottom', label: `nearest bearish ${noun} bottom` },
    ],
    signals: [
      quiet('new_bull', `New bullish ${noun}`),
      quiet('new_bear', `New bearish ${noun}`),
      quiet('in_bull', `Price inside bullish ${noun}`),
      quiet('in_bear', `Price inside bearish ${noun}`),
      quiet('bull_mitigated', `Bullish ${noun} mitigated`),
      quiet('bear_mitigated', `Bearish ${noun} mitigated`),
    ],
  };
}

function bookValues(v: ZoneBookValue): Record<string, number> {
  return {
    bull_top: v.bullTop, bull_bottom: v.bullBottom, bear_top: v.bearTop, bear_bottom: v.bearBottom,
    new_bull: bit(v.newBull), new_bear: bit(v.newBear), in_bull: bit(v.inBull), in_bear: bit(v.inBear),
    bull_mitigated: bit(v.bullMitigated), bear_mitigated: bit(v.bearMitigated),
  };
}

/** An instance that keeps the zone events of its last step for the chart. */
function withZones(update: (candle: Candle) => { values: Record<string, number>; events: Zone[] }) {
  let last: Zone[] = [];
  return {
    step(_src: number, candle: Candle) {
      const r = update(candle);
      last = r.events;
      return r.values;
    },
    zones: () => last,
  };
}

export const ZONE_INDICATORS: IndicatorBlockDef[] = [
  {
    id: 'swing', label: 'Swing structure', pane: 'price', zones: { style: 'swing' },
    tooltip: 'Swing highs / lows (pivots with left / right bars) and break of structure. A pivot high is a high above the highs of the ' +
      '"left" bars before it and not below the "right" bars after it; it is only known "right" bars later (no look-ahead). ' +
      'A close above the last confirmed swing high that has not been broken yet (once per level) is an upward break: a break of ' +
      'structure (BOS) when the previous break was also up (or there was none), a change of character (CHoCH) when the previous ' +
      'break was down. Exactly one of the two fires per break; downward breaks mirrored. Outputs: last swing high / low price (na until known).',
    params: [int('left', 'left bars', 5, 1, 50), int('right', 'right bars', 5, 1, 50)],
    outputs: [{ key: 'last_high', label: 'last swing high' }, { key: 'last_low', label: 'last swing low' }],
    signals: [
      { key: 'bos_up', label: 'Break of structure up', marker: { ...UP, text: 'BOS up' } },
      { key: 'bos_down', label: 'Break of structure down', marker: { ...DOWN, text: 'BOS down' } },
      { key: 'choch_up', label: 'Change of character up', marker: { ...UP, text: 'CHoCH up' } },
      { key: 'choch_down', label: 'Change of character down', marker: { ...DOWN, text: 'CHoCH down' } },
      quiet('high_confirmed', 'Swing high confirmed'),
      quiet('low_confirmed', 'Swing low confirmed'),
    ],
    create(p) {
      const s = new SwingStructure(p.left, p.right);
      return withZones((candle) => {
        const v = s.update(candle);
        return {
          values: {
            last_high: v.lastHigh, last_low: v.lastLow, bos_up: bit(v.bosUp), bos_down: bit(v.bosDown),
            choch_up: bit(v.chochUp), choch_down: bit(v.chochDown),
            high_confirmed: bit(v.highConfirmed), low_confirmed: bit(v.lowConfirmed),
          },
          events: v.events,
        };
      });
    },
  },
  {
    id: 'orderblock', label: 'Order block', pane: 'price', zones: { style: 'orderBlock' },
    tooltip: 'Order blocks (SMC; definitions vary between traders, this is one fixed rule). Bullish: when a bar closes above the last ' +
      'confirmed swing high (a BOS or a CHoCH) (swing length = left = right bars), the LAST bearish candle (close < open) of the "lookback" bars before ' +
      'it; zone = that candle\'s low..high (body only: open..close when "body only" is 1). Bearish: mirror. Known on the break bar\'s ' +
      'close. Mitigated (removed) when a later bar closes beyond the far edge (bullish: below the bottom); also dropped after "max ' +
      'age" bars or beyond "max active" per side (oldest first). Outputs: the nearest active bullish block at or below the close, ' +
      'the nearest bearish one at or above it (na when none).',
    params: [
      int('swing', 'swing length', 5, 1, 50),
      int('lookback', 'lookback', 10, 1, 100),
      int('use_body', 'body only (1 = yes)', 0, 0, 1),
      maxAge,
      maxActive,
    ],
    ...bookOutputs('order block'),
    create(p) {
      const ob = new OrderBlocks({ swingLength: p.swing, lookback: p.lookback, useBody: p.use_body === 1, maxAgeBars: p.max_age, maxActive: p.max_active });
      return withZones((candle) => {
        const v = ob.update(candle);
        return { values: bookValues(v), events: v.events };
      });
    },
  },
  {
    id: 'fvg', label: 'Fair value gap', pane: 'price', zones: { style: 'fvg' },
    tooltip: 'Fair value gaps over 3 candles. Bullish: the high 2 bars ago is below this bar\'s low; gap = that high..this low. ' +
      'Bearish: the low 2 bars ago is above this bar\'s high. Known on this bar\'s close; gaps smaller than "min gap %" of the ' +
      'close are ignored (0 = any). Mitigated when a later bar closes through the whole gap (bullish: below its bottom); also ' +
      'dropped after "max age" bars or beyond "max active" per side. Outputs: nearest active bullish gap at or below the close, ' +
      'nearest bearish one at or above it (na when none).',
    params: [{ name: 'min_gap_pct', label: 'min gap %', default: 0.05, min: 0, max: 100 }, maxAge, maxActive],
    ...bookOutputs('FVG'),
    create(p) {
      const fvg = new FairValueGaps({ minGapPct: p.min_gap_pct, maxAgeBars: p.max_age, maxActive: p.max_active });
      return withZones((candle) => {
        const v = fvg.update(candle);
        return { values: bookValues(v), events: v.events };
      });
    },
  },
];
