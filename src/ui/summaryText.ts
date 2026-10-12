export interface SummaryInput {
  /** The one-sentence verdict shown above the stats. */
  verdict: string;
  symbol: string;
  timeframe: string;
  startDate: string;
  balance: string;
  /** What was tested, e.g. "my blocks" or "the built-in SMA cross". */
  strategy: string;
}

/** Plain text a person can paste into a chat: the verdict, what it was tested on, and the honesty line. */
export function summaryText(i: SummaryInput): string {
  return [
    `My Quant Sim result: ${i.verdict.trim()}`,
    `Tested ${i.strategy} on ${i.symbol.trim().toUpperCase()} (${i.timeframe} candles) since ${i.startDate} with ${i.balance.trim()} pretend dollars.`,
    'Pretend money only. Past results do not predict the future.',
  ].join('\n');
}
