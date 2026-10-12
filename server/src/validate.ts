import { CompileError } from '../../src/blocks/compiler';
import { isTimeframe, timeframeToMs } from '../../src/data/types';
import type { BrokerConfig } from '../../src/engine/types';
import { StrategyError } from '../../src/engine/strategy';
import { MAX_WARMUP_BARS, snapshotToSpec, type NewSessionInput, type StrategySnapshot } from '../../src/live/session';
import { isPineId, parsePineRetired, syncPineIndicators } from '../../src/pine/library';
import { buildStrategy } from '../../src/worker/protocol';

/** Same bar budget as the browser's backtests / replays (src/ui/settings.ts MAX_BARS). */
export const MAX_REPLAY_BARS = 100_000;
const MAX_PINE_SCRIPTS = 50;
const MAX_PINE_SOURCE = 200_000;
const MAX_WORKSPACE_JSON = 512 * 1024;
const MAX_DEPTH = 64;
/** Binance futures launched in 2019; nothing older exists. */
const EARLIEST_START = Date.UTC(2017, 0, 1);

export class ValidationError extends Error {
  constructor(message: string, readonly blockId?: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const fail = (message: string): never => {
  throw new ValidationError(message);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function onlyKeys(obj: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${what}: unknown field "${k}"`);
}

function numberIn(v: unknown, min: number, max: number, what: string, integer = false): number {
  if (!finite(v) || v < min || v > max || (integer && !Number.isInteger(v))) fail(`${what} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}`);
  return v as number;
}

/** JSON depth / plain-data check of the workspace (it came from the client; it is only compiled, never run as-is). */
function plainJson(v: unknown, depth = 0): void {
  if (depth > MAX_DEPTH) fail('strategy workspace is nested too deeply');
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || finite(v)) return;
  if (Array.isArray(v)) {
    for (const item of v) plainJson(item, depth + 1);
    return;
  }
  if (isRecord(v) && Object.getPrototypeOf(v) === Object.prototype) {
    for (const key of Object.keys(v)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') fail(`strategy workspace: forbidden key "${key}"`);
      plainJson(v[key], depth + 1);
    }
    return;
  }
  fail('strategy workspace must be plain JSON');
}

function parseBroker(raw: unknown): BrokerConfig {
  if (!isRecord(raw)) return fail('brokerConfig is required');
  onlyKeys(raw, ['initialBalance', 'leverage', 'takerFee', 'makerFee', 'slippageBps'], 'brokerConfig');
  return {
    initialBalance: numberIn(raw.initialBalance, 1, 1e12, 'initial balance'),
    leverage: numberIn(raw.leverage, 1, 125, 'leverage'),
    takerFee: numberIn(raw.takerFee, 0, 0.1, 'taker fee'),
    makerFee: numberIn(raw.makerFee, -0.01, 0.1, 'maker fee'),
    slippageBps: numberIn(raw.slippageBps, 0, 1000, 'slippage (bps)'),
  };
}

function parseStrategy(raw: unknown): StrategySnapshot {
  if (!isRecord(raw)) return fail('strategy is required');
  if (raw.kind === 'builtin-sma-cross') {
    onlyKeys(raw, ['kind', 'params'], 'strategy');
    const p = isRecord(raw.params) ? raw.params : fail('strategy.params is required');
    onlyKeys(p, ['fast', 'slow', 'sizePct'], 'strategy.params');
    return {
      kind: 'builtin-sma-cross',
      params: { fast: numberIn(p.fast, 1, 1000, 'fast SMA', true), slow: numberIn(p.slow, 1, 1000, 'slow SMA', true), sizePct: numberIn(p.sizePct, 0.01, 10_000, 'size %') },
    };
  }
  if (raw.kind === 'blocks') {
    onlyKeys(raw, ['kind', 'workspace', 'pineScripts', 'pineRetired'], 'strategy');
    if (!isRecord(raw.workspace)) fail('strategy.workspace must be an object');
    if (JSON.stringify(raw.workspace).length > MAX_WORKSPACE_JSON) fail('strategy workspace is too large');
    plainJson(raw.workspace);
    const scripts = raw.pineScripts ?? [];
    if (!Array.isArray(scripts) || scripts.length > MAX_PINE_SCRIPTS) fail(`pineScripts must be a list of at most ${MAX_PINE_SCRIPTS} scripts`);
    const pineScripts = (scripts as unknown[]).map((s, i) => {
      if (!isRecord(s)) return fail(`pineScripts[${i}] must be an object`);
      onlyKeys(s, ['id', 'source'], `pineScripts[${i}]`);
      if (!isPineId(s.id)) fail(`pineScripts[${i}].id is not a Pine script id`);
      if (typeof s.source !== 'string' || s.source.length > MAX_PINE_SOURCE) fail(`pineScripts[${i}].source must be text of at most ${MAX_PINE_SOURCE} characters`);
      return { id: s.id as string, source: s.source as string };
    });
    if (new Set(pineScripts.map((s) => s.id)).size !== pineScripts.length) fail('pineScripts ids must be unique');
    const retired = raw.pineRetired ?? [];
    if (!Array.isArray(retired) || retired.length > 1000) fail('pineRetired must be a list');
    const pineRetired = parsePineRetired(retired); // tombstones only name deleted scripts; malformed ones are dropped
    return { kind: 'blocks', workspace: structuredClone(raw.workspace), pineScripts, pineRetired };
  }
  return fail('strategy.kind must be "blocks" or "builtin-sma-cross"');
}

/**
 * A session definition from the client, re-validated field by field and its strategy compiled here (in the vm
 * sandbox, like the workers do): a workspace that does not compile is refused with the same message and block id
 * the browser would show. `nowMs` bounds the start and the replay length.
 */
export function parseNewSession(body: unknown, nowMs: number): NewSessionInput {
  if (!isRecord(body)) return fail('expected a JSON object');
  onlyKeys(body, ['name', 'symbol', 'timeframe', 'startMs', 'warmupBars', 'brokerConfig', 'strategy'], 'session');
  const name = body.name ?? '';
  if (typeof name !== 'string' || name.length > 80) fail('name must be text of at most 80 characters');
  const symbol = body.symbol;
  if (typeof symbol !== 'string' || !/^[A-Z0-9]{2,20}$/.test(symbol)) fail('symbol must be a Binance futures symbol such as BTCUSDT');
  const timeframe = body.timeframe;
  if (typeof timeframe !== 'string' || !isTimeframe(timeframe)) fail('timeframe is not supported');
  const tf = timeframe as NewSessionInput['timeframe'];
  const warmupBars = numberIn(body.warmupBars, 0, MAX_WARMUP_BARS, 'warm-up bars', true);
  const startMs = body.startMs === undefined || body.startMs === null ? nowMs : numberIn(body.startMs, EARLIEST_START, nowMs, 'start time (ms)');
  const bars = Math.floor((nowMs - startMs) / timeframeToMs(tf)) + warmupBars;
  if (bars > MAX_REPLAY_BARS) fail(`replay too long: ${bars} bars (max ${MAX_REPLAY_BARS}); pick a later start or a larger timeframe`);
  const brokerConfig = parseBroker(body.brokerConfig);
  const strategy = parseStrategy(body.strategy);
  checkCompiles(strategy);
  return { name: name as string, symbol: symbol as string, timeframe: tf, startMs, warmupBars, brokerConfig, strategy };
}

/** Builds the strategy once (compile + instantiate) so a broken one is refused before a worker starts. */
function checkCompiles(strategy: StrategySnapshot): void {
  try {
    buildStrategy(snapshotToSpec(strategy));
  } catch (err) {
    const blockId = err instanceof StrategyError || err instanceof CompileError ? err.blockId : undefined;
    throw new ValidationError(`strategy cannot start: ${err instanceof Error ? err.message : String(err)}`, blockId);
  } finally {
    syncPineIndicators([]);
  }
}
