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

export type ParseResult = { ok: true; settings: RunSettings } | { ok: false; error: string };

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
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { ok: false, error: 'symbol must be 2-20 letters/digits, e.g. BTCUSDT' };
  if (!isTimeframe(raw.timeframe)) return { ok: false, error: `unsupported timeframe: ${raw.timeframe}` };
  const timeframe = raw.timeframe;

  const startMs = /^\d{4}-\d{2}-\d{2}$/.test(raw.startDate) ? Date.parse(`${raw.startDate}T00:00:00Z`) : NaN;
  if (!Number.isFinite(startMs)) return { ok: false, error: 'start date must be YYYY-MM-DD' };
  if (startMs >= nowMs) return { ok: false, error: 'start date must be in the past' };
  const bars = Math.floor((nowMs - startMs) / timeframeToMs(timeframe));
  if (bars > MAX_BARS) {
    return { ok: false, error: `range too large: ${bars} bars (max ${MAX_BARS}); pick a later start date or a larger timeframe` };
  }

  const balance = num(raw.balance);
  if (!(balance > 0)) return { ok: false, error: 'balance must be greater than 0' };
  const leverage = num(raw.leverage);
  if (!(leverage >= 1 && leverage <= 125)) return { ok: false, error: 'leverage must be between 1 and 125' };
  const taker = num(raw.takerFeePct);
  const maker = num(raw.makerFeePct);
  if (!(taker >= 0 && taker <= 1) || !(maker >= 0 && maker <= 1)) return { ok: false, error: 'fees must be between 0% and 1%' };
  const slippageBps = num(raw.slippageBps);
  if (!(slippageBps >= 0 && slippageBps <= 1000)) return { ok: false, error: 'slippage must be between 0 and 1000 bps' };

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
