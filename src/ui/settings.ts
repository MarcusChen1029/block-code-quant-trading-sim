import { isTimeframe, timeframeToMs, type Timeframe } from '../data/types';
import type { BrokerConfig } from '../engine/types';

/** Top-bar field values exactly as typed (strings). Fees are in percent, slippage in bps. */
export interface RawSettings {
  symbol: string;
  timeframe: string;
  startDate: string; // YYYY-MM-DD, UTC midnight
  balance: string;
  leverage: string;
  takerFeePct: string;
  makerFeePct: string;
  slippageBps: string;
}

export interface RunSettings {
  symbol: string;
  timeframe: Timeframe;
  startMs: number;
  broker: BrokerConfig;
}

/** On failure `field` names the input to fix (the UI focuses it, opening Account settings when it lives there). */
export type ParseResult = { ok: true; settings: RunSettings } | { ok: false; error: string; field: keyof RawSettings };

const ACCOUNT_FIELDS: ReadonlyArray<keyof RawSettings> = ['leverage', 'takerFeePct', 'makerFeePct', 'slippageBps'];

/** True for the fields inside the collapsible "Account settings" section. */
export function isAccountField(field: keyof RawSettings): boolean {
  return ACCOUNT_FIELDS.includes(field);
}

/** How a typed value is quoted in an error: the text as typed, or "nothing". */
const typed = (value: string) => (value.trim() === '' ? 'nothing' : value.trim());

/** Largest range a single run may load (keeps memory and Binance request count sane). */
export const MAX_BARS = 100_000;

const DAY_MS = 86_400_000;

/** UTC date `days` before now, as YYYY-MM-DD. */
export function defaultStartDate(nowMs: number, days = 90): string {
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
}

export function defaultRawSettings(nowMs: number): RawSettings {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    startDate: defaultStartDate(nowMs),
    balance: '10000',
    leverage: '1',
    takerFeePct: '0.04',
    makerFeePct: '0.02',
    slippageBps: '2',
  };
}

function num(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}

export function parseSettings(raw: RawSettings, nowMs: number): ParseResult {
  const symbol = raw.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { ok: false, field: 'symbol', error: 'symbol must be 2-20 letters/digits, e.g. BTCUSDT' };
  if (!isTimeframe(raw.timeframe)) return { ok: false, field: 'timeframe', error: `unsupported timeframe: ${raw.timeframe}` };
  const timeframe = raw.timeframe;

  const startMs = /^\d{4}-\d{2}-\d{2}$/.test(raw.startDate) ? Date.parse(`${raw.startDate}T00:00:00Z`) : NaN;
  if (!Number.isFinite(startMs)) return { ok: false, field: 'startDate', error: 'start date must be YYYY-MM-DD' };
  if (startMs >= nowMs) return { ok: false, field: 'startDate', error: 'start date must be in the past' };
  const bars = Math.floor((nowMs - startMs) / timeframeToMs(timeframe));
  if (bars > MAX_BARS) {
    return { ok: false, field: 'startDate', error: `range too large: ${bars} bars (max ${MAX_BARS}); pick a later start date or a larger timeframe` };
  }

  const balance = num(raw.balance);
  if (!(balance > 0)) return { ok: false, field: 'balance', error: 'balance must be greater than 0' };
  const leverage = num(raw.leverage);
  if (!(leverage >= 1 && leverage <= 125)) return { ok: false, field: 'leverage', error: `leverage must be between 1 and 125, got ${typed(raw.leverage)}` };
  const taker = num(raw.takerFeePct);
  const maker = num(raw.makerFeePct);
  if (!(taker >= 0 && taker <= 1)) return { ok: false, field: 'takerFeePct', error: `taker fee must be between 0% and 1%, got ${typed(raw.takerFeePct)}` };
  if (!(maker >= 0 && maker <= 1)) return { ok: false, field: 'makerFeePct', error: `maker fee must be between 0% and 1%, got ${typed(raw.makerFeePct)}` };
  const slippageBps = num(raw.slippageBps);
  if (!(slippageBps >= 0 && slippageBps <= 1000)) return { ok: false, field: 'slippageBps', error: `slippage must be between 0 and 1000 bps, got ${typed(raw.slippageBps)}` };

  return {
    ok: true,
    settings: {
      symbol,
      timeframe,
      startMs,
      broker: { initialBalance: balance, leverage, takerFee: taker / 100, makerFee: maker / 100, slippageBps },
    },
  };
}

/** localStorage key of the remembered top-bar values. */
export const SETTINGS_STORAGE_KEY = 'quant-sim.settings.v1';

/**
 * The defaults with whatever the browser remembered laid over them. Only known fields holding short text count, so a
 * damaged or hand-edited entry can never break the form (an invalid value is caught by parseSettings when Run is
 * pressed, with a message pointing at the field).
 */
export function mergeStoredSettings(defaults: RawSettings, stored: unknown): RawSettings {
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return defaults;
  const merged = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof RawSettings>) {
    const value = (stored as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.length <= 40) merged[key] = value;
  }
  return merged;
}
