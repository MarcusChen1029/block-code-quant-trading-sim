/**
 * Words used across the app, explained for a beginner (aim: a curious 12-year-old). Every tooltip that names a
 * term can point here; the Help window lists them all with a search box.
 */
export interface GlossaryEntry {
  term: string;
  /** Other names people search for ("bar" for candle). */
  aka?: string[];
  text: string;
  /** A tiny worked example, when it helps. */
  example?: string;
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'Strategy', aka: ['trading bot', 'robot'], text: 'A set of rules that decides when to buy and when to sell. Here you build it from blocks, like a recipe the computer follows on every candle.', example: '“When the price goes above its 20-candle average, buy. When it drops below, sell.”' },
  { term: 'Block', text: 'One puzzle piece of your strategy. Drag blocks from the list on the left and snap them together. Hover over any block to see what it does.' },
  { term: 'Backtest', aka: ['test on the past'], text: 'Running your strategy on old prices to see what would have happened. It is fast and safe: nothing real is bought or sold.' },
  { term: 'Live practice', aka: ['paper trading', 'live mode'], text: 'Running your strategy on prices as they happen right now, with pretend money. No real orders are ever sent.' },
  { term: 'Candle', aka: ['bar', 'candlestick'], text: 'One block of time on the chart. It shows where the price started (open), its highest and lowest point (high, low) and where it ended (close). Green means the price went up during that time; red means it went down.' },
  { term: 'Candle size', aka: ['timeframe', 'TF', 'interval'], text: 'How much time one candle covers: 1m is one minute, 1h one hour, 1d one day. Small candles show lots of detail; big candles show the long-term picture.' },
  { term: 'Coin', aka: ['product', 'symbol', 'pair', 'BTCUSDT'], text: 'What you trade. BTCUSDT means Bitcoin (BTC) priced in USDT, a digital coin that is worth about one US dollar.' },
  { term: 'Long', aka: ['buy'], text: 'Buying because you think the price will go UP. You make money if it rises and lose if it falls.' },
  { term: 'Short', aka: ['sell'], text: 'Betting the price will go DOWN. You make money if it falls and lose if it rises.' },
  { term: 'Position', text: 'What you are holding right now: long (you bought), short (you sold), or flat (nothing).' },
  { term: 'Order', aka: ['market order', 'limit order'], text: 'An instruction to buy or sell. A market order fills straight away at the next price. A limit order waits until the price reaches the number you chose.' },
  { term: 'Stop-loss', aka: ['stop'], text: 'A safety exit: if the price moves against you by this much, the trade closes automatically to stop the loss from growing.', example: 'Stop-loss 2% on a long bought at $100 sells at $98.' },
  { term: 'Take-profit', aka: ['target'], text: 'An automatic exit that locks in a win once the price moves in your favour by this much.' },
  { term: 'Balance', aka: ['starting money'], text: 'The pretend money your account starts with. It only changes when a trade closes.' },
  { term: 'Equity', text: 'What your account would be worth if you closed everything right now: balance plus (or minus) the profit of the trade that is still open.' },
  { term: 'Leverage', text: 'Borrowing to trade bigger than your money. 1x means no borrowing. 5x means a $100 trade controls $500: wins AND losses are 5 times bigger. Too much leverage can wipe out the account.' },
  { term: 'Fee', aka: ['taker', 'maker', 'commission'], text: 'A small charge the exchange takes on every trade. “Taker” is the fee for orders that fill straight away; “maker” is for orders that wait in the order book.', example: 'A 0.04% fee on a $1,000 trade is 40 cents.' },
  { term: 'Slippage', aka: ['bps', 'basis points'], text: 'When an instant order fills at a slightly worse price than you saw, because prices move fast. Measured in basis points (bps): 1 bps = 0.01%.' },
  { term: 'Indicator', text: 'A calculation drawn on the chart that helps spot patterns, like an average of recent prices. Indicators never see the future.' },
  { term: 'SMA', aka: ['simple moving average', 'average'], text: 'The average closing price of the last N candles. It smooths out the wiggles so you can see the trend.', example: 'SMA 20 = the average of the last 20 closes.' },
  { term: 'EMA', aka: ['exponential moving average'], text: 'Like the SMA, but it cares more about recent candles, so it reacts faster.' },
  { term: 'RSI', aka: ['relative strength index'], text: 'A score from 0 to 100 that shows how fast the price has been rising or falling. Above 70 is often called “overbought”, below 30 “oversold”.' },
  { term: 'MACD', text: 'Compares a fast and a slow average. When the fast one moves above the slow one, the trend may be turning up.' },
  { term: 'Bollinger Bands', aka: ['BB'], text: 'A band around the average price. It gets wider when the price is jumping around a lot and narrower when it is calm.' },
  { term: 'VWAP', text: 'The average price, weighted by how much was traded at each price. Big traders often watch it.' },
  { term: 'ATR', aka: ['average true range'], text: 'How much the price usually moves in one candle. Handy for choosing a sensible stop-loss distance.' },
  { term: 'Crosses over / under', aka: ['crossover'], text: 'The moment one line moves from below another line to above it (over) or the other way (under). Many strategies trade on these moments.' },
  { term: 'Total return', text: 'How much your money grew or shrank, in percent.', example: '+10% means $10,000 became $11,000.' },
  { term: 'Net profit', text: 'The money you made or lost in dollars, after fees.' },
  { term: 'Max drawdown', aka: ['drawdown', 'worst drop'], text: 'The biggest fall from a high point to a low point along the way. It tells you how scary the ride was, even if it ended well.' },
  { term: 'Win rate', text: 'The share of trades that made money.', example: '60% means 6 out of 10 trades were winners.' },
  { term: 'Profit factor', text: 'Money won on winning trades divided by money lost on losing trades. Above 1 means the winners beat the losers.' },
  { term: 'Sharpe ratio', aka: ['sharpe'], text: 'Return compared with how bumpy the ride was. Higher is better: above 1 is good, above 2 is very good. Negative means it lost money.' },
  { term: 'Exposure', aka: ['time in market'], text: 'How much of the time the strategy was holding a trade, in percent.' },
  { term: 'Buy & hold', aka: ['benchmark'], text: 'The simplest plan: buy at the start and do nothing until the end. A good strategy should beat it, or at least lose less on the way down.' },
  { term: 'Warm-up', text: 'Indicators need some past candles before they have a value (an SMA 50 needs 50 candles). Until then they say “na” (not available) and no trades happen.' },
  { term: 'Account wiped', aka: ['liquidation'], text: 'The account lost all its money, usually from too much leverage. The test stops there.' },
  { term: 'Pine Script', aka: ['pine'], text: 'A small coding language made by TradingView for indicators. Paste or write one in the Pine tab and it becomes a block you can use.' },
  { term: 'Zones', aka: ['order block', 'fair value gap', 'FVG'], text: 'Boxes on the chart marking price areas where something interesting happened before, like a sudden jump that left a gap. Prices often come back to them.' },
];

export interface Step {
  title: string;
  text: string;
}

export const GETTING_STARTED: readonly Step[] = [
  { title: 'Pick a starting strategy', text: 'Open “Start from…” and choose one, or keep the example that is already loaded. Each block is one rule; hover over a block to learn what it does.' },
  { title: 'Choose what to test', text: 'Pick a coin, a candle size and a start date in the bar at the top. Your pretend starting money is under “Starting money”.' },
  { title: 'Press ▶ Run test', text: 'The robot replays every candle from the start date until now, buying and selling by your rules. Arrows on the chart show each trade.' },
  { title: 'Read the result', text: 'The coloured sentence tells you how it went and whether it beat simply buying and holding. The cards below explain each number: hover over or tap them.' },
  { title: 'Tweak and try again', text: 'Change one number (like the average length), run again and compare. When you like it, switch to Live to practise on real-time prices with pretend money.' },
];

export interface Faq {
  q: string;
  a: string;
}

export const FAQ: readonly Faq[] = [
  { q: 'Is this real money?', a: 'No. Everything uses pretend money. The app only reads public prices; it can never place a real order or touch a real account.' },
  { q: 'Where is my work saved?', a: 'In this browser only (local storage). There is no account and nothing is uploaded. Use “Export strategy” in Settings to keep a copy as a file or move it to another computer.' },
  { q: 'Why did my strategy make no trades?', a: 'Usually the rules never became true, or the indicators were still warming up. Try an earlier start date, a shorter average, or check the red problem list under the blocks.' },
  { q: 'My strategy made money. Will it work in the future?', a: 'Not necessarily. Past prices never promise future prices. A strategy that is tuned very tightly to the past often fails later. Test it on different coins and dates.' },
  { q: 'What does the warning “na” mean?', a: 'Not available: an indicator does not have enough candles yet to give a number. It is normal at the very start of a test.' },
  { q: 'Can I undo a mistake in the blocks?', a: 'Yes: Ctrl+Z (Cmd+Z on a Mac) undoes and Ctrl+Shift+Z redoes. Loading a starter also keeps your last 3 workspaces under “Start from…”.' },
];
