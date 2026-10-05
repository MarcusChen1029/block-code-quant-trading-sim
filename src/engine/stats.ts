import { timeframeToMs, type Timeframe } from '../data/types';
import type { Trade } from './types';

export interface EquityPoint {
  /** Bar open time, epoch ms. Equity is marked at that bar's close. */
  time: number;
  equity: number;
}

/** NaN means "not defined" (e.g. win rate with zero trades); the UI shows it as an em dash. */
export interface Stats {
  initialEquity: number;
  finalEquity: number;
  netProfit: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  winRatePct: number;
  /** Gross net-profit of winners / |gross net-loss of losers|; Infinity with no losers. */
  profitFactor: number;
  /** Annualized (365-day crypto year) Sharpe of per-bar equity returns, risk-free 0, sample stdev. */
  sharpe: number;
  tradeCount: number;
  exposurePct: number;
}

export interface StatsInput {
  initialEquity: number;
  equityCurve: readonly EquityPoint[];
  trades: readonly Trade[];
  barsInPosition: number;
  timeframe: Timeframe;
}

const YEAR_MS = 365 * 86_400_000;

export function computeStats(input: StatsInput): Stats {
  const { initialEquity, equityCurve, trades, barsInPosition, timeframe } = input;
  const series = [initialEquity, ...equityCurve.map((p) => p.equity)];
  const finalEquity = series[series.length - 1];

  let peak = series[0];
  let maxDd = 0;
  for (const e of series) {
    peak = Math.max(peak, e);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - e) / peak);
  }

  const wins = trades.filter((t) => t.netPnl > 0);
  const grossWin = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = -trades.filter((t) => t.netPnl < 0).reduce((s, t) => s + t.netPnl, 0);
  const profitFactor = trades.length === 0 ? NaN : grossLoss === 0 ? (grossWin > 0 ? Infinity : NaN) : grossWin / grossLoss;

  const returns: number[] = [];
  for (let i = 1; i < series.length; i++) returns.push(series[i - 1] > 0 ? series[i] / series[i - 1] - 1 : 0);
  let sharpe = NaN;
  if (returns.length >= 2) {
    const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1);
    const sd = Math.sqrt(variance);
    if (sd > 0) sharpe = (mean / sd) * Math.sqrt(YEAR_MS / timeframeToMs(timeframe));
  }

  return {
    initialEquity,
    finalEquity,
    netProfit: finalEquity - initialEquity,
    totalReturnPct: (finalEquity / initialEquity - 1) * 100,
    maxDrawdownPct: maxDd * 100,
    winRatePct: trades.length === 0 ? NaN : (wins.length / trades.length) * 100,
    profitFactor,
    sharpe,
    tradeCount: trades.length,
    exposurePct: equityCurve.length === 0 ? 0 : (barsInPosition / equityCurve.length) * 100,
  };
}
