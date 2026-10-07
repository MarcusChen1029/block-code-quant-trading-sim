import type { IndicatorUse } from '../blocks/generator';
import { BT } from '../blocks/blockTypes';
import { blockParams, getIndicator, INDICATOR_BLOCK_PREFIX, paramFieldName, SIGNAL_BLOCK_PREFIX } from '../blocks/registry';
import { connected, isEnabled, type BlockState, type WorkspaceState } from '../blocks/workspaceState';

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

/** Bars a strategy needs loaded before its first order can fill, or unknown (then no number is shown). */
export type HistoryNeed = { known: true; label: string; bars: number } | { known: false };

/** Bars until a value exists (first defined bar index + 1) and what to call it. null = cannot be determined. */
type Need = { bars: number; label: string } | null;

/** Value blocks that need no history at all (constants, account state, product / timeframe / bar time). */
const NO_HISTORY = new Set(['math_number', 'text', 'logic_boolean', 'logic_null', BT.product, BT.timeframe, BT.barTime]);
/** Blocks whose value depends on things this analysis cannot follow: no number is claimed. */
const UNKNOWN = new Set(['variables_get', 'procedures_callreturn', 'procedures_callnoreturn', BT.barIndex]);
/** Prefixes of blocks that only combine their inputs (logic, math, control flow, actions, hats, setters). */
const PASS_THROUGH = ['logic_', 'math_', 'controls_', 'text_', 'action_', 'event_', 'account_', 'variables_set', 'procedures_def'];

const larger = (a: Need, b: Need): Need => (a === null || b === null ? null : b.bars > a.bars ? b : a);

/**
 * Conservative history requirement of a block (and everything below it), following source chains: an indicator
 * fed by another computed series needs both warm-ups (SMA 20 of RSI 14 = 15 + 20 - 1 bars); `n bars ago` adds n;
 * crossings and signal blocks add one bar (they compare with the previous value). Unknown -> null.
 */
function need(block: BlockState | undefined): Need {
  if (!block || !isEnabled(block)) return { bars: 0, label: '' };
  const f = block.fields ?? {};
  const type = block.type;
  let own: Need;
  if (UNKNOWN.has(type)) return null;
  if (NO_HISTORY.has(type)) own = { bars: 0, label: '' };
  else if (type === BT.price || type === BT.volume) {
    const offset = Number(f.OFFSET ?? 0);
    if (!Number.isInteger(offset) || offset < 0) return null;
    const field = type === BT.volume ? 'volume' : String(f.FIELD ?? 'close');
    own = { bars: offset + 1, label: offset > 0 ? `${field} ${offset} bars ago` : field };
  } else if (type === BT.currentPrice) own = { bars: 1, label: 'price' };
  else if (type.startsWith(INDICATOR_BLOCK_PREFIX) || type.startsWith(SIGNAL_BLOCK_PREFIX)) {
    const signal = type.startsWith(SIGNAL_BLOCK_PREFIX);
    const id = type.slice(signal ? SIGNAL_BLOCK_PREFIX.length : INDICATOR_BLOCK_PREFIX.length);
    const def = getIndicator(id);
    const formula = BARS[id];
    if (!def || !formula) return null;
    const params: Record<string, number> = {};
    for (const p of def.params) params[p.name] = Number(f[paramFieldName(p)] ?? p.default);
    const bars = formula(params);
    if (!Number.isFinite(bars) || bars < 1) return null;
    const label = [def.label, ...blockParams(def, 'ind').map((p) => String(params[p.name]))].join(' ');
    let src: Need = { bars: 1, label: '' }; // reads plain bar values
    if (def.source) {
      const input = connected(block.inputs?.SOURCE);
      src = need(input);
      if (src === null) return null;
    }
    const plainSource = !def.source || connected(block.inputs?.SOURCE)?.type === BT.price && Number(connected(block.inputs?.SOURCE)?.fields?.OFFSET ?? 0) === 0;
    own = { bars: Math.max(src.bars, 1) + bars - 1 + (signal ? 1 : 0), label: plainSource || !src.label ? label : `${label} of ${src.label}` };
    return combineRest(block, own, ['SOURCE']);
  } else if (type === BT.crosses) {
    const ab = larger(need(connected(block.inputs?.A)), need(connected(block.inputs?.B)));
    if (ab === null) return null;
    own = { bars: ab.bars + 1, label: ab.label };
    return combineRest(block, own, ['A', 'B']);
  } else if (PASS_THROUGH.some((p) => type.startsWith(p)) || type === 'text') own = { bars: 0, label: '' };
  else return null; // a block this analysis does not know
  return combineRest(block, own, []);
}

/** `own` combined with every other input and the next block in the chain (statements). */
function combineRest(block: BlockState, own: Need, skip: string[]): Need {
  let best = own;
  for (const [name, conn] of Object.entries(block.inputs ?? {})) {
    if (skip.includes(name)) continue;
    best = larger(best, need(connected(conn)));
    if (best === null) return null;
  }
  return block.next ? larger(best, need(connected(block.next))) : best;
}

/**
 * Bars that must be loaded before the strategy's first order can fill: the slowest value it reads (following
 * source chains and `bars ago`) + 1 for the next-bar fill. Unknown (no number) when it uses blocks whose history
 * cannot be determined (zones, Pine scripts, variables used as data, bar index, functions): never a number that is
 * too low.
 */
export function strategyHistoryNeed(workspace: unknown): HistoryNeed {
  const blocks = (workspace as WorkspaceState | null)?.blocks?.blocks;
  if (!Array.isArray(blocks)) return { known: false };
  let best: Need = { bars: 0, label: '' };
  for (const block of blocks) {
    best = larger(best, need(block));
    if (best === null) return { known: false };
  }
  return { known: true, bars: Math.max(best.bars, 1) + 1, label: best.label || 'the strategy' };
}

/** The built-in SMA cross (not blocks): a cross of SMA `slow` -> slow + 1 bars for the value, + 1 to fill. */
export function smaCrossHistoryNeed(slow: number): HistoryNeed {
  return { known: true, bars: slow + 2, label: `SMA ${slow}` };
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
