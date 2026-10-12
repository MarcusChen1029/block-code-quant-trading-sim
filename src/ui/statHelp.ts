/** Plain-English meaning of each result card (keyed by the card's label from format.ts), shown when hovering it. */
export const STAT_HELP: Record<string, string> = {
  'Total return': 'How much your money grew (or shrank), as a percent of what you started with. 50% means $10,000 became $15,000.',
  'Net profit': 'The money you made (or lost) after paying all fees.',
  'Final equity': 'All the money you have at the end, including anything still invested.',
  'Max drawdown': 'The biggest drop from a high point. Smaller is better: a 30% drawdown means at one point you were down 30% from your best.',
  'Win rate': 'Out of all finished trades, how many made money. 50% means half won. You can win less than half and still profit if your wins are bigger.',
  'Profit factor': 'Money won divided by money lost. Above 1 means winners beat losers. Below 1 means you lost more than you won.',
  'Sharpe': 'A score for how smooth your ride was. Higher means steadier gains. Above 1 is good, below 0 means losing money.',
  'Trades': 'How many times your robot opened and closed a position.',
  'Exposure': 'The percent of time your robot was holding a trade. 100% means it was always in the market.',
};

/** What the "Exit by" column of the trade list means, in words (key = the engine's fill reason). */
export const EXIT_REASON_HELP: Record<string, string> = {
  market: 'Your robot decided to close the trade.',
  limit: 'A price you set in advance was reached.',
  stop: 'A stop order was triggered.',
  stopLoss: 'The stop-loss sold for you to limit the loss.',
  takeProfit: 'The take-profit sold for you when the target was reached.',
  wiped: 'The account ran out of money, so the position was closed by force.',
};

/** Short words for the "Why it closed" column. */
export const EXIT_REASON_LABEL: Record<string, string> = {
  market: 'Robot', limit: 'Limit price', stop: 'Stop', stopLoss: 'Stop-loss', takeProfit: 'Take-profit', wiped: 'Account wiped',
};

/** Column headings of the trade list, with what each one means. */
export const TRADE_COLUMNS: ReadonlyArray<{ title: string; help: string }> = [
  { title: '#', help: 'Trade number, oldest first.' },
  { title: 'Side', help: 'Long means you bought and win if the price rises. Short means you sold first and win if the price falls.' },
  { title: 'Opened', help: 'When the trade started (UTC time).' },
  { title: 'Open price', help: 'The price when the trade started.' },
  { title: 'Closed', help: 'When the trade ended (UTC time).' },
  { title: 'Close price', help: 'The price when the trade ended.' },
  { title: 'Amount', help: 'How much of the coin was traded.' },
  { title: 'Profit / loss', help: 'Money made (green) or lost (red) on this trade, after fees.' },
  { title: 'Why it closed', help: 'What ended the trade. Hover over a value to read it.' },
];
