import type { Candle } from '../data/types';
import { buyAndHold, type Benchmark } from '../engine/benchmark';
import type { EngineActivity } from '../engine/engine';
import type { Stats } from '../engine/stats';
import type { BrokerConfig, PositionView } from '../engine/types';
import type { LiveStatus } from '../live/runner';
import type { LiveSessionRecord } from '../live/session';
import { fmtNum, fmtPct, fmtTime } from './format';
import { buildVerdict, type Verdict } from './verdict';

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

/** What the page knows about a live session (from its deltas), for the verdict. */
export interface LiveVerdictInput {
  startTime: number;
  broker: BrokerConfig;
  /** Closed candles processed so far, warm-up included, ascending. */
  candles: readonly Candle[];
  tradeCount: number;
  fillCount: number;
  /** Equity points = trading bars processed. */
  equityPoints: number;
  stats: Stats | null;
  wiped: boolean;
  position: PositionView | null;
  activity: EngineActivity | null;
}

/** First index of `candles` (ascending) with time >= `time`. */
function firstAtOrAfter(candles: readonly Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The backtest's verdict + buy & hold, for a live session so far. Buy & hold covers the session's TRADING bars
 * (from its start, after warm-up) and is entered at the first one a strategy could fill at, the next bar's open:
 * exactly the backtest convention, via the shared buyAndHold. Pure.
 */
export function liveVerdict(input: LiveVerdictInput): { verdict: Verdict; benchmark: Benchmark | null } {
  const trading = input.candles.slice(firstAtOrAfter(input.candles, input.startTime));
  if (input.stats === null || trading.length < 2) {
    const warming = trading.length === 0;
    return {
      benchmark: null,
      verdict: {
        tone: 'neutral',
        text: warming
          ? `Warm-up: ${input.candles.length.toLocaleString('en-US')} bar${input.candles.length === 1 ? '' : 's'} processed; the verdict and buy & hold start with the first trading bars.`
          : 'Waiting for the first trading bars: the verdict and buy & hold need 2 closed bars since the session start.',
      },
    };
  }
  const benchmark = buyAndHold(trading, input.broker);
  const verdict = buildVerdict({
    tradeCount: input.tradeCount,
    openPosition: input.position !== null && input.position.side !== 'flat',
    fillCount: input.fillCount,
    totalReturnPct: input.stats.totalReturnPct,
    maxDrawdownPct: input.stats.maxDrawdownPct,
    wiped: input.wiped,
    barsProcessed: input.equityPoints,
    barsLoaded: trading.length,
    benchmark: benchmark ? { returnPct: benchmark.returnPct, maxDrawdownPct: benchmark.maxDrawdownPct } : null,
    activity: input.activity,
    warmup: null, // live sessions warm up on their own bars before the start
  });
  return { verdict, benchmark };
}
