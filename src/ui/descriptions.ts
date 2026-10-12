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

/** "15m" -> "15 minutes", "1h" -> "1 hour", "1d" -> "1 day" (anything else comes back as typed). */
export function timeframeWords(tf: string): string {
  const m = /^(\d+)([mhd])$/.exec(tf);
  if (!m) return tf;
  const unit = { m: 'minute', h: 'hour', d: 'day' }[m[2] as 'm' | 'h' | 'd'];
  return `${m[1]} ${unit}${m[1] === '1' ? '' : 's'}`;
}

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
