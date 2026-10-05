# Quant Trading Simulator — Design

Date: 2026-10-05. Status: approved in conversation (sections 1–4); section 5 filled with defaults.

## 1. Goal

A browser-only web app for building and simulating quant strategies:

- Scratch-style visual block editor (Blockly) for strategy logic.
- Chart rendered with TradingView **Lightweight Charts** (Apache 2.0).
- Users can compile **Pine Script v5 (subset)** into reusable indicator blocks, and use TradingView-formula built-in indicators.
- Binance crypto data. Modes: historical **backtest** and **live paper trading** (fake money).
- Futures-style account: long/short, leverage, fees, slippage, SL/TP.

## 2. Constraints that shaped the design

- TradingView Advanced Charts / Trading Platform do not support Pine and are licensed to companies only; the free widget exposes no data API. Therefore "Pine" is our own compiler, and "TradingView" means Lightweight Charts plus TradingView-formula indicators.
- Binance public market data works from the browser without an API key. Risk: geo-blocking in some regions. Mitigation: the data adapter is an interface; a fallback host (`data-api.binance.vision`, spot) can be swapped in.

## 3. Stack

Vite + TypeScript, Blockly, lightweight-charts (v5), Vitest. No backend. Persistence in IndexedDB (candle cache, live sessions) and localStorage (block workspace, Pine sources, settings).

## 4. Architecture (units, one purpose each)

| Unit | Responsibility | Depends on |
|---|---|---|
| `data/` | Binance REST klines (history) + websocket (live). Emits normalized `Candle {time, open, high, low, close, volume}`. Swappable adapter interface. | — |
| `indicators/` | Incremental built-ins with TradingView formulas: SMA, EMA, RMA, WMA, RSI, MACD, Bollinger Bands, ATR, Stochastic, VWAP, highest/lowest/change/tr, crossover/crossunder. O(1) update per bar. | — |
| `pine/` | Lexer, indentation-aware parser, AST, static analysis, JS code generator for the Pine subset. Output: an indicator `{inputs, outputs, step(bar)}`. | `indicators/` |
| `blocks/` | Blockly block definitions, toolbox, and generator that compiles the workspace to a strategy `step(ctx)` function. | `indicators/`, `pine/` (custom blocks) |
| `engine/` | Per-bar loop, broker (orders, fills, fees, slippage, margin), session state, stats. Runs in a Web Worker. | `data/`, compiled strategy |
| `ui/` | Layout, chart panel, stats panel, Pine editor, controls. | all |

The engine is bar-by-bar and event driven: backtest feeds historical candles, live feeds the websocket. Same code path.

## 5. Block language

Hat blocks: `when strategy starts` (once), `when a bar closes` (every closed candle).

Categories: Market (`product`, `timeframe`, OHLC with bar offset, `current price`, `volume`, `bar time`, `bar index`); Account (`balance`, `equity`, `position side/size`, `entry price`, `unrealized PnL`, `open order count`); Indicators (built-ins + Pine-compiled blocks); Logic/Math (if/else, repeat, comparisons, and/or/not, arithmetic, `crosses over/under`, min/max/abs); My variables (persist across bars like Pine `var`); Actions (`buy/sell` market or limit with size as % equity / USDT / quantity, `set stop-loss/take-profit`, `close position`, `cancel orders`, `log message`); Functions (Blockly procedures).

Rules:
- **No look-ahead.** Strategy sees only closed bars. `current price` = last close in backtest, live tick in live mode (tooltip says so).
- **Fill model.** Orders placed on a bar's close fill at the next bar's open (live: the new candle's open). Limit/stop orders fill when a later bar's high/low touches the price. Fees and slippage apply to every fill.

## 6. Pine subset (v1)

Supported: `//@version=5`, `indicator()`, `input.int/float/bool/source` (become block fields), variable declarations, `var`, `:=`, ternary, if/else, for, user functions (`f(x) =>`), history access `x[n]`, `na`/`nz`, `ta.*` (sma, ema, rma, wma, rsi, macd, bb, atr, stoch, crossover, crossunder, highest, lowest, change, tr), `math.*`, `plot()` (each plot becomes a block output and is drawn on the chart; multi-plot scripts get an output dropdown).

Unsupported in v1, reported with line number (never silently wrong): `strategy()`, `request.security`, arrays/maps/matrices, drawing objects, alerts, libraries, user-defined types.

Compilation: lexer → parser → AST → static pass (max history offset sizes per-series ring buffers; each `ta.*` call site gets its own state slot; `ta.*` inside conditionals/loops raises a warning) → JS `step(bar)`. JS is generated from the AST, never from raw text; identifiers are whitelisted so pasted scripts cannot reach `window` or the network.

Correctness: implement TradingView seeding (EMA seeded with SMA of first N bars; RSI/ATR via Wilder RMA). Warm-up bars may differ slightly from TradingView and converge after; the UI states this. Before writing the compiler, spike the open-source PineTS runtime; adopt it only if it fits the bar-by-bar engine.

## 7. Engine and broker

Per bar: (1) broker processes pending orders against the new bar (market at open; limit/stop vs high/low; SL/TP evaluated); (2) strategy runs on the closed bar and queues orders for the next bar.

Conservative tie-breaks: if a bar touches both SL and TP, SL is assumed first; a gap past a stop fills at the open, not the stop price.

Account: one net position per run (TradingView-style; opposite order reduces/flips). Equity = balance + unrealized PnL. Notional cap = equity × leverage. Orders needing more margin than free are rejected and logged. No liquidation engine; equity ≤ 0 stops the run, marked "account wiped". Defaults: taker fee 0.04% (market, stop), maker 0.02% (limit), slippage 2 bps on market orders; all editable. One product per run in v1.

Live paper trading = a backtest that never ends: replay from a chosen start through the same engine, then switch from REST to websocket on catching up. Each bar is persisted to IndexedDB; reopening the tab fetches missed candles and catches up deterministically.

Safety: strategy and Pine code run in a Web Worker with per-bar time and iteration limits (loop blocks capped at 10,000 iterations); the worker is terminated on timeout. A block exception halts the run and highlights the block.

## 8. UI

Top bar: product, timeframe, mode (Backtest / Live), start date, balance, leverage, fee, slippage, Run / Pause / Stop, replay speed.
Left pane (tabs): **Blocks** (Blockly workspace) and **Pine** (editor with compile errors inline, list of compiled blocks).
Right pane: Lightweight Charts (candles, indicator overlays and sub-panes, buy/sell markers, SL/TP lines) over a stats panel: equity curve, total return, max drawdown, win rate, profit factor, Sharpe (annualized by timeframe), trade count, exposure, trade list, log.
Layout collapses to tabs on narrow screens.

## 9. Testing

Vitest unit tests: each indicator vs hand-verified reference values; Pine lexer/parser/codegen on fixture scripts (including unsupported-feature errors); broker fill rules, fees, margin rejection, SL/TP tie-break, gap fills, position flip; engine determinism (same candles → identical trades). Data layer tested against recorded Binance fixtures. Manual browser check of the full flow at the end of each milestone.

## 10. Out of scope for v1

Multi-symbol strategies, multi-timeframe (`request.security`), Pine `strategy()` scripts, liquidation/funding simulation, real-money trading, backend/accounts, strategy sharing.

## 11. Milestones (build order)

1. Project scaffold, data layer, chart showing live and historical candles.
2. Indicator library + chart overlays.
3. Broker + engine + backtest with hard-coded strategy; stats panel.
4. Blockly editor + block-to-JS compiler; run block strategies.
5. Pine compiler (after PineTS spike); custom indicator blocks.
6. Live paper trading, persistence, catch-up.
7. Polish: errors, responsive layout, replay controls.
