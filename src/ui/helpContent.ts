import { ACCOUNT_TEXT, BENCH_TEXT, FIELD_TEXT, MODE_TEXT, TAB_TEXT, TIPS_TEXT } from './descriptions';

/** Longer reading for the Help window and the welcome (loaded only when they are opened). */

/** Words used in the app, explained simply. Shown in the Help window and as tooltips on the result cards. */
export interface GlossaryEntry {
  term: string;
  meaning: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'Strategy', meaning: 'A set of rules your robot follows, like "buy when the price crosses above its average, sell when it crosses below".' },
  { term: 'Backtest', meaning: 'Replaying old prices to see how a strategy would have done. It is like a practice game using the past.' },
  { term: 'Paper trading', meaning: 'Practicing with pretend money. You get the thrill of trading and nobody can lose a cent.' },
  { term: 'Candle', meaning: 'One chunk of time on the chart. It shows where the price started (open), how high and low it went, and where it ended (close). Green = up, red = down.' },
  { term: 'Timeframe', meaning: 'How long one candle lasts: 1m is one minute, 1h one hour, 1d one day.' },
  { term: 'Long and short', meaning: 'Long means you buy and win if the price goes UP. Short means you sell first and win if the price goes DOWN.' },
  { term: 'Position', meaning: 'What you are holding right now: long, short, or flat (nothing).' },
  { term: 'Leverage', meaning: 'A loan that makes your trades bigger. 2x doubles your wins but also doubles your losses. Higher leverage can wipe out your account fast.' },
  { term: 'Fees', meaning: 'A small charge every time you trade, like a toll booth. Many small trades add up!' },
  { term: 'Slippage', meaning: 'Getting a slightly worse price than you expected because the market moved while your order was going through.' },
  { term: 'Indicator', meaning: 'A helper line or number worked out from the prices, like a moving average. Robots use indicators to make decisions.' },
  { term: 'Moving average (SMA / EMA)', meaning: 'The average price over the last few candles. SMA treats every candle the same; EMA counts the newest candles more.' },
  { term: 'Crossover', meaning: 'When one line moves from below another line to above it (or the other way). Many strategies buy or sell at crossovers.' },
  { term: 'Equity', meaning: 'All your money right now, including the profit or loss on anything you are holding.' },
  { term: 'Drawdown', meaning: 'How far your money fell from its highest point. A 10% drawdown means at the worst moment you were 10% below your best.' },
  { term: 'Win rate', meaning: 'Out of all finished trades, the percent that made money.' },
  { term: 'Profit factor', meaning: 'Money won divided by money lost. Above 1 means winners beat losers; 2 means you won twice as much as you lost.' },
  { term: 'Sharpe ratio', meaning: 'A score for how smooth the ride was. Making money in a steady way gives a higher score than making the same money with wild ups and downs.' },
  { term: 'Exposure', meaning: 'How much of the time you were holding a trade. 100% means always in the market.' },
  { term: 'Buy & hold', meaning: 'The lazy plan: buy once at the start and never sell. Your robot should beat it to be worth the effort.' },
  { term: 'Stop-loss', meaning: 'An exit set in advance that sells for you if the price falls too far, to limit a loss.' },
  { term: 'Take-profit', meaning: 'An exit set in advance that sells for you when you have made the profit you wanted.' },
  { term: 'Account wiped', meaning: 'The pretend account ran out of money because of losses. With leverage this can happen quickly.' },
];

/** Starting points for a first-time visitor (the three-step "how it works"). */
export const QUICK_START: ReadonlyArray<{ title: string; text: string }> = [
  { title: 'Pick a robot', text: 'Press "Start from…" and choose a ready-made strategy, or build your own by snapping blocks together on the left.' },
  { title: 'Press Run', text: 'The computer replays old prices and your robot buys and sells along the way. The arrows on the chart show each trade.' },
  { title: 'Read the score card', text: 'Look at the sentence under the chart first. Then check the cards: did you beat buy & hold? Was the ride bumpy?' },
  { title: 'Try Live mode', text: 'When you are curious, switch to Live. Your robot practices with pretend money on prices that are happening right now.' },
];

export const DISCLAIMER =
  'Quant Sim is for learning and fun. It only uses pretend money and never places a real order. Past results do not predict the future, and nothing here is financial advice.';

/** Every button and switch, for the "Buttons & switches" page of the Help window. */
export const BUTTON_GUIDE: ReadonlyArray<{ name: string; text: string }> = [
  { name: 'Backtest / Live', text: `Backtest: ${MODE_TEXT.backtest.on} Live: ${MODE_TEXT.live.on}` },
  { name: 'Coin', text: FIELD_TEXT.symbol },
  { name: 'Candle size', text: FIELD_TEXT.timeframe },
  { name: 'Start date', text: FIELD_TEXT.startDate },
  { name: 'Starting money', text: FIELD_TEXT.balance },
  { name: 'Run', text: FIELD_TEXT.run },
  { name: 'Start from…', text: 'Loads a ready-made robot into the block editor. Your own blocks are saved under "Previous workspaces", so nothing is lost.' },
  { name: 'Chart overlays', text: 'Adds extra helper lines to the chart, like moving averages. They only decorate the chart: they never change what your robot does.' },
  { name: 'Money settings', text: ACCOUNT_TEXT.on },
  { name: 'Leverage', text: FIELD_TEXT.leverage },
  { name: 'Fees and slippage', text: `${FIELD_TEXT.takerFee} ${FIELD_TEXT.makerFee} ${FIELD_TEXT.slippage}` },
  { name: 'Blocks tab', text: TAB_TEXT.blocks.on },
  { name: 'Pine (advanced) tab', text: TAB_TEXT.pine.on },
  { name: 'Fit', text: 'Zooms and moves the block editor so you can see all of your blocks at once.' },
  { name: 'Hide', text: 'Hides a panel to make room. A strip appears with a button to bring it back.' },
  { name: 'Full page', text: 'Makes one panel fill the whole page. Press Esc or "Exit full page" to go back.' },
  { name: 'View', text: 'Lists every panel so you can hide, show or full-page it, and turn helper notes on or off.' },
  { name: 'Buy & hold line', text: BENCH_TEXT.on },
  { name: 'Trade numbers', text: 'In the list of trades, click a number to jump the chart to that trade and see exactly where your robot bought and sold.' },
  { name: 'Copy summary', text: 'Copies your result as a few lines of text, ready to paste into a message to a friend.' },
  { name: 'Fit view', text: 'Zooms the chart back out so every candle is on screen.' },
  { name: 'Export trades', text: 'Saves your list of trades as a spreadsheet file (CSV) you can open in Excel or Google Sheets.' },
  { name: 'Chart picture', text: 'Saves a picture (PNG) of the chart exactly as you see it.' },
  { name: 'Save / Open strategy', text: 'Saves your blocks to a small file, or loads blocks from a file you saved before. Great for sharing a robot with a friend.' },
  { name: 'Dark / light', text: 'Switches the colors of the whole page between dark and light.' },
  { name: 'Helper notes', text: TIPS_TEXT.on },
];
