import type { Candle } from '../data/types';
import type { EquityPoint } from './stats';
import type { BrokerConfig } from './types';

/** Buy & hold over the same bars as a backtest: the "did the strategy beat just holding?" yardstick. */
export interface Benchmark {
  /** One point per bar, marked at that bar's close (same times as the strategy's equity curve). */
  equityCurve: EquityPoint[];
  initialEquity: number;
  finalEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  /** Entry fill price: the second bar's open (the first a strategy could fill at) plus slippage. */
  entryPrice: number;
  qty: number;
  entryFee: number;
}

/** Plain-language definition, shown as a tooltip wherever the benchmark appears. */
export const BENCHMARK_DEFINITION =
  "Buy & hold: one 1x long with the same starting balance, entered at the first bar a strategy could trade (the next " +
  "bar's open, with taker fee and slippage), held to the last close, no exit fee.";

/**
 * Buy & hold with the backtest's starting balance: a 1x long entered at the first bar a strategy could trade, i.e.
 * the open of the SECOND bar (an order placed on bar 0's close fills there), with the taker fee and slippage on
 * entry, all-in (notional + entry fee = starting balance), held to the last close with no exit fee. The curve has
 * one point per bar like the strategy's: flat at the starting balance on bar 0, then qty x close. Leverage and maker
 * fee do not apply. Null with fewer than 2 bars (nothing could be traded) or a non-positive entry open. Pure.
 */
export function buyAndHold(candles: readonly Candle[], broker: BrokerConfig): Benchmark | null {
  if (candles.length < 2) return null;
  const initialEquity = broker.initialBalance;
  const entryPrice = candles[1].open * (1 + broker.slippageBps / 10_000);
  if (!(entryPrice > 0) || !(initialEquity > 0)) return null;
  const qty = initialEquity / (entryPrice * (1 + broker.takerFee));
  const entryFee = qty * entryPrice * broker.takerFee;

  const equityCurve: EquityPoint[] = candles.map((c, i) => ({ time: c.time, equity: i === 0 ? initialEquity : qty * c.close }));
  let peak = initialEquity;
  let maxDd = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }
  const finalEquity = equityCurve[equityCurve.length - 1].equity;
  return {
    equityCurve,
    initialEquity,
    finalEquity,
    returnPct: (finalEquity / initialEquity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    entryPrice,
    qty,
    entryFee,
  };
}
