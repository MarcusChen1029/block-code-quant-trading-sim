/**
 * Plain-English text for the whole interface, written for a 12-year-old: short sentences, no jargon (or the jargon
 * is explained right away). One place, so every tooltip, "what just changed" note and help page says the same thing.
 */

/** What a switch does, in its two states (`off` may repeat or be omitted for one-way controls). */
export interface ToggleText {
  /** Short name, used as the heading of the note. */
  title: string;
  /** What it does when it is switched on (or clicked, for a one-way control). */
  on: string;
  /** What it does when it is switched off. */
  off?: string;
}

export const MODE_TEXT = {
  backtest: {
    title: 'Backtest mode',
    on: 'Time machine! The computer replays old prices and pretends your robot traded them, so you can see how it would have done. Press Run to start. Nothing real happens.',
  },
  live: {
    title: 'Live mode',
    on: 'Practice in real time. Your robot trades pretend money using prices that are happening right now. Nothing real is ever bought or sold, and you can stop at any time.',
  },
} as const satisfies Record<string, ToggleText>;

/** Fields in the top bar: shown as tooltips and under the "?" help. */
export const FIELD_TEXT = {
  symbol: 'Which coin to practice with. BTCUSDT means Bitcoin priced in US dollars (USDT is a coin that stays worth about $1).',
  timeframe: 'How much time one candle on the chart covers. 1h means every candle shows one hour. Small sizes make many candles and many trades.',
  startDate: 'Where the replay begins. An earlier date means more history to learn from, but it takes a little longer to load.',
  balance: 'How much pretend money you start with. You cannot lose real money here.',
  run: 'Replay the past with your strategy and show how it did. Shortcut: R, or Ctrl + Enter.',
  leverage: 'Leverage is like a loan. 2x means you trade with twice your money, so wins AND losses both get twice as big. 1x means no loan. Higher is riskier!',
  takerFee: 'The fee you pay when you buy or sell right away at the market price. It is a small percent of each trade.',
  makerFee: 'The fee you pay when you set a price and wait for the market to come to you. It is usually cheaper than the market fee.',
  slippage: 'In real life you often get a slightly worse price than you saw. This adds that on purpose. 1 bps is 0.01%, a tiny bit.',
  strategy: 'What Run tests: the blocks you built, or a ready-made example robot.',
} as const;

export const ACCOUNT_TEXT: ToggleText = {
  title: 'Advanced money settings',
  on: 'Here you can change leverage (a loan that makes wins and losses bigger), trading fees and slippage. The defaults are fine to start with.',
  off: 'Advanced money settings are tucked away. Your values are still used and shown in the short summary.',
};

export const TAB_TEXT = {
  blocks: { title: 'Blocks', on: 'Build your trading robot by snapping puzzle blocks together. Pick a block group on the left, then drag blocks onto the grid.' },
  pine: { title: 'Pine', on: 'Pine is a short text language that TradingView uses for indicators. Paste one here and it turns into blocks you can use.' },
} as const satisfies Record<string, ToggleText>;

export const LIVE_TARGET_TEXT = {
  browser: { title: 'This browser', on: 'Your live practice runs inside this page. It stops when you close the tab or your computer sleeps.' },
  server: { title: 'Server 24/7', on: 'Your live practice runs on a computer that stays on, so it keeps trading while this page is closed. You log in to see it.' },
} as const satisfies Record<string, ToggleText>;

export const BENCH_TEXT: ToggleText = {
  title: 'Buy & hold line',
  on: 'The dotted line shows what you would have if you just bought at the start and never sold. A good robot beats this line.',
  off: 'The dotted buy & hold line is hidden. Only your robot’s money line is shown.',
};

export const THEME_TEXT: Record<'dark' | 'light', ToggleText> = {
  dark: { title: 'Dark mode', on: 'Dark colors: easier on your eyes at night.' },
  light: { title: 'Light mode', on: 'Light colors: easier to read in a bright room.' },
};

export const TIPS_TEXT: ToggleText = {
  title: 'Helper notes',
  on: 'Helper notes are on: when you switch something, a short note says what it does.',
  off: 'Helper notes are off. You can still hover over anything to see what it does.',
};

export const PINE_SHOW_TEXT: ToggleText = {
  title: 'Show on chart',
  on: 'This indicator is now drawn on the price chart so you can see it.',
  off: 'This indicator is no longer drawn on the chart.',
};

/** What each overlay is, and what to look for (id -> text). Unknown ids fall back to `overlayText`'s generic line. */
export const OVERLAY_TEXT: Record<string, string> = {
  sma20: 'Simple moving average: the average price of the last 20 candles. It smooths the wiggles so you can see the trend.',
  ema50: 'Exponential moving average: like an average of the last 50 candles, but the newest candles count more, so it reacts faster.',
  bb20: 'Bollinger Bands: a channel around the average price. Price touching the edges means it moved a lot, farther than usual.',
  vwap: 'Volume-weighted average price: the average price where most of the trading happened.',
  rsi14: 'RSI: a meter from 0 to 100 that shows how fast the price moved. Over 70 means "went up a lot", under 30 means "went down a lot".',
  macd: 'MACD: two lines that cross when the trend changes direction. The bars show how strong the push is.',
  atr14: 'ATR: how far the price usually moves in one candle. A big number means a wild, jumpy market.',
  'zones-orderblock': 'Order blocks: boxes drawn where big players may have placed large orders. Price often reacts when it comes back to a box.',
  'zones-fvg': 'FVG (fair value gaps): boxes marking a quick jump where the price skipped over a range. Price likes to come back and fill them.',
  'zones-swing': 'Swing structure: connects the important highs and lows. An arrow marks when the price breaks through one, which can mean a new trend.',
  stoch: 'Stochastic: shows where the price is inside its recent high-to-low range. Near the top or bottom means it could turn around.',
};

export function overlayText(id: string, label: string): string {
  return OVERLAY_TEXT[id] ?? `${label}: an extra line or shape drawn on the chart to help you read it. It does not change your strategy.`;
}

/** The overlay's explanation without its leading name ("Simple moving average: …" -> "…"), for lists that show the name apart. */
export function overlayBlurb(id: string, label: string): string {
  const text = overlayText(id, label);
  const at = text.indexOf(': ');
  return at < 0 ? text : text[at + 2].toUpperCase() + text.slice(at + 3);
}

export const PANEL_TEXT = {
  strategy: {
    title: 'Strategy',
    subtitle: 'Build your trading robot',
    help: 'This is where you build your robot out of puzzle blocks. The robot looks at each new candle and decides to buy, sell or wait.',
  },
  chart: {
    title: 'Chart',
    subtitle: 'The price, one candle at a time',
    help: 'Each candle is a chunk of time. Green means the price went up, red means it went down. Arrows mark where your robot bought or sold.',
  },
  results: {
    title: 'Results',
    subtitle: 'How your robot did',
    help: 'The score card for your last run: how much money you made or lost, how bumpy the ride was, and a list of every trade.',
  },
  live: {
    title: 'Live practice',
    subtitle: 'Pretend trading with live prices',
    help: 'Start a practice session that trades pretend money using real prices as they happen. Sessions are listed here so you can come back to them.',
  },
} as const;

export const PANEL_BUTTON_TEXT = {
  hide: (name: string): ToggleText => ({
    title: `${name} hidden`,
    on: `${name} is hidden to make room. Bring it back with its button in the \u201CHidden panels\u201D strip, or from the View menu.`,
  }),
  show: (name: string): ToggleText => ({ title: `${name} shown`, on: `${name} is back.` }),
  full: (name: string): ToggleText => ({
    title: `${name} full page`,
    on: `${name} now fills the whole page. Press Esc or the shrink button to go back.`,
  }),
  exitFull: (name: string): ToggleText => ({ title: 'Back to normal', on: `${name} is back to its normal size.` }),
};

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
  { name: 'Pine tab', text: TAB_TEXT.pine.on },
  { name: 'Fit', text: 'Zooms and moves the block editor so you can see all of your blocks at once.' },
  { name: 'Hide', text: 'Hides a panel to make room. A strip appears with a button to bring it back.' },
  { name: 'Full page', text: 'Makes one panel fill the whole page. Press Esc or "Exit full page" to go back.' },
  { name: 'View', text: 'Lists every panel so you can hide, show or full-page it, and turn helper notes on or off.' },
  { name: 'Buy & hold line', text: BENCH_TEXT.on },
  { name: 'Export trades', text: 'Saves your list of trades as a spreadsheet file (CSV) you can open in Excel or Google Sheets.' },
  { name: 'Chart picture', text: 'Saves a picture (PNG) of the chart exactly as you see it.' },
  { name: 'Save / Open strategy', text: 'Saves your blocks to a small file, or loads blocks from a file you saved before. Great for sharing a robot with a friend.' },
  { name: 'Dark / light', text: 'Switches the colors of the whole page between dark and light.' },
  { name: 'Helper notes', text: TIPS_TEXT.on },
];

/** What each block group in the editor's menu is for (key = the category's name in blocks/toolbox.ts). */
export const BLOCK_GROUP_TEXT: Record<string, string> = {
  Events: 'Start here! These blocks choose WHEN your robot wakes up, like every time a candle closes.',
  Market: 'Prices from the chart: the open, high, low, close and volume of a candle, now or a few candles ago.',
  Account: 'Facts about your pretend account: how much money you have, and what you are holding right now.',
  Indicators: 'Helper numbers worked out from the prices, like moving averages and RSI. Robots use them to decide.',
  Zones: 'Boxes on the chart that mark places where the price may react, like order blocks and gaps.',
  Pine: 'Indicators you brought in from TradingView\u2019s Pine language (see the Pine tab).',
  Logic: 'Decisions: IF something is true THEN do something. Also AND, OR, NOT and comparisons.',
  Math: 'Numbers and calculations: add, subtract, round, smaller or bigger of two numbers.',
  'My variables': 'Named boxes where your robot can remember a number, like how many candles have passed.',
  Actions: 'What your robot DOES: buy, sell, close a trade, set a stop-loss or a take-profit.',
  Functions: 'Your own recipes: group blocks under a name and use them again and again.',
};
