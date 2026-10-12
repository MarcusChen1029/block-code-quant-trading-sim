import type { Trade } from '../engine/types';
import { parsePineRecords, type PineSourceRecord } from '../pine/library';

/** One CSV field: quoted when it holds a comma, quote or line break (RFC 4180). */
function csvField(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The trade list as CSV (times in UTC ISO format), for a spreadsheet. */
export function tradesToCsv(trades: readonly Trade[]): string {
  const header = ['#', 'side', 'entry_time_utc', 'entry_price', 'exit_time_utc', 'exit_price', 'qty', 'net_pnl', 'exit_by'];
  const rows = trades.map((t, i) => [
    i + 1, t.side, new Date(t.entryTime).toISOString(), t.entryPrice, new Date(t.exitTime).toISOString(), t.exitPrice, t.qty, t.netPnl, t.exitReason,
  ]);
  return [header, ...rows].map((r) => r.map(csvField).join(',')).join('\r\n') + '\r\n';
}

export const STRATEGY_FILE_KIND = 'quant-sim/strategy';
export const STRATEGY_FILE_VERSION = 1;
/** Bigger files are refused before parsing (a workspace is a few kB; Pine scripts are capped at 200 kB each). */
export const MAX_STRATEGY_FILE_BYTES = 5_000_000;

export interface StrategyFile {
  kind: typeof STRATEGY_FILE_KIND;
  version: number;
  savedAt: string;
  /** Blockly workspace JSON. */
  workspace: unknown;
  /** The saved Pine scripts the blocks may use. */
  pineScripts: PineSourceRecord[];
}

export function buildStrategyFile(workspace: unknown, pineScripts: readonly PineSourceRecord[], now: number): StrategyFile {
  return { kind: STRATEGY_FILE_KIND, version: STRATEGY_FILE_VERSION, savedAt: new Date(now).toISOString(), workspace, pineScripts: [...pineScripts] };
}

export type ParsedStrategy = { ok: true; file: StrategyFile } | { ok: false; error: string };

/** Reads an exported strategy file; explains in plain words what is wrong with anything else. */
export function parseStrategyFile(text: string): ParsedStrategy {
  if (text.length > MAX_STRATEGY_FILE_BYTES) return { ok: false, error: 'That file is too big to be a Quant Sim strategy.' };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not a Quant Sim strategy (it is not valid JSON).' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'That file is not a Quant Sim strategy.' };
  const r = raw as Record<string, unknown>;
  if (r.kind !== STRATEGY_FILE_KIND) return { ok: false, error: 'That file is not a Quant Sim strategy (use one made with “Export strategy”).' };
  if (typeof r.version !== 'number' || r.version > STRATEGY_FILE_VERSION) {
    return { ok: false, error: 'That strategy was made by a newer version of Quant Sim. Reload the page to update, then try again.' };
  }
  const ws = r.workspace;
  if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) return { ok: false, error: 'That strategy file has no blocks in it.' };
  return {
    ok: true,
    file: {
      kind: STRATEGY_FILE_KIND,
      version: r.version,
      savedAt: typeof r.savedAt === 'string' ? r.savedAt : '',
      workspace: ws,
      pineScripts: parsePineRecords(r.pineScripts),
    },
  };
}

/** Pine scripts from an imported file that this browser does not have yet (same id = same script, kept as is). */
export function newPineScripts(existing: readonly PineSourceRecord[], incoming: readonly PineSourceRecord[]): PineSourceRecord[] {
  const have = new Set(existing.map((r) => r.id));
  return incoming.filter((r) => !have.has(r.id));
}

/** "quant-sim-strategy-2026-10-12.json" */
export function datedFileName(prefix: string, ext: string, now: number): string {
  return `${prefix}-${new Date(now).toISOString().slice(0, 10)}.${ext}`;
}

/** Hands the browser a file to save. */
export function downloadFile(name: string, content: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
