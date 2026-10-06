import type { LiveStatus } from '../live/runner';
import type { LiveSessionRecord } from '../live/session';
import { fmtNum, fmtPct, fmtTime } from './format';

export type BadgeTone = 'live' | 'busy' | 'warn' | 'error' | 'stopped';

export interface Badge {
  text: string;
  tone: BadgeTone;
  /** Last processed bar + counter, e.g. "last bar 2026-10-06 10:41 UTC · 260 bars". */
  detail: string;
}

/** The LIVE badge for the session on screen. `replay` = a stopped session being rebuilt for viewing. */
export function liveBadge(status: LiveStatus, replay: boolean): Badge {
  const detail = status.lastBarTime === null
    ? `no bar processed yet · ${status.barsProcessed} bars`
    : `last bar ${fmtTime(status.lastBarTime)} UTC · ${status.barsProcessed} bars`;
  if (replay) {
    return status.state === 'stopped'
      ? { text: 'STOPPED · read-only', tone: 'stopped', detail }
      : status.state === 'rate-limited'
        ? { text: `RATE LIMITED · retry in ${Math.round((status.retryInMs ?? 0) / 1000)}s`, tone: 'warn', detail }
        : status.state === 'error'
        ? { text: `DATA ERROR · retry in ${Math.round((status.retryInMs ?? 0) / 1000)}s: ${status.message ?? ''}`, tone: 'error', detail }
        : { text: `REPLAYING · ${status.behindBars} bars to go`, tone: 'busy', detail };
  }
  switch (status.state) {
    case 'connecting':
      return { text: 'CONNECTING…', tone: 'busy', detail };
    case 'catching-up':
      return { text: `CATCHING UP · ${status.behindBars} bar${status.behindBars === 1 ? '' : 's'}`, tone: 'busy', detail };
    case 'live':
      return { text: '● LIVE', tone: 'live', detail };
    case 'reconnecting':
      return { text: 'RECONNECTING…', tone: 'warn', detail };
    case 'rate-limited':
      return { text: `RATE LIMITED · retry in ${Math.round((status.retryInMs ?? 0) / 1000)}s`, tone: 'warn', detail };
    case 'error':
      return { text: `DATA ERROR · retry in ${Math.round((status.retryInMs ?? 0) / 1000)}s: ${status.message ?? ''}`, tone: 'error', detail };
    case 'stopped':
      return { text: 'STOPPED', tone: 'stopped', detail };
  }
}

export interface SessionRow {
  id: string;
  name: string;
  market: string;
  status: string;
  statusTone: BadgeTone;
  returnPct: string;
  returnTone: 'pos' | 'neg' | 'neutral';
  equity: string;
  lastBar: string;
  running: boolean;
}

/** `elsewhere`: the session is running in another tab. */
export function sessionRow(r: LiveSessionRecord, elsewhere = false): SessionRow {
  const s = r.summary;
  const status = r.status === 'running' ? (elsewhere ? 'running · other tab' : 'running') : r.stopReason === 'error' ? 'stopped: error' : r.stopReason === 'wiped' ? 'stopped: wiped' : 'stopped';
  return {
    id: r.id,
    name: r.name,
    market: `${r.symbol} ${r.timeframe}`,
    status,
    statusTone: r.status === 'running' ? 'live' : r.stopReason ? 'error' : 'stopped',
    returnPct: s ? fmtPct(s.returnPct) : '—',
    returnTone: !s || s.returnPct === 0 ? 'neutral' : s.returnPct > 0 ? 'pos' : 'neg',
    equity: s ? fmtNum(s.equity) : '—',
    lastBar: r.lastBarTime === null ? '—' : fmtTime(r.lastBarTime),
    running: r.status === 'running',
  };
}

/** "YYYY-MM-DDTHH:mm" from a datetime-local input, read as UTC. NaN when malformed. */
export function parseUtcDateTime(value: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? Date.parse(`${value}:00Z`) : NaN;
}

/** The datetime-local value (UTC) for `ms`. */
export function toUtcDateTimeValue(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}
