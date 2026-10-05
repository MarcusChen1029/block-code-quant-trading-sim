import type { Stats } from '../engine/stats';

/** Fixed-decimals number; NaN -> em dash, ±Infinity -> ∞ / -∞. */
export function fmtNum(value: number, digits = 2): string {
  if (Number.isNaN(value)) return '—';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(value: number, digits = 2): string {
  const s = fmtNum(value, digits);
  return Number.isFinite(value) ? `${s}%` : s;
}

/** Epoch ms -> 'YYYY-MM-DD HH:mm' in UTC. */
export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export interface StatRow {
  label: string;
  value: string;
  tone: 'pos' | 'neg' | 'neutral';
}

function tone(value: number): StatRow['tone'] {
  return value > 0 ? 'pos' : value < 0 ? 'neg' : 'neutral';
}

/** The stats panel's cards, in display order. */
export function statsRows(s: Stats): StatRow[] {
  return [
    { label: 'Total return', value: fmtPct(s.totalReturnPct), tone: tone(s.totalReturnPct) },
    { label: 'Net profit', value: fmtNum(s.netProfit), tone: tone(s.netProfit) },
    { label: 'Final equity', value: fmtNum(s.finalEquity), tone: 'neutral' },
    { label: 'Max drawdown', value: fmtPct(s.maxDrawdownPct), tone: s.maxDrawdownPct > 0 ? 'neg' : 'neutral' },
    { label: 'Win rate', value: fmtPct(s.winRatePct), tone: 'neutral' },
    { label: 'Profit factor', value: fmtNum(s.profitFactor), tone: Number.isNaN(s.profitFactor) ? 'neutral' : tone(s.profitFactor - 1) },
    { label: 'Sharpe', value: fmtNum(s.sharpe), tone: Number.isNaN(s.sharpe) ? 'neutral' : tone(s.sharpe) },
    { label: 'Trades', value: String(s.tradeCount), tone: 'neutral' },
    { label: 'Exposure', value: fmtPct(s.exposurePct), tone: 'neutral' },
  ];
}
