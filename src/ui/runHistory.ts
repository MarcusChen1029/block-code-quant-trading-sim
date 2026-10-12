/** One finished backtest, as remembered in the Results › History tab. */
export interface RunRecord {
  /** When it ran (ms). */
  at: number;
  /** "Your blocks" or "Built-in SMA cross". */
  strategy: string;
  symbol: string;
  timeframe: string;
  /** YYYY-MM-DD the test started from. */
  startDate: string;
  returnPct: number;
  /** Buy & hold over the same candles; null when there was none. */
  benchReturnPct: number | null;
  maxDrawdownPct: number;
  trades: number;
  wiped: boolean;
}

export const RUN_HISTORY_STORAGE_KEY = 'quant-sim.run-history.v1';
export const MAX_RUNS = 20;

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, max = 80): v is string => typeof v === 'string' && v.length <= max;

/** Saved history from storage; malformed entries are dropped, newest first, at most MAX_RUNS. */
export function parseRunHistory(raw: unknown): RunRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: RunRecord[] = [];
  for (const r of raw) {
    if (typeof r !== 'object' || r === null) continue;
    const o = r as Record<string, unknown>;
    if (!isNum(o.at) || !isStr(o.strategy) || !isStr(o.symbol, 20) || !isStr(o.timeframe, 8) || !isStr(o.startDate, 10)) continue;
    if (!isNum(o.returnPct) || !isNum(o.maxDrawdownPct) || !isNum(o.trades) || typeof o.wiped !== 'boolean') continue;
    if (o.benchReturnPct !== null && !isNum(o.benchReturnPct)) continue;
    out.push({
      at: o.at, strategy: o.strategy, symbol: o.symbol, timeframe: o.timeframe, startDate: o.startDate, returnPct: o.returnPct,
      benchReturnPct: o.benchReturnPct as number | null, maxDrawdownPct: o.maxDrawdownPct, trades: o.trades, wiped: o.wiped,
    });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, MAX_RUNS);
}

/** The history with `run` added at the front (the oldest falls off past MAX_RUNS). */
export function addRun(history: readonly RunRecord[], run: RunRecord): RunRecord[] {
  return [run, ...history].slice(0, MAX_RUNS);
}

/** Index of the run with the best return (the first one on a tie), or -1 when there are fewer than two runs. */
export function bestRunIndex(history: readonly RunRecord[]): number {
  if (history.length < 2) return -1;
  let best = 0;
  for (let i = 1; i < history.length; i++) if (history[i].returnPct > history[best].returnPct) best = i;
  return best;
}
