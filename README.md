# Quant Sim

Build a trading robot out of puzzle blocks, then see how it would have done on real crypto price history, using
**pretend money**. No account, no sign-up, and nothing real is ever bought or sold.

## What you can do

- **Build** a strategy by snapping blocks together (Blockly), start from a ready-made robot, or bring in a TradingView
  Pine Script indicator (Pine tab, advanced).
- **Backtest**: replay old prices in seconds. A plain-English sentence says how it went, the score cards explain
  themselves on hover, and every trade is listed (click a trade number to jump the chart to it).
- **Live practice**: paper-trade on real Binance prices as they happen, in the browser or on an always-on server
  ([docs/server.md](docs/server.md)).
- **Make it yours**: dark and light themes, hide any panel or put it on the whole page, resize the divider, add chart
  overlays (moving averages, RSI, MACD, order blocks…).
- **Take it with you**: export trades (CSV), save the chart as a picture, copy a one-line summary, save and open
  strategies as files. Settings, blocks and layout are remembered in the browser.

## For beginners

Every control has a plain-English note: hover over it, or flip a switch and a short note says what it just did
(turn these off under **View → Helper notes**). **Help** has a quick start, a "what every button does" page, a word
list (drawdown, leverage, Sharpe…) and the shortcuts. **Tour** is a one-minute guided walk through the page.

### Keyboard shortcuts

| Keys | Does |
| --- | --- |
| `R` or `Ctrl`/`⌘` + `Enter` | Run the backtest |
| `1` `2` `3` `4` | Hide or show Strategy, Chart, Results, Live practice |
| `Shift` + `1` `2` `3` `4` | Put that panel on the whole page |
| `Esc` | Leave full page, or close a window |
| `T` | Dark / light |
| `H` or `?` | Help |
| `G` | Guided tour |

Plain letters never fire while you are typing in a box or working in the block editor.

## Develop

Needs Node 24 or newer.

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # unit tests (the server's SQLite tests need Node 24's node:sqlite API)
npm run typecheck
npm run build      # typecheck + production build into dist/
```

Source layout: `src/blocks` (Blockly blocks, compiler, starters), `src/engine` (broker and backtest engine),
`src/indicators`, `src/pine`, `src/live` (paper-trading sessions), `src/ui` (the page), `server/` (optional 24/7
server). Plain-English text for the whole interface lives in `src/ui/descriptions.ts` and `src/ui/helpContent.ts`;
colours are CSS variables in `src/style.css` (charts and Blockly follow them through `src/ui/theme.ts`).

Prices come from Binance public market data only. Blockly icons are served from `public/blockly-media/`, so the
page makes no requests to third-party servers except Binance.
