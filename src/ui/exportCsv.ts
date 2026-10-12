import type { Trade } from '../engine/types';

/** One CSV cell: quoted when it holds a comma, quote or line break; quotes doubled. Spreadsheet formulas are defused. */
export function csvCell(value: string | number): string {
  let text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value;
  // A cell starting with = + - @ would run as a formula when opened in a spreadsheet (a plain negative number is safe).
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const iso = (ms: number) => new Date(ms).toISOString();

export const TRADE_CSV_HEADER = ['trade', 'side', 'entry_time_utc', 'entry_price', 'exit_time_utc', 'exit_price', 'quantity', 'net_pnl', 'exit_reason'] as const;

/** The trade list as CSV text (header + one row per trade, newest last), ready to open in a spreadsheet. */
export function tradesToCsv(trades: readonly Trade[]): string {
  const rows = trades.map((t, i) =>
    [i + 1, t.side, iso(t.entryTime), t.entryPrice, iso(t.exitTime), t.exitPrice, t.qty, t.netPnl, t.exitReason].map(csvCell).join(','));
  return [TRADE_CSV_HEADER.join(','), ...rows].join('\r\n') + '\r\n';
}

/** A file name that is safe on every system: `quant-sim-trades-BTCUSDT-1h.csv`. */
export function exportFileName(kind: string, parts: readonly string[], extension: string): string {
  const clean = [kind, ...parts].map((p) => p.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')).filter((p) => p !== '');
  return `quant-sim-${clean.join('-')}.${extension}`;
}
