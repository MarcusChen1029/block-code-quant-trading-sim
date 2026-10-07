import type { IndicatorUse } from '../blocks/generator';
import { blockParams, getIndicator } from '../blocks/registry';

/** How many bars an indicator needs before all its numeric outputs have a value. */
export interface Warmup {
  /** e.g. "SMA 30", "MACD 12 26 9". */
  label: string;
  bars: number;
}

/**
 * Bars needed by the built-in indicators (TradingView formulas in src/indicators), keyed by registry id. Each
 * number is "first bar index with every numeric output defined + 1"; warmup.test.ts checks every one against the
 * real implementation. Zone indicators and Pine scripts have no fixed warm-up and are left out (no guess).
 */
const BARS: Record<string, (p: Record<string, number>) => number> = {
  sma: (p) => p.length,
  ema: (p) => p.length,
  wma: (p) => p.length,
  rma: (p) => p.length,
  rsi: (p) => p.length + 1,
  macd: (p) => Math.max(p.fast, p.slow) + p.signal - 1,
  bb: (p) => p.length,
  supertrend: (p) => p.length,
  atr: (p) => p.length,
  stoch: (p) => p.k + p.smooth + p.d - 2,
  vwap: () => 1,
  highest: (p) => p.length,
  lowest: (p) => p.length,
  change: (p) => p.length + 1,
};

/** Warm-up of one indicator use, or null when it is not a built-in with a known formula. */
export function indicatorWarmup(use: Pick<IndicatorUse, 'indicatorId' | 'params'>): Warmup | null {
  const bars = BARS[use.indicatorId];
  const def = getIndicator(use.indicatorId);
  if (!bars || !def) return null;
  const n = bars(use.params);
  if (!Number.isFinite(n) || n < 1) return null;
  const shown = blockParams(def, 'ind').map((p) => use.params[p.name]).filter((v) => v !== undefined);
  return { label: [def.label, ...shown.map(String)].join(' '), bars: n };
}

/** The indicator that needs the most bars (first one on ties), or null when none is known. */
export function maxWarmup(uses: ReadonlyArray<Pick<IndicatorUse, 'indicatorId' | 'params'>>): Warmup | null {
  let best: Warmup | null = null;
  for (const use of uses) {
    const w = indicatorWarmup(use);
    if (w && (!best || w.bars > best.bars)) best = w;
  }
  return best;
}
