# Quant Sim

Build a trading robot by snapping blocks together, test it on real crypto prices from the past, and practise
live with pretend money. Everything runs in your browser; there is no sign-up and nothing is uploaded.

> **Pretend money only.** Quant Sim reads public Binance market data. It has no API keys and can never place a
> real order.

## What you can do

- **Build a strategy with blocks** (Blockly): events, prices, indicators (SMA, EMA, RSI, MACD, Bollinger,
  Supertrend, VWAP, ATR, Stochastic…), zones (order blocks, fair value gaps, swing structure), logic, maths,
  variables, functions and orders with stop-loss / take-profit. Hover over any block to see what it does.
- **Start from a ready-made strategy** (“Start from…”), each labelled Beginner, Intermediate or Advanced. The
  blocks they replace are kept, so nothing is lost.
- **Backtest** on any Binance futures coin and candle size, with leverage, fees and slippage. Results show a
  plain-language verdict (“your strategy beat buy & hold by…”), key numbers that explain themselves, a
  money-over-time chart against buy & hold, the full trade list (CSV download), the robot's log, and a History of
  your recent tests to compare changes (🏆 marks the best).
- **Live practice**: run the strategy on live prices in the browser tab, or 24/7 on your own server
  ([docs/server.md](docs/server.md)).
- **Pine Script**: paste a TradingView indicator (v4–v6 subset); it becomes a new block.

## Made for beginners

- A 1-minute guided tour on the first visit (Settings → Take the tour again).
- A “?” next to every setting and panel, and a description on everything you hover, focus or tap.
- Help window (`?`): getting started, a searchable word list, common questions, keyboard shortcuts, safety and
  privacy.
- Every panel (Strategy, Price chart, Results) can be hidden or shown full page; drag the handles to resize.
  The layout is remembered.
- Dark and light colours (or follow the device), three text sizes, keyboard-friendly, screen-reader labels,
  WCAG AA contrast, reduced-motion support, works on phones.
- Export your strategy as a file and import it on another computer; save the chart as a picture.

### Keyboard shortcuts

| Keys | What it does |
| --- | --- |
| `Ctrl` + `Enter` (`⌘` + `Enter`) | Run the test |
| `?` | Open Help |
| `[` / `]` | Hide or show the strategy / results panel |
| `F` | Chart full page |
| `Esc` | Leave full page, close a menu or window |
| `D` | Dark / light colours |

## Run it

Requires Node 24 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (vitest)
npm run typecheck
npm run build      # production build in dist/
```

The optional always-on server is described in [docs/server.md](docs/server.md).

## Project layout

| Folder | What is in it |
| --- | --- |
| `src/blocks` | Block definitions, toolbox, compiler from blocks to a strategy program, starters |
| `src/engine` | The backtest engine: broker simulation, fills, stats, buy & hold benchmark |
| `src/indicators` | Indicator implementations (streaming, no look-ahead) |
| `src/pine` | The Pine Script subset compiler |
| `src/data` | Binance market data (REST + websocket) and the candle cache |
| `src/live` | Live paper-trading sessions (browser worker and server client) |
| `src/ui` | Everything on screen: layout, panels, charts, tooltips, help, tour, theme |
| `server` | The optional Node server for 24/7 live sessions |

## Credits

Charts by [TradingView Lightweight Charts™](https://www.tradingview.com/) (© TradingView, Inc.). Blocks by
[Blockly](https://developers.google.com/blockly) (Apache 2.0). Market data from Binance public endpoints.

Quant Sim is a learning tool, not financial advice. Results on past prices do not predict the future.
