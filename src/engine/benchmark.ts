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
  /** The account leverage the hold was sized at (1 = a plain spot-like hold). */
  leverage: number;
  /** True when the leveraged hold's equity reached <= 0 and it was closed (the curve is flat from there on). */
  wiped: boolean;
}

/** "2x", "2.5x" (at most 2 decimals, no trailing zeros). */
function leverageText(leverage: number): string {
  return `${Number(leverage.toFixed(2))}x`;
}

/** 'Buy & hold' at 1x, 'Buy & hold (3x)' otherwise: the benchmark's name wherever it is shown. */
export function benchmarkLabel(leverage: number): string {
  return leverage === 1 ? 'Buy & hold' : `Buy & hold (${leverageText(leverage)})`;
}

/** Plain-language definition, shown as a tooltip wherever the benchmark appears. */
export function benchmarkDefinition(leverage = 1): string {
  const size = leverage === 1
    ? 'one 1x long with the same starting balance'
    : `one ${leverageText(leverage)} long with the same starting balance (all equity as margin, like a 100% of equity order at the account leverage; wiped like the strategy if equity reaches zero)`;
  return `${benchmarkLabel(leverage)}: ${size}, entered at the first bar a strategy could trade (the next bar's open, with ` +
    'taker fee and slippage), held to the last close, no exit fee.';
}

/** The 1x definition (kept for callers that have no leverage at hand). */
export const BENCHMARK_DEFINITION = benchmarkDefinition(1);

/**
 * Buy & hold with the backtest's starting balance, sized exactly like a 100 %-of-equity market order at the
 * ACCOUNT LEVERAGE L (broker percentEquity): qty = balance / (entry x (1/L + taker fee)), entered at the first bar a
 * strategy could trade, i.e. the open of the SECOND bar (an order placed on bar 0's close fills there), with the
 * taker fee and slippage on entry, held to the last close with no exit fee. The curve has one point per bar like the
 * strategy's: flat at the starting balance on bar 0, then (balance - entry fee) + qty x (close - entry); at 1x that
 * is exactly qty x close. Like the engine, a close at which that equity is <= 0 closes the hold at the close with the
 * taker fee ("wiped") and the curve stays flat at what is left. Maker fee does not apply. Null with fewer than 2 bars
 * (nothing could be traded) or a non-positive entry open or leverage. Pure: live mode calls it too.
 */
export function buyAndHold(candles: readonly Candle[], broker: BrokerConfig): Benchmark | null {
  if (candles.length < 2) return null;
  const initialEquity = broker.initialBalance;
  const leverage = broker.leverage;
  const entryPrice = candles[1].open * (1 + broker.slippageBps / 10_000);
  if (!(entryPrice > 0) || !(initialEquity > 0) || !(leverage > 0)) return null;
  // At 1x keep the historical formula (bit-identical results); otherwise the broker's percentEquity sizing.
  const qty = leverage === 1
    ? initialEquity / (entryPrice * (1 + broker.takerFee))
    : initialEquity / (entryPrice * (1 / leverage + broker.takerFee));
  const entryFee = qty * entryPrice * broker.takerFee;
  const cash = initialEquity - entryFee;

  let wiped = false;
  let wipedEquity = 0;
  const equityCurve: EquityPoint[] = candles.map((c, i) => {
    if (i === 0) return { time: c.time, equity: initialEquity };
    if (wiped) return { time: c.time, equity: wipedEquity };
    if (leverage === 1) return { time: c.time, equity: qty * c.close };
    const equity = cash + qty * (c.close - entryPrice);
    if (equity <= 0) {
      wiped = true;
      wipedEquity = equity - qty * c.close * broker.takerFee; // force-closed at the close with the taker fee
      return { time: c.time, equity: wipedEquity };
    }
    return { time: c.time, equity };
  });
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
    leverage,
    wiped,
  };
}
