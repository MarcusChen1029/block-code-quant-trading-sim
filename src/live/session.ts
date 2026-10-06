import { isTimeframe, timeframeToMs, type Timeframe } from '../data/types';
import { DEFAULT_SMA_CROSS, type SmaCrossParams } from '../engine/strategies/smaCross';
import type { BrokerConfig } from '../engine/types';
import { parsePineRecords, parsePineRetired, type PineRetired, type PineSourceRecord } from '../pine/library';
import type { StrategySpec } from '../worker/protocol';

/**
 * What a live session runs, frozen when it starts: later edits to the blocks or Pine scripts never reach it.
 * Block strategies carry their own copy of the workspace JSON and of every Pine source (+ retired ids).
 */
export type StrategySnapshot =
  | { kind: 'blocks'; workspace: unknown; pineScripts: PineSourceRecord[]; pineRetired: PineRetired[] }
  | { kind: 'builtin-sma-cross'; params: SmaCrossParams };

export type SessionStatus = 'running' | 'stopped';

/**
 * A live paper-trading session. The DEFINITION (id .. createdAt) is immutable; the session's state (trades,
 * fills, equity, log, stats) is a pure function of it plus the closed candles from `startTime - warmupBars`
 * on, so only this record is persisted and reopening replays the candles.
 */
export interface LiveSessionDef {
  id: string;
  name: string;
  symbol: string;
  timeframe: Timeframe;
  /** Open time (ms) of the session's first trading bar; always aligned to the timeframe. */
  startTime: number;
  /** Closed bars before startTime fed with orders suppressed, so indicators are warm at the start. */
  warmupBars: number;
  brokerConfig: BrokerConfig;
  strategy: StrategySnapshot;
  createdAt: number;
}

/** Display cache for the session list; derived, never used to rebuild state. */
export interface SessionSummary {
  equity: number;
  returnPct: number;
  tradeCount: number;
  /** Bars processed, warm-up included. */
  bars: number;
}

/** What is stored: the definition plus its lifecycle. */
export interface LiveSessionRecord extends LiveSessionDef {
  status: SessionStatus;
  stoppedAt?: number;
  /**
   * Open time of the last processed bar. For a stopped session it bounds replays, so a stopped session always
   * shows exactly what it processed. null = nothing processed yet.
   */
  lastBarTime: number | null;
  /** Why it stopped, when not by the user. */
  stopReason?: 'error' | 'wiped';
  error?: { message: string; blockId?: string };
  summary?: SessionSummary;
}

export const DEFAULT_WARMUP_BARS = 200;
export const MAX_WARMUP_BARS = 5000;

/** Open time of the bar containing `ms`. */
export function alignToBar(ms: number, tf: Timeframe): number {
  const step = timeframeToMs(tf);
  return Math.floor(ms / step) * step;
}

/** Open time of the first warm-up bar. */
export function warmupStart(def: Pick<LiveSessionDef, 'startTime' | 'warmupBars' | 'timeframe'>): number {
  return def.startTime - def.warmupBars * timeframeToMs(def.timeframe);
}

/** Deep copy through JSON: a snapshot shares nothing with the editor's live objects. */
function frozenCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function blocksSnapshot(workspace: unknown, pineScripts: readonly PineSourceRecord[], pineRetired: readonly PineRetired[]): StrategySnapshot {
  return { kind: 'blocks', workspace: frozenCopy(workspace), pineScripts: frozenCopy([...pineScripts]), pineRetired: frozenCopy([...pineRetired]) };
}

export function smaCrossSnapshot(params: SmaCrossParams = DEFAULT_SMA_CROSS): StrategySnapshot {
  return { kind: 'builtin-sma-cross', params: { ...params } };
}

/** The worker's strategy spec for a snapshot. */
export function snapshotToSpec(snapshot: StrategySnapshot): StrategySpec {
  return snapshot.kind === 'blocks'
    ? { id: 'blocks', workspace: snapshot.workspace, pineScripts: snapshot.pineScripts, pineRetired: snapshot.pineRetired }
    : { id: 'smaCross', params: snapshot.params };
}

export interface NewSessionInput {
  name: string;
  symbol: string;
  timeframe: Timeframe;
  /** Any time inside the first trading bar (now, or a past moment to replay from). */
  startMs: number;
  warmupBars: number;
  brokerConfig: BrokerConfig;
  strategy: StrategySnapshot;
}

export function newSessionRecord(input: NewSessionInput, nowMs: number, id = randomId()): LiveSessionRecord {
  const startTime = alignToBar(Math.min(input.startMs, nowMs), input.timeframe);
  return {
    id,
    name: input.name.trim().slice(0, 80) || `${input.symbol} ${input.timeframe} ${new Date(startTime).toISOString().slice(0, 16).replace('T', ' ')}`,
    symbol: input.symbol,
    timeframe: input.timeframe,
    startTime,
    warmupBars: Math.max(0, Math.min(MAX_WARMUP_BARS, Math.floor(input.warmupBars))),
    brokerConfig: { ...input.brokerConfig },
    strategy: frozenCopy(input.strategy),
    createdAt: nowMs,
    status: 'running',
    lastBarTime: null,
  };
}

function randomId(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function parseBroker(raw: unknown): BrokerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Record<string, unknown>;
  const { initialBalance, leverage, takerFee, makerFee, slippageBps } = b;
  if (!finite(initialBalance) || !finite(leverage) || !finite(takerFee) || !finite(makerFee) || !finite(slippageBps)) return null;
  if (initialBalance <= 0 || leverage < 1) return null;
  return { initialBalance, leverage, takerFee, makerFee, slippageBps };
}

function parseSnapshot(raw: unknown): StrategySnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (s.kind === 'blocks') {
    return { kind: 'blocks', workspace: s.workspace, pineScripts: parsePineRecords(s.pineScripts), pineRetired: parsePineRetired(s.pineRetired) };
  }
  if (s.kind === 'builtin-sma-cross') {
    const p = (s.params ?? {}) as Record<string, unknown>;
    if (!finite(p.fast) || !finite(p.slow) || !finite(p.sizePct)) return null;
    return { kind: 'builtin-sma-cross', params: { fast: p.fast, slow: p.slow, sizePct: p.sizePct } };
  }
  return null;
}

/** A record from untrusted storage, or null when it is malformed. */
export function parseSessionRecord(raw: unknown): LiveSessionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || r.id === '' || typeof r.name !== 'string' || typeof r.symbol !== 'string') return null;
  if (typeof r.timeframe !== 'string' || !isTimeframe(r.timeframe)) return null;
  if (!finite(r.startTime) || !finite(r.warmupBars) || !finite(r.createdAt)) return null;
  if (r.startTime % timeframeToMs(r.timeframe) !== 0 || r.warmupBars < 0 || r.warmupBars > MAX_WARMUP_BARS) return null;
  if (r.status !== 'running' && r.status !== 'stopped') return null;
  const brokerConfig = parseBroker(r.brokerConfig);
  const strategy = parseSnapshot(r.strategy);
  if (!brokerConfig || !strategy) return null;
  const record: LiveSessionRecord = {
    id: r.id,
    name: r.name,
    symbol: r.symbol,
    timeframe: r.timeframe,
    startTime: r.startTime,
    warmupBars: r.warmupBars,
    brokerConfig,
    strategy,
    createdAt: r.createdAt,
    status: r.status,
    lastBarTime: finite(r.lastBarTime) ? r.lastBarTime : null,
  };
  if (finite(r.stoppedAt)) record.stoppedAt = r.stoppedAt;
  if (r.stopReason === 'error' || r.stopReason === 'wiped') record.stopReason = r.stopReason;
  if (r.error && typeof r.error === 'object' && typeof (r.error as { message?: unknown }).message === 'string') {
    const e = r.error as { message: string; blockId?: unknown };
    record.error = typeof e.blockId === 'string' ? { message: e.message, blockId: e.blockId } : { message: e.message };
  }
  if (r.summary && typeof r.summary === 'object') {
    const s = r.summary as Record<string, unknown>;
    if (finite(s.equity) && finite(s.returnPct) && finite(s.tradeCount) && finite(s.bars)) {
      record.summary = { equity: s.equity, returnPct: s.returnPct, tradeCount: s.tradeCount, bars: s.bars };
    }
  }
  return record;
}

/**
 * What to store when `incoming` is written over `existing` (two tabs may hold copies of one session):
 * - 'stopped' is final: once stored, a 'running' copy can never bring the session back, and its replay bound
 *   (lastBarTime) and stop details never change;
 * - a stop written over 'running' wins, with the stopping tab's lastBarTime;
 * - between two running copies the later lastBarTime (and its summary) wins: progress never moves back.
 */
export function mergeRecords(existing: LiveSessionRecord | null, incoming: LiveSessionRecord): LiveSessionRecord {
  if (existing === null) return incoming;
  if (existing.status === 'stopped') return existing;
  if (incoming.status === 'stopped') return incoming;
  const later = (incoming.lastBarTime ?? -Infinity) >= (existing.lastBarTime ?? -Infinity) ? incoming : existing;
  const merged: LiveSessionRecord = { ...incoming, lastBarTime: later.lastBarTime };
  if (later.summary) merged.summary = later.summary;
  return merged;
}
