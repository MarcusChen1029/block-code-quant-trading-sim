# Quant Trading Simulator Core (Milestones 1-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the browser-only core of the quant simulator: Binance futures candles (history + live) on a lightweight-charts v5 chart, an incremental TradingView-formula indicator library with chart overlays, and a deterministic per-bar broker/engine that backtests a hard-coded SMA-cross strategy in a Web Worker and shows stats, equity curve, trade list and trade markers.

**Architecture:** Five single-purpose layers under `src/`: `data/` (Candle type + swappable `MarketDataAdapter`, Binance implementation), `indicators/` (O(1)-per-bar Pine-style classes, NaN = `na`), `engine/` (Broker with one net position, `Engine` per-bar driver, stats, `Strategy`/`StrategyContext` interface that future Blockly/Pine/live code will target), `worker/` (pure request handler + Web Worker glue + promise client), `ui/` (chart wrapper, overlays, top bar, stats panel). Pure logic is unit-tested with Vitest in Node; DOM/canvas code is verified by `tsc` plus a manual browser checklist.

**Tech Stack:** Vite 8, TypeScript 7 (`tsc` native), Vitest 5 (node environment), lightweight-charts 5.2 (`addSeries(CandlestickSeries, …)`, `createSeriesMarkers`). No backend, no other runtime dependencies.

## Global Constraints

- Repo root: `C:\Users\user\Desktop\another shit` (path has a SPACE: quote it in every shell command, e.g. `cd "C:/Users/user/Desktop/another shit"`). Shell is Git Bash on Windows; never use `&&` in PowerShell.
- Before the first commit, run `git branch --show-current` and commit only on the feature branch the controller created (suggested `feat/quant-sim-core`); never commit straight to `master`.
- Versions verified 2026-10-05 against the installed packages: lightweight-charts 5.2.1, vite 8.3.2, vitest 5.0.3, typescript 7.0.2, Node 24. Do not add other dependencies.
- lightweight-charts v5 API (verified in `node_modules/lightweight-charts/dist/typings.d.ts`): `createChart(el, opts)`, `chart.addSeries(CandlestickSeries | LineSeries | HistogramSeries, options, paneIndex?)`, `createSeriesMarkers(series, markers)` returning `{ setMarkers(markers) }`, `chart.removeSeries(s)`, `chart.panes()`, `chart.removePane(i)`, `pane.setStretchFactor(n)`, `series.update(bar)`, `chart.timeScale().fitContent()`. Times passed to the chart are UTC **seconds** (`UTCTimestamp`); our `Candle.time` is epoch **milliseconds** (convert with `toChartTime`).
- Binance USD-M futures, public, no API key: REST `GET https://fapi.binance.com/fapi/v1/klines?symbol=&interval=&startTime=&endTime=&limit=1500` (rows of strings); websocket `wss://fstream.binance.com/market/ws/<symbol lowercase>@kline_<interval>` (the docs moved kline streams to the `/market` route; base URL is a constructor option so a fallback host can be swapped in).
- **No look-ahead.** Strategy sees only closed bars. `current price` = last close in backtest.
- **Fill model.** Orders placed on a bar's close fill at the next bar's open. Limit/stop orders fill when a later bar's high/low touches the price. Fees and slippage apply to fills (slippage on taker fills only, see below).
- Conservative tie-breaks: if a bar touches both SL and TP, SL is assumed first; a gap past a stop fills at the open, not the stop price.
- Account: one net position per run (TradingView-style; opposite order reduces/flips). Equity = balance + unrealized PnL. Notional cap = equity × leverage. Orders needing more margin than free are rejected and logged. No liquidation engine; equity ≤ 0 stops the run, marked "account wiped".
- Defaults: taker fee 0.04% (market, stop), maker 0.02% (limit), slippage 2 bps on market orders; all editable. One product per run in v1.
- Resolved ambiguities (apply everywhere): slippage applies to taker fills (market, stop, stop-loss), never to limit or take-profit fills; take-profit pays the maker fee, stop-loss the taker fee. `percentEquity` size = margin as % of equity (notional = margin × leverage, fee reserved inside the budget); `usdt` = notional; `qty` = base quantity. Intrabar order: market fills at open → SL/TP of the resulting position → resting limit/stop orders. Wipe check uses the bar close.
- Determinism: same candles + same config → identical `BacktestResult` (no `Date.now()`, no randomness inside `engine/` or `indicators/`).
- Indicators: TradingView seeding (EMA/RMA seeded with the SMA of the first N values; RSI/ATR via Wilder RMA). `NaN` is Pine's `na`; a NaN input returns NaN and does not advance state. O(1) (amortised) update per bar.
- Files stay small and single-purpose; tests sit beside the code as `*.test.ts` (Vitest include glob `src/**/*.test.ts`).
- Test commands: `npm test` runs everything; `npx vitest run <path>` runs one file. If the RTK proxy rewrites Vitest output to "JSON report written to …/.vitest/json/output.json", read `numPassedTests` / `numFailedTests` from that file (`node -e "const j=require('./.vitest/json/output.json');console.log(j.numPassedTests,j.numFailedTests)"`). `.vitest/` is git-ignored.
- Do NOT implement Blockly, Pine, live paper trading, persistence or replay controls; only keep the interfaces (`Strategy`, `StrategyContext`, `MarketDataAdapter`, `Engine.pushCandle`, `StrategySpec`) open for them.

---

## File Structure

```
package.json, tsconfig.json, vite.config.ts, index.html, .gitignore
src/main.ts                     app wiring (rewritten in Tasks 3, 6, 9)
src/style.css                   layout/theme (rewritten in Tasks 3, 6, 9)
src/data/types.ts               Candle, Timeframe, TIMEFRAMES, timeframeToMs, isTimeframe
src/data/adapter.ts             MarketDataAdapter, CandleSubscription
src/data/binance.ts             BinanceFuturesAdapter (REST pagination + websocket), parsers
src/indicators/types.ts         SeriesIndicator, Hlc, assertLength
src/indicators/window.ts        RingBuffer
src/indicators/averages.ts      Sma, Ema, Rma, Wma
src/indicators/extremes.ts      Highest, Lowest
src/indicators/primitives.ts    Change, TrueRange, CrossOver, CrossUnder
src/indicators/oscillators.ts   Rsi, Macd, Stochastic
src/indicators/bands.ts         Stdev, BollingerBands
src/indicators/volatility.ts    Atr
src/indicators/vwap.ts          Vwap
src/indicators/testing.ts       runSeries / expectSeries test helpers
src/engine/types.ts             orders, fills, trades, position, BrokerConfig, DEFAULT_BROKER_CONFIG
src/engine/broker.ts            Broker
src/engine/strategy.ts          Strategy, StrategyContext, EntryRequest, PriceField
src/engine/stats.ts             EquityPoint, Stats, computeStats
src/engine/engine.ts            Engine, runBacktest, EngineConfig, BacktestResult
src/engine/strategies/smaCross.ts  createSmaCross, SmaCrossParams, DEFAULT_SMA_CROSS
src/engine/syntheticCandles.ts  deterministic test candles
src/worker/protocol.ts          RunRequest, WorkerResponse, StrategySpec, handleRequest
src/worker/backtest.worker.ts   Worker glue
src/worker/client.ts            runBacktestInWorker
src/ui/chartData.ts             toChartTime, candleToBar, candleToVolume, colours
src/ui/chart.ts                 ChartPanel (rewritten in Tasks 6, 9)
src/ui/dom.ts                   h() element builder
src/ui/overlays.ts              OverlayDef, OVERLAYS, smaOverlay, emaOverlay, computeOverlaySeries
src/ui/overlayPicker.ts         renderOverlayPicker
src/ui/settings.ts              RawSettings, RunSettings, parseSettings, defaults, MAX_BARS
src/ui/format.ts                fmtNum, fmtPct, fmtTime, statsRows
src/ui/markers.ts               fillsToMarkers
src/ui/statsPanel.ts            StatsPanel
src/ui/topbar.ts                createTopBar
```

---

### Task 1: Project scaffold and Candle/Timeframe types

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `.gitignore`, `index.html`, `src/main.ts`
- Create: `src/data/types.ts`
- Test: `src/data/types.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (`src/data/types.ts`):
  - `interface Candle { time: number /* bar OPEN time, epoch ms UTC */; open: number; high: number; low: number; close: number; volume: number }`
  - `const TIMEFRAMES = ['1m','3m','5m','15m','30m','1h','2h','4h','6h','8h','12h','1d'] as const`; `type Timeframe = (typeof TIMEFRAMES)[number]`
  - `function isTimeframe(value: string): value is Timeframe`
  - `function timeframeToMs(tf: Timeframe): number`
  - npm scripts: `dev`, `build` (`tsc -p . && vite build`), `preview`, `test` (`vitest run`), `typecheck`.

- [ ] **Step 1: Create the project files**

`package.json`:

```json
{
  "name": "quant-sim",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -p . && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc -p ."
  },
  "dependencies": {
    "lightweight-charts": "^5.2.1"
  },
  "devDependencies": {
    "typescript": "^7.0.2",
    "vite": "^8.3.2",
    "vitest": "^5.0.3"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable", "WebWorker"],
    "strict": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

`.gitignore`:

```
node_modules/
dist/
.vitest/
```

`index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Quant Sim</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

`src/main.ts`:

```ts
const app = document.querySelector<HTMLDivElement>('#app');
if (app) app.textContent = 'Quant Sim: scaffold OK';
```

- [ ] **Step 2: Install dependencies**

Run: `cd "C:/Users/user/Desktop/another shit"; npm install`
Expected: ends with `added N packages` and no `ERR!` lines; `node_modules/lightweight-charts/package.json` has `"version": "5.x"`.

- [ ] **Step 3: Write the failing test** — `src/data/types.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { TIMEFRAMES, isTimeframe, timeframeToMs } from './types';

describe('timeframeToMs', () => {
  it('converts minute, hour and day timeframes', () => {
    expect(timeframeToMs('1m')).toBe(60_000);
    expect(timeframeToMs('15m')).toBe(900_000);
    expect(timeframeToMs('1h')).toBe(3_600_000);
    expect(timeframeToMs('4h')).toBe(14_400_000);
    expect(timeframeToMs('1d')).toBe(86_400_000);
  });

  it('has a duration for every listed timeframe', () => {
    for (const tf of TIMEFRAMES) expect(timeframeToMs(tf)).toBeGreaterThan(0);
  });
});

describe('isTimeframe', () => {
  it('accepts listed timeframes and rejects others', () => {
    expect(isTimeframe('1h')).toBe(true);
    expect(isTimeframe('7m')).toBe(false);
    expect(isTimeframe('1M')).toBe(false);
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run src/data/types.test.ts`
Expected: FAIL — `Failed to resolve import "./types"`.

- [ ] **Step 5: Implement** — `src/data/types.ts`

```ts
/** One OHLCV bar. `time` is the bar OPEN time in epoch milliseconds (UTC). */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Supported bar intervals (Binance interval strings). */
export const TIMEFRAMES = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '8h', '12h', '1d'] as const;

export type Timeframe = (typeof TIMEFRAMES)[number];

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export function isTimeframe(value: string): value is Timeframe {
  return (TIMEFRAMES as readonly string[]).includes(value);
}

/** Bar duration in milliseconds, e.g. '15m' -> 900000. */
export function timeframeToMs(tf: Timeframe): number {
  const amount = Number(tf.slice(0, -1));
  const unit = tf.slice(-1);
  return amount * UNIT_MS[unit];
}
```

- [ ] **Step 6: Run tests, typecheck and build**

Run: `npm test; npm run build`
Expected: 1 test file, 3 tests passed; `tsc` prints no errors; Vite prints `✓ built in …`.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add package.json package-lock.json tsconfig.json vite.config.ts .gitignore index.html src/main.ts src/data/types.ts src/data/types.test.ts
git commit -m "chore: scaffold Vite + TypeScript + Vitest; add Candle and Timeframe types"
```

---

### Task 2: Binance futures data adapter (REST history + websocket stream)

**Files:**
- Create: `src/data/adapter.ts`, `src/data/binance.ts`
- Test: `src/data/binance.test.ts`

**Interfaces:**
- Consumes: `Candle`, `Timeframe`, `timeframeToMs` from `src/data/types.ts`.
- Produces:
  - `src/data/adapter.ts`: `interface CandleSubscription { close(): void }`; `interface MarketDataAdapter { readonly name: string; fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]>; subscribeCandles(symbol: string, tf: Timeframe, onCandle: (candle: Candle, closed: boolean) => void, onError?: (error: Error) => void): CandleSubscription }`
  - `src/data/binance.ts`: `const BINANCE_MAX_LIMIT = 1500`; `type BinanceKlineRow`; `interface WebSocketLike { onmessage: ((ev: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; close(): void }`; `interface BinanceAdapterOptions { restBase?; wsBase?; fetchFn?: (url: string) => Promise<Response>; wsFactory?: (url: string) => WebSocketLike; now?: () => number; reconnectDelayMs?: number }`; `function parseKlineRow(row: BinanceKlineRow): Candle`; `function parseKlineMessage(data: string): { candle: Candle; closed: boolean } | null`; `class BinanceFuturesAdapter implements MarketDataAdapter { constructor(options?: BinanceAdapterOptions) }`.
  - Behaviour: `fetchCandles` paginates by 1500, returns only CLOSED bars (close time < now), ascending, no duplicates; throws `Binance HTTP <status>: <body>`. `subscribeCandles` reconnects after `reconnectDelayMs` (default 3000) until `close()`.

- [ ] **Step 1: Write the failing test** — `src/data/binance.test.ts` (fixtures recorded from the live API on 2026-10-05)

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  BinanceFuturesAdapter,
  BINANCE_MAX_LIMIT,
  parseKlineMessage,
  parseKlineRow,
  type BinanceKlineRow,
  type WebSocketLike,
} from './binance';

// Recorded from GET https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2 (2026-10-05)
const RECORDED_ROWS: BinanceKlineRow[] = [
  [1791172800000, '86050.20', '86107.00', '85448.70', '85500.00', '11166.988', 1791176399999, '957328993.75470', 193260, '5038.520', '431876711.84260', '0'],
  [1791176400000, '85500.00', '85751.70', '85369.00', '85734.10', '6976.275', 1791179999999, '596963669.57250', 125316, '4083.423', '349447215.99690', '0'],
];

// Shape documented for wss://fstream.binance.com/market/ws/<symbol>@kline_<interval>
const RECORDED_WS_MESSAGE = JSON.stringify({
  e: 'kline', E: 1791176460000, s: 'BTCUSDT',
  k: {
    t: 1791176400000, T: 1791179999999, s: 'BTCUSDT', i: '1h', f: 1, L: 2,
    o: '85500.00', c: '85734.10', h: '85751.70', l: '85369.00', v: '6976.275',
    n: 125316, x: false, q: '596963669.57250', V: '4083.423', Q: '349447215.99690', B: '0',
  },
});

const HOUR = 3_600_000;

/** Fake /fapi/v1/klines: one 1h bar per hour from `firstOpen`, `count` bars total, honours startTime/endTime/limit. */
function fakeKlinesServer(firstOpen: number, count: number) {
  const calls: string[] = [];
  const fetchFn = vi.fn(async (input: string) => {
    calls.push(input);
    const url = new URL(input);
    const start = Number(url.searchParams.get('startTime'));
    const end = Number(url.searchParams.get('endTime'));
    const limit = Number(url.searchParams.get('limit'));
    const rows: BinanceKlineRow[] = [];
    for (let i = 0; i < count && rows.length < limit; i++) {
      const t = firstOpen + i * HOUR;
      if (t < start || t > end) continue;
      const p = String(100 + i);
      rows.push([t, p, p, p, p, '1', t + HOUR - 1, '0', 1, '0', '0', '0']);
    }
    return new Response(JSON.stringify(rows), { status: 200 });
  });
  return { fetchFn, calls };
}

describe('parseKlineRow', () => {
  it('converts a recorded REST row into a numeric Candle', () => {
    expect(parseKlineRow(RECORDED_ROWS[0])).toEqual({
      time: 1791172800000, open: 86050.2, high: 86107, low: 85448.7, close: 85500, volume: 11166.988,
    });
  });
});

describe('parseKlineMessage', () => {
  it('parses a raw kline stream message', () => {
    expect(parseKlineMessage(RECORDED_WS_MESSAGE)).toEqual({
      candle: { time: 1791176400000, open: 85500, high: 85751.7, low: 85369, close: 85734.1, volume: 6976.275 },
      closed: false,
    });
  });

  it('unwraps combined-stream messages', () => {
    const wrapped = JSON.stringify({ stream: 'btcusdt@kline_1h', data: JSON.parse(RECORDED_WS_MESSAGE) });
    expect(parseKlineMessage(wrapped)?.candle.close).toBe(85734.1);
  });

  it('returns null for non-kline messages', () => {
    expect(parseKlineMessage('{"result":null,"id":1}')).toBeNull();
    expect(parseKlineMessage('not json')).toBeNull();
  });
});

describe('BinanceFuturesAdapter.fetchCandles', () => {
  it('builds the futures klines URL', async () => {
    const { fetchFn, calls } = fakeKlinesServer(0, 2);
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => 10 * HOUR });
    await adapter.fetchCandles('BTCUSDT', '1h', 0, HOUR);
    expect(calls[0]).toBe(
      `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&startTime=0&endTime=${HOUR}&limit=${BINANCE_MAX_LIMIT}`,
    );
  });

  it('paginates past the 1500-row limit without gaps or duplicates', async () => {
    const total = 3200;
    const { fetchFn } = fakeKlinesServer(0, total);
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => (total + 10) * HOUR });
    const candles = await adapter.fetchCandles('BTCUSDT', '1h', 0, (total - 1) * HOUR);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(candles).toHaveLength(total);
    for (let i = 0; i < total; i++) expect(candles[i].time).toBe(i * HOUR);
  });

  it('drops the still-forming last candle', async () => {
    const { fetchFn } = fakeKlinesServer(0, 5);
    // now is inside bar 4 (opened at 4h, closes at 5h - 1)
    const adapter = new BinanceFuturesAdapter({ fetchFn, now: () => 4 * HOUR + 1000 });
    const candles = await adapter.fetchCandles('BTCUSDT', '1h', 0, 10 * HOUR);
    expect(candles.map((c) => c.time)).toEqual([0, HOUR, 2 * HOUR, 3 * HOUR]);
  });

  it('throws with status and body on HTTP errors', async () => {
    const fetchFn = vi.fn(async () => new Response('{"code":-1121,"msg":"Invalid symbol."}', { status: 400 }));
    const adapter = new BinanceFuturesAdapter({ fetchFn });
    await expect(adapter.fetchCandles('NOPE', '1h', 0, HOUR)).rejects.toThrow('Binance HTTP 400: {"code":-1121,"msg":"Invalid symbol."}');
  });
});

class FakeSocket implements WebSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {}
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

describe('BinanceFuturesAdapter.subscribeCandles', () => {
  it('connects to the market kline stream and forwards parsed candles', () => {
    const sockets: FakeSocket[] = [];
    const adapter = new BinanceFuturesAdapter({ wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; } });
    const received: Array<[number, boolean]> = [];
    adapter.subscribeCandles('BTCUSDT', '1h', (c, closed) => received.push([c.close, closed]));
    expect(sockets[0].url).toBe('wss://fstream.binance.com/market/ws/btcusdt@kline_1h');
    sockets[0].onmessage?.({ data: RECORDED_WS_MESSAGE });
    expect(received).toEqual([[85734.1, false]]);
  });

  it('reconnects after an unexpected close but not after close()', () => {
    vi.useFakeTimers();
    try {
      const sockets: FakeSocket[] = [];
      const adapter = new BinanceFuturesAdapter({
        reconnectDelayMs: 1000,
        wsFactory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
      });
      const sub = adapter.subscribeCandles('ETHUSDT', '5m', () => {});
      sockets[0].onclose?.(); // server dropped us
      vi.advanceTimersByTime(1000);
      expect(sockets).toHaveLength(2);
      sub.close();
      expect(sockets[1].closed).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(sockets).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/data/binance.test.ts`
Expected: FAIL — `Failed to resolve import "./binance"`.

- [ ] **Step 3: Implement the adapter interface** — `src/data/adapter.ts`

```ts
import type { Candle, Timeframe } from './types';

/** Handle returned by a live subscription; call close() to stop receiving candles. */
export interface CandleSubscription {
  close(): void;
}

/**
 * Swappable market-data source. Binance futures is the default implementation;
 * a spot fallback (data-api.binance.vision) can implement the same interface.
 */
export interface MarketDataAdapter {
  readonly name: string;
  /** Closed candles whose open time is in [startMs, endMs], ascending, no duplicates. */
  fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]>;
  /**
   * Streams the forming candle. `closed` is true exactly once per bar, on its final update.
   * The adapter reconnects on its own until close() is called.
   */
  subscribeCandles(
    symbol: string,
    tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    onError?: (error: Error) => void,
  ): CandleSubscription;
}
```

- [ ] **Step 4: Implement the Binance adapter** — `src/data/binance.ts`

```ts
import type { CandleSubscription, MarketDataAdapter } from './adapter';
import { timeframeToMs, type Candle, type Timeframe } from './types';

/** Max rows per /fapi/v1/klines request. */
export const BINANCE_MAX_LIMIT = 1500;

/** REST kline row: [openTime, open, high, low, close, volume, closeTime, ...ignored]. Prices are strings. */
export type BinanceKlineRow = [number, string, string, string, string, string, number, ...unknown[]];

/** Minimal socket surface we use; lets tests inject a fake. */
export interface WebSocketLike {
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface BinanceAdapterOptions {
  restBase?: string;
  wsBase?: string;
  fetchFn?: (url: string) => Promise<Response>;
  wsFactory?: (url: string) => WebSocketLike;
  now?: () => number;
  reconnectDelayMs?: number;
}

export function parseKlineRow(row: BinanceKlineRow): Candle {
  return {
    time: row[0],
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
  };
}

interface KlinePayload {
  t: number; o: string; h: string; l: string; c: string; v: string; x: boolean;
}

/** Parses a kline stream message (raw or combined-stream). Returns null for anything else. */
export function parseKlineMessage(data: string): { candle: Candle; closed: boolean } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (msg && typeof msg === 'object' && 'data' in msg) msg = (msg as { data: unknown }).data;
  if (!msg || typeof msg !== 'object' || (msg as { e?: unknown }).e !== 'kline') return null;
  const k = (msg as { k: KlinePayload }).k;
  return {
    candle: { time: k.t, open: Number(k.o), high: Number(k.h), low: Number(k.l), close: Number(k.c), volume: Number(k.v) },
    closed: k.x,
  };
}

function browserSocket(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = { onmessage: null, onclose: null, onerror: null, close: () => ws.close() };
  ws.onmessage = (ev) => like.onmessage?.({ data: ev.data });
  ws.onclose = () => like.onclose?.();
  ws.onerror = () => like.onerror?.();
  return like;
}

/** Binance USD-M futures public market data (no API key). */
export class BinanceFuturesAdapter implements MarketDataAdapter {
  readonly name = 'binance-futures';
  private readonly restBase: string;
  private readonly wsBase: string;
  private readonly fetchFn: (url: string) => Promise<Response>;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private readonly now: () => number;
  private readonly reconnectDelayMs: number;

  constructor(options: BinanceAdapterOptions = {}) {
    this.restBase = options.restBase ?? 'https://fapi.binance.com';
    this.wsBase = options.wsBase ?? 'wss://fstream.binance.com/market/ws';
    this.fetchFn = options.fetchFn ?? ((url) => fetch(url));
    this.wsFactory = options.wsFactory ?? browserSocket;
    this.now = options.now ?? (() => Date.now());
    this.reconnectDelayMs = options.reconnectDelayMs ?? 3000;
  }

  async fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
    const step = timeframeToMs(tf);
    const out: Candle[] = [];
    let cursor = startMs;
    while (cursor <= endMs) {
      const url =
        `${this.restBase}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}` +
        `&startTime=${cursor}&endTime=${endMs}&limit=${BINANCE_MAX_LIMIT}`;
      const res = await this.fetchFn(url);
      if (!res.ok) throw new Error(`Binance HTTP ${res.status}: ${await res.text()}`);
      const rows = (await res.json()) as BinanceKlineRow[];
      if (rows.length === 0) break;
      const nowMs = this.now();
      for (const row of rows) {
        if (row[6] >= nowMs) continue; // bar not closed yet
        if (out.length > 0 && row[0] <= out[out.length - 1].time) continue;
        out.push(parseKlineRow(row));
      }
      if (rows.length < BINANCE_MAX_LIMIT) break;
      cursor = rows[rows.length - 1][0] + step;
    }
    return out;
  }

  subscribeCandles(
    symbol: string,
    tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    onError?: (error: Error) => void,
  ): CandleSubscription {
    const url = `${this.wsBase}/${symbol.toLowerCase()}@kline_${tf}`;
    let stopped = false;
    let socket: WebSocketLike | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      socket = this.wsFactory(url);
      socket.onmessage = (ev) => {
        const parsed = typeof ev.data === 'string' ? parseKlineMessage(ev.data) : null;
        if (parsed) onCandle(parsed.candle, parsed.closed);
      };
      socket.onerror = () => onError?.(new Error(`WebSocket error on ${url}`));
      socket.onclose = () => {
        if (!stopped) timer = setTimeout(connect, this.reconnectDelayMs);
      };
    };
    connect();

    return {
      close: () => {
        stopped = true;
        if (timer !== null) clearTimeout(timer);
        socket?.close();
      },
    };
  }
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/data; npm run typecheck`
Expected: 2 files, 13 tests passed; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/data/adapter.ts src/data/binance.ts src/data/binance.test.ts
git commit -m "feat(data): Binance futures adapter with paginated klines and kline websocket"
```

---

### Task 3: Candle chart with history and live updates (milestone 1)

**Files:**
- Create: `src/ui/chartData.ts`, `src/ui/chart.ts`, `src/style.css`
- Modify (full rewrite): `index.html`, `src/main.ts`
- Test: `src/ui/chartData.test.ts`

**Interfaces:**
- Consumes: `Candle`, `Timeframe`, `isTimeframe`, `timeframeToMs` (Task 1); `BinanceFuturesAdapter` (Task 2).
- Produces:
  - `src/ui/chartData.ts`: `const UP_COLOR = '#26a69a'`, `const DOWN_COLOR = '#ef5350'`; `function toChartTime(ms: number): UTCTimestamp`; `function candleToBar(c: Candle): CandlestickData<UTCTimestamp>`; `function candleToVolume(c: Candle): HistogramData<UTCTimestamp>`.
  - `src/ui/chart.ts`: `class ChartPanel { constructor(container: HTMLElement); setCandles(candles: readonly Candle[]): void; fit(): void; updateCandle(candle: Candle): void; destroy(): void }`.
  - `index.html` containers used by later tasks: `#topbar`, `#main` > `#chart` + `#stats`, `#status`.

- [ ] **Step 1: Write the failing test** — `src/ui/chartData.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { candleToBar, candleToVolume, toChartTime } from './chartData';
import type { Candle } from '../data/types';

const up: Candle = { time: 1791172800000, open: 100, high: 110, low: 95, close: 105, volume: 12.5 };
const down: Candle = { time: 1791176400000, open: 105, high: 106, low: 90, close: 91, volume: 3 };

describe('chartData', () => {
  it('converts epoch ms to chart seconds', () => {
    expect(toChartTime(1791172800000)).toBe(1791172800);
  });

  it('maps a candle to a candlestick bar', () => {
    expect(candleToBar(up)).toEqual({ time: 1791172800, open: 100, high: 110, low: 95, close: 105 });
  });

  it('colours volume bars by candle direction', () => {
    expect(candleToVolume(up)).toEqual({ time: 1791172800, value: 12.5, color: 'rgba(38,166,154,0.5)' });
    expect(candleToVolume(down)).toEqual({ time: 1791176400, value: 3, color: 'rgba(239,83,80,0.5)' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/chartData.test.ts`
Expected: FAIL — `Failed to resolve import "./chartData"`.

- [ ] **Step 3: Implement the mappers** — `src/ui/chartData.ts`

```ts
import type { CandlestickData, HistogramData, UTCTimestamp } from 'lightweight-charts';
import type { Candle } from '../data/types';

export const UP_COLOR = '#26a69a';
export const DOWN_COLOR = '#ef5350';

/** lightweight-charts wants UTC seconds; our Candle.time is epoch ms. */
export function toChartTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

export function candleToBar(c: Candle): CandlestickData<UTCTimestamp> {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
}

export function candleToVolume(c: Candle): HistogramData<UTCTimestamp> {
  return {
    time: toChartTime(c.time),
    value: c.volume,
    color: c.close >= c.open ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/chartData.test.ts`
Expected: 3 tests passed.

- [ ] **Step 5: Implement the chart wrapper** — `src/ui/chart.ts`

Note: `fit()` waits for a non-zero container width because `autoSize` applies the real width asynchronously; calling `fitContent()` on a zero-width chart leaves the bars squeezed to the right.

```ts
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import type { Candle } from '../data/types';
import { DOWN_COLOR, UP_COLOR, candleToBar, candleToVolume } from './chartData';

/** Thin wrapper around a lightweight-charts v5 chart: candles + volume on pane 0. */
export class ChartPanel {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private lastTime = -Infinity;

  constructor(private readonly container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: '', priceFormat: { type: 'volume' } });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  /** Replaces all candles and fits the view. */
  setCandles(candles: readonly Candle[]): void {
    this.candles.setData(candles.map(candleToBar));
    this.volume.setData(candles.map(candleToVolume));
    this.lastTime = candles.length > 0 ? candles[candles.length - 1].time : -Infinity;
    this.fit();
  }

  /**
   * Fits all bars into view. If the container has no width yet (hidden tab/pane), waits until it gets one:
   * autoSize applies the real width asynchronously and fitContent on a zero-width chart is a no-op.
   */
  fit(): void {
    const fitNow = () => requestAnimationFrame(() => this.chart.timeScale().fitContent());
    if (this.container.clientWidth > 0) {
      fitNow();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (this.container.clientWidth === 0) return;
      observer.disconnect();
      fitNow();
    });
    observer.observe(this.container);
  }

  /** Updates the forming bar or appends a new one. Older bars are ignored (the library throws on them). */
  updateCandle(candle: Candle): void {
    if (candle.time < this.lastTime) return;
    this.candles.update(candleToBar(candle));
    this.volume.update(candleToVolume(candle));
    this.lastTime = candle.time;
  }

  destroy(): void {
    this.chart.remove();
  }
}
```

- [ ] **Step 6: Page layout and styles** — replace `index.html`, create `src/style.css`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Quant Sim</title>
  </head>
  <body>
    <header id="topbar"></header>
    <main id="main">
      <div id="chart"></div>
      <section id="stats"></section>
    </main>
    <footer id="status">Loading…</footer>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: #131722;
  color: #d1d4dc;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
  display: flex;
  flex-direction: column;
}
#topbar { padding: 6px 10px; border-bottom: 1px solid #2a2e39; }
#main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#chart { flex: 1; min-height: 300px; }
#stats { border-top: 1px solid #2a2e39; }
#status { padding: 4px 10px; border-top: 1px solid #2a2e39; color: #787b86; }
#status.error { color: #ef5350; }
```

- [ ] **Step 7: Wire history + live stream** — replace `src/main.ts` (`?symbol=ETHUSDT&tf=15m` query params select the market)

```ts
import './style.css';
import { BinanceFuturesAdapter } from './data/binance';
import { isTimeframe, timeframeToMs, type Timeframe } from './data/types';
import { ChartPanel } from './ui/chart';

const HISTORY_BARS = 500;

function setStatus(text: string, isError = false): void {
  const status = document.getElementById('status')!;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const symbol = (params.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const tfParam = params.get('tf') ?? '1h';
  const tf: Timeframe = isTimeframe(tfParam) ? tfParam : '1h';

  const adapter = new BinanceFuturesAdapter();
  const chart = new ChartPanel(document.getElementById('chart')!);

  const end = Date.now();
  const start = end - HISTORY_BARS * timeframeToMs(tf);
  const candles = await adapter.fetchCandles(symbol, tf, start, end);
  chart.setCandles(candles);
  setStatus(`${symbol} ${tf}: ${candles.length} bars loaded, streaming live…`);

  adapter.subscribeCandles(
    symbol,
    tf,
    (candle) => chart.updateCandle(candle),
    (err) => setStatus(err.message, true),
  );
}

main().catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
```

- [ ] **Step 8: Typecheck, test, build**

Run: `npm test; npm run build`
Expected: all tests pass (3 files, 16 tests); build succeeds.

- [ ] **Step 9: Manual browser check (milestone 1)**

Run: `npm run dev` and open `http://localhost:5173/?symbol=BTCUSDT&tf=1m`.
Expected:
- [ ] ~500 candles fill the full chart width with volume bars along the bottom.
- [ ] Footer reads `BTCUSDT 1m: N bars loaded, streaming live…`.
- [ ] Within ~10 s the last candle moves (live websocket); after the minute rolls over a new candle appears.
- [ ] `?symbol=NOPE` shows a red footer starting with `Binance HTTP 400`.
Stop the dev server (Ctrl+C).

- [ ] **Step 10: Commit**

```bash
git add index.html src/main.ts src/style.css src/ui/chartData.ts src/ui/chartData.test.ts src/ui/chart.ts
git commit -m "feat(ui): candle chart with Binance history and live kline updates"
```

---

### Task 4: Indicator primitives — moving averages, extremes, change/tr/cross

**Files:**
- Create: `src/indicators/types.ts`, `src/indicators/window.ts`, `src/indicators/averages.ts`, `src/indicators/extremes.ts`, `src/indicators/primitives.ts`, `src/indicators/testing.ts`
- Test: `src/indicators/window.test.ts`, `src/indicators/averages.test.ts`, `src/indicators/extremes.test.ts`, `src/indicators/primitives.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `types.ts`: `interface SeriesIndicator { update(value: number): number }`; `interface Hlc { high: number; low: number; close: number }`; `function assertLength(length: number): void` (throws `length must be a positive integer, got X`).
  - `window.ts`: `class RingBuffer { constructor(capacity: number); readonly capacity; get size(): number; get full(): boolean; push(value: number): number /* evicted or NaN */; get(offset: number): number /* 0 = newest */; sum(): number }`.
  - `averages.ts`: `class Sma`, `class Ema`, `class Rma`, `class Wma` — each `constructor(length: number)`, `update(value: number): number`, `readonly length`.
  - `extremes.ts`: `class Highest`, `class Lowest` — `constructor(length: number)`, `update(value: number): number`.
  - `primitives.ts`: `class Change { constructor(length = 1); update(value: number): number }`; `class TrueRange { constructor(handleNa = false); update(bar: Hlc): number }`; `class CrossOver { update(a: number, b: number): boolean }`; `class CrossUnder { update(a: number, b: number): boolean }`.
  - `testing.ts` (tests only): `runSeries(indicator: SeriesIndicator, values: number[]): number[]`; `expectSeries(actual: number[], expected: number[], digits = 6): void` (NaN expected ⇒ must be NaN).

- [ ] **Step 1: Write the test helper** — `src/indicators/testing.ts`

```ts
import { expect } from 'vitest';
import type { SeriesIndicator } from './types';

/** Test helper: feeds values one bar at a time and collects the outputs. */
export function runSeries(indicator: SeriesIndicator, values: number[]): number[] {
  return values.map((v) => indicator.update(v));
}

/** Test helper: element-wise toBeCloseTo, where NaN in `expected` means "must be NaN (na)". */
export function expectSeries(actual: number[], expected: number[], digits = 6): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((a, i) => {
    if (Number.isNaN(expected[i])) expect(a, `index ${i}`).toBeNaN();
    else expect(a, `index ${i}`).toBeCloseTo(expected[i], digits);
  });
}
```

- [ ] **Step 2: Write the failing tests** (expected values are hand-computed in the comments)

`src/indicators/window.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RingBuffer } from './window';

describe('RingBuffer', () => {
  it('keeps the newest values and reports evictions', () => {
    const rb = new RingBuffer(3);
    expect(rb.push(1)).toBeNaN();
    expect(rb.push(2)).toBeNaN();
    expect(rb.full).toBe(false);
    expect(rb.push(3)).toBeNaN();
    expect(rb.full).toBe(true);
    expect(rb.push(4)).toBe(1);
    expect([rb.get(0), rb.get(1), rb.get(2)]).toEqual([4, 3, 2]);
    expect(rb.get(3)).toBeNaN();
    expect(rb.sum()).toBe(9);
    expect(rb.size).toBe(3);
  });
});
```

`src/indicators/averages.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Ema, Rma, Sma, Wma } from './averages';
import { expectSeries, runSeries } from './testing';

const NA = NaN;
const SRC = [2, 4, 6, 8, 10, 6];

describe('Sma', () => {
  it('averages the last N values', () => {
    // (2+4+6)/3=4, (4+6+8)/3=6, (6+8+10)/3=8, (8+10+6)/3=8
    expectSeries(runSeries(new Sma(3), SRC), [NA, NA, 4, 6, 8, 8]);
  });

  it('cancels floating-point drift within one window', () => {
    const out = runSeries(new Sma(2), [1e17, 1, 1, 1, 1]);
    expect(out[4]).toBe(1);
  });

  it('rejects invalid lengths', () => {
    expect(() => new Sma(0)).toThrow('length must be a positive integer');
  });
});

describe('Ema', () => {
  it('is seeded with the SMA of the first N values, then alpha = 2/(N+1)', () => {
    // seed (2+4+6)/3=4; alpha=0.5: 0.5*8+0.5*4=6; 0.5*10+0.5*6=8; 0.5*6+0.5*8=7
    expectSeries(runSeries(new Ema(3), SRC), [NA, NA, 4, 6, 8, 7]);
  });

  it('skips leading na inputs without advancing', () => {
    // seed (1+3)/2=2; alpha=2/3: (2/3)*5+(1/3)*2=4
    expectSeries(runSeries(new Ema(2), [NA, NA, 1, 3, 5]), [NA, NA, NA, 2, 4]);
  });
});

describe('Rma', () => {
  it('is seeded with the SMA, then alpha = 1/N (Wilder)', () => {
    // seed 4; (8+2*4)/3=16/3; (10+2*16/3)/3=62/9; (6+2*62/9)/3=178/27
    expectSeries(runSeries(new Rma(3), SRC), [NA, NA, 4, 16 / 3, 62 / 9, 178 / 27]);
  });
});

describe('Wma', () => {
  it('weights the newest value most', () => {
    // (1*1+2*2+3*3)/6=14/6; (1*2+2*3+3*4)/6=20/6; (1*3+2*4+3*5)/6=26/6
    expectSeries(runSeries(new Wma(3), [1, 2, 3, 4, 5]), [NA, NA, 14 / 6, 20 / 6, 26 / 6]);
  });
});
```

`src/indicators/extremes.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Highest, Lowest } from './extremes';
import { expectSeries, runSeries } from './testing';

const NA = NaN;
const SRC = [3, 1, 4, 1, 5, 9, 2, 6];

describe('Highest', () => {
  it('returns the max of the last N values', () => {
    expectSeries(runSeries(new Highest(3), SRC), [NA, NA, 4, 4, 5, 9, 9, 9]);
  });
});

describe('Lowest', () => {
  it('returns the min of the last N values', () => {
    expectSeries(runSeries(new Lowest(3), SRC), [NA, NA, 1, 1, 1, 1, 2, 2]);
  });

  it('stays correct after internal compaction on long runs', () => {
    const values = Array.from({ length: 5000 }, (_, i) => i);
    const out = runSeries(new Lowest(3), values);
    expect(out[4999]).toBe(4997);
  });
});
```

`src/indicators/primitives.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Change, CrossOver, CrossUnder, TrueRange } from './primitives';
import { expectSeries, runSeries } from './testing';

const NA = NaN;

describe('Change', () => {
  it('returns source - source[length]', () => {
    expectSeries(runSeries(new Change(), [1, 3, 6]), [NA, 2, 3]);
    expectSeries(runSeries(new Change(2), [1, 3, 6]), [NA, NA, 5]);
  });
});

describe('TrueRange', () => {
  const bars = [
    { high: 10, low: 8, close: 9 },
    { high: 12, low: 9, close: 11 }, // max(3, |12-9|=3, |9-9|=0) = 3
    { high: 11, low: 7, close: 8 }, //  max(4, |11-11|=0, |7-11|=4) = 4
  ];

  it('is na on the first bar by default (ta.tr)', () => {
    const tr = new TrueRange();
    expectSeries(bars.map((b) => tr.update(b)), [NA, 3, 4]);
  });

  it('uses high - low on the first bar when handleNa is true (ta.tr(true))', () => {
    const tr = new TrueRange(true);
    expectSeries(bars.map((b) => tr.update(b)), [2, 3, 4]);
  });
});

describe('CrossOver / CrossUnder', () => {
  const a = [1, 2, 3, 2, 1];
  const b = [2, 2, 2, 2, 2];

  it('crossover fires when a goes from <= b to > b', () => {
    const x = new CrossOver();
    expect(a.map((v, i) => x.update(v, b[i]))).toEqual([false, false, true, false, false]);
  });

  it('crossunder fires when a goes from >= b to < b', () => {
    const x = new CrossUnder();
    expect(a.map((v, i) => x.update(v, b[i]))).toEqual([false, false, false, false, true]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/indicators`
Expected: 4 files FAIL — `Failed to resolve import` for `./window`, `./averages`, `./extremes`, `./primitives` respectively.

- [ ] **Step 4: Implement shared types and the ring buffer**

`src/indicators/types.ts`:

```ts
/**
 * A Pine-style series function, updated exactly once per CLOSED bar (O(1) per update).
 * NaN plays the role of Pine's `na`: returned during warm-up. A NaN input returns NaN
 * for that bar and does NOT advance the indicator's state.
 */
export interface SeriesIndicator {
  update(value: number): number;
}

/** The bar fields indicators like ATR and Stochastic need (a Candle satisfies it). */
export interface Hlc {
  high: number;
  low: number;
  close: number;
}

export function assertLength(length: number): void {
  if (!Number.isInteger(length) || length < 1) throw new Error(`length must be a positive integer, got ${length}`);
}
```

`src/indicators/window.ts`:

```ts
/** Fixed-capacity FIFO of numbers. get(0) is the newest value. */
export class RingBuffer {
  private readonly buf: Float64Array;
  private head = 0; // index of the next write
  private count = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count === this.capacity;
  }

  /** Appends a value; returns the evicted oldest value, or NaN if nothing was evicted. */
  push(value: number): number {
    const evicted = this.full ? this.buf[this.head] : NaN;
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (!this.full) this.count++;
    return evicted;
  }

  /** offset 0 = newest, 1 = previous, ... NaN when out of range. */
  get(offset: number): number {
    if (offset < 0 || offset >= this.count) return NaN;
    return this.buf[(this.head - 1 - offset + 2 * this.capacity) % this.capacity];
  }

  /** Sum of all stored values (O(capacity); used to cancel float drift). */
  sum(): number {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.get(i);
    return s;
  }
}
```

- [ ] **Step 5: Implement the averages** — `src/indicators/averages.ts`

```ts
import { assertLength, type SeriesIndicator } from './types';
import { RingBuffer } from './window';

/** ta.sma: arithmetic mean of the last `length` values. */
export class Sma implements SeriesIndicator {
  private readonly window: RingBuffer;
  private total = 0;
  private sinceResync = 0;

  constructor(readonly length: number) {
    assertLength(length);
    this.window = new RingBuffer(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    const evicted = this.window.push(value);
    this.total += Number.isNaN(evicted) ? value : value - evicted;
    // Recompute the exact sum once per window to stop floating-point drift (amortised O(1)).
    if (++this.sinceResync >= this.length) {
      this.total = this.window.sum();
      this.sinceResync = 0;
    }
    return this.window.full ? this.total / this.length : NaN;
  }
}

/** Exponential smoothing seeded with the SMA of the first `length` values (TradingView seeding). */
class SeededSmoothing implements SeriesIndicator {
  private readonly seed: Sma;
  private value = NaN;

  constructor(readonly length: number, private readonly alpha: number) {
    this.seed = new Sma(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (Number.isNaN(this.value)) {
      this.value = this.seed.update(value);
      return this.value;
    }
    this.value = this.alpha * value + (1 - this.alpha) * this.value;
    return this.value;
  }
}

/** ta.ema: alpha = 2 / (length + 1). */
export class Ema extends SeededSmoothing {
  constructor(length: number) {
    super(length, 2 / (length + 1));
  }
}

/** ta.rma (Wilder): alpha = 1 / length. Used by RSI and ATR. */
export class Rma extends SeededSmoothing {
  constructor(length: number) {
    super(length, 1 / length);
  }
}

/** ta.wma: linearly weighted, newest value has weight `length`, oldest weight 1. */
export class Wma implements SeriesIndicator {
  private readonly window: RingBuffer;
  private readonly denominator: number;
  private total = 0;
  private weighted = 0;

  constructor(readonly length: number) {
    assertLength(length);
    this.window = new RingBuffer(length);
    this.denominator = (length * (length + 1)) / 2;
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (!this.window.full) {
      this.window.push(value);
      this.total += value;
      this.weighted += this.window.size * value;
      return this.window.full ? this.weighted / this.denominator : NaN;
    }
    const evicted = this.window.push(value);
    // Shifting every weight down by one subtracts the old total; the new value enters with weight `length`.
    this.weighted = this.weighted - this.total + this.length * value;
    this.total = this.total - evicted + value;
    return this.weighted / this.denominator;
  }
}
```

- [ ] **Step 6: Implement highest/lowest** — `src/indicators/extremes.ts`

```ts
import { assertLength, type SeriesIndicator } from './types';

/** Sliding-window extreme via a monotonic deque: amortised O(1) per update. */
class MonotonicWindow implements SeriesIndicator {
  private readonly idx: number[] = [];
  private readonly val: number[] = [];
  private head = 0;
  private seen = 0;

  constructor(readonly length: number, private readonly keeps: (older: number, incoming: number) => boolean) {
    assertLength(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    const i = this.seen++;
    while (this.val.length > this.head && !this.keeps(this.val[this.val.length - 1], value)) {
      this.val.pop();
      this.idx.pop();
    }
    this.val.push(value);
    this.idx.push(i);
    while (this.idx[this.head] <= i - this.length) this.head++;
    if (this.head > 1024 && this.head * 2 > this.idx.length) {
      this.idx.splice(0, this.head);
      this.val.splice(0, this.head);
      this.head = 0;
    }
    return this.seen >= this.length ? this.val[this.head] : NaN;
  }
}

/** ta.highest(source, length): max of the last `length` values including the current one. */
export class Highest extends MonotonicWindow {
  constructor(length: number) {
    super(length, (older, incoming) => older > incoming);
  }
}

/** ta.lowest(source, length): min of the last `length` values including the current one. */
export class Lowest extends MonotonicWindow {
  constructor(length: number) {
    super(length, (older, incoming) => older < incoming);
  }
}
```

- [ ] **Step 7: Implement change, true range and crosses** — `src/indicators/primitives.ts`

```ts
import { assertLength, type Hlc, type SeriesIndicator } from './types';
import { RingBuffer } from './window';

/** ta.change(source, length): source - source[length]. */
export class Change implements SeriesIndicator {
  private readonly window: RingBuffer;

  constructor(readonly length = 1) {
    assertLength(length);
    this.window = new RingBuffer(length + 1);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    this.window.push(value);
    return this.window.full ? value - this.window.get(this.length) : NaN;
  }
}

/**
 * ta.tr(handle_na): max(high - low, |high - close[1]|, |low - close[1]|).
 * On the first bar close[1] is na: returns high - low if handleNa, else NaN (Pine's `ta.tr` variable).
 */
export class TrueRange {
  private prevClose = NaN;

  constructor(private readonly handleNa = false) {}

  update(bar: Hlc): number {
    const pc = this.prevClose;
    this.prevClose = bar.close;
    if (Number.isNaN(pc)) return this.handleNa ? bar.high - bar.low : NaN;
    return Math.max(bar.high - bar.low, Math.abs(bar.high - pc), Math.abs(bar.low - pc));
  }
}

/** ta.crossover(a, b): a > b on this bar and a <= b on the previous bar. */
export class CrossOver {
  private prevA = NaN;
  private prevB = NaN;

  update(a: number, b: number): boolean {
    const result = this.prevA <= this.prevB && a > b;
    this.prevA = a;
    this.prevB = b;
    return result;
  }
}

/** ta.crossunder(a, b): a < b on this bar and a >= b on the previous bar. */
export class CrossUnder {
  private prevA = NaN;
  private prevB = NaN;

  update(a: number, b: number): boolean {
    const result = this.prevA >= this.prevB && a < b;
    this.prevA = a;
    this.prevB = b;
    return result;
  }
}
```

- [ ] **Step 8: Run tests and typecheck**

Run: `npx vitest run src/indicators; npm run typecheck`
Expected: 4 files, 16 tests passed; no type errors.

- [ ] **Step 9: Commit**

```bash
git add src/indicators
git commit -m "feat(indicators): incremental SMA/EMA/RMA/WMA, highest/lowest, change, tr, crossover/crossunder"
```

---

### Task 5: Indicators — RSI, MACD, Stochastic, Bollinger Bands, ATR, VWAP

**Files:**
- Create: `src/indicators/oscillators.ts`, `src/indicators/bands.ts`, `src/indicators/volatility.ts`, `src/indicators/vwap.ts`
- Test: `src/indicators/oscillators.test.ts`, `src/indicators/bands.test.ts`, `src/indicators/volatility.test.ts`, `src/indicators/vwap.test.ts`

**Interfaces:**
- Consumes: `Sma`, `Ema`, `Rma` (`averages.ts`); `Highest`, `Lowest` (`extremes.ts`); `TrueRange` (`primitives.ts`); `RingBuffer` (`window.ts`); `SeriesIndicator`, `Hlc`, `assertLength` (`types.ts`); `runSeries`, `expectSeries` (`testing.ts`); `Candle` (`src/data/types.ts`).
- Produces:
  - `oscillators.ts`: `class Rsi implements SeriesIndicator { constructor(length = 14) }`; `interface MacdValue { macd: number; signal: number; hist: number }`; `class Macd { constructor(fastLength = 12, slowLength = 26, signalLength = 9); update(value: number): MacdValue }`; `interface StochValue { k: number; d: number }`; `class Stochastic { constructor(periodK = 14, smoothK = 1, periodD = 3); update(bar: Hlc): StochValue }`.
  - `bands.ts`: `class Stdev implements SeriesIndicator { constructor(length: number); get average(): number }` (population stdev); `interface BandsValue { middle: number; upper: number; lower: number }`; `class BollingerBands { constructor(length = 20, mult = 2); update(value: number): BandsValue }`.
  - `volatility.ts`: `class Atr { constructor(length = 14); update(bar: Hlc): number }`.
  - `vwap.ts`: `class Vwap { update(candle: Candle): number }` (hlc3, resets each UTC day).

- [ ] **Step 1: Write the failing tests** (reference values hand-computed; MACD/BB/RSI cross-checked with an independent array implementation)

`src/indicators/oscillators.test.ts`:

```ts
import { describe, it } from 'vitest';
import { Macd, Rsi, Stochastic } from './oscillators';
import { expectSeries, runSeries } from './testing';

const NA = NaN;

describe('Rsi', () => {
  it('matches the Wilder formula with RMA seeding', () => {
    // gains/losses from bar 1: +1, +1, -1, +2. RMA(2) seed at bar 2: up=1, down=0 -> 100.
    // bar 3: up=0.5*0+0.5*1=0.5, down=0.5*1+0.5*0=0.5 -> 50.
    // bar 4: up=0.5*2+0.5*0.5=1.25, down=0.5*0+0.5*0.5=0.25 -> rs=5 -> 100-100/6=83.3333
    expectSeries(runSeries(new Rsi(2), [1, 2, 3, 2, 4]), [NA, NA, 100, 50, 83.333333]);
  });
});

describe('Macd', () => {
  it('computes macd, signal and histogram', () => {
    // EMA2 (alpha 2/3) of [1,2,4,8,16,32]: -,1.5,3.166667,6.388889,12.796296,25.598765
    // EMA3 (alpha 1/2): -,-,2.333333,5.166667,10.583333,21.291667
    // signal = EMA2 of macd, seeded at bar 3 with (0.833333+1.222222)/2
    const m = new Macd(2, 3, 2);
    const out = [1, 2, 4, 8, 16, 32].map((v) => m.update(v));
    expectSeries(out.map((o) => o.macd), [NA, NA, 0.833333, 1.222222, 2.212963, 4.307099], 5);
    expectSeries(out.map((o) => o.signal), [NA, NA, NA, 1.027778, 1.817901, 3.477366], 5);
    expectSeries(out.map((o) => o.hist), [NA, NA, NA, 0.194444, 0.395062, 0.829733], 5);
  });
});

describe('Stochastic', () => {
  it('computes %K and %D', () => {
    const bars = [
      { high: 10, low: 8, close: 9 },
      { high: 12, low: 9, close: 11 },
      { high: 11, low: 7, close: 8 }, // hh=12, ll=7: 100*(8-7)/5 = 20
      { high: 13, low: 10, close: 12 }, // hh=13, ll=7: 100*(12-7)/6 = 83.3333
    ];
    const st = new Stochastic(3, 1, 2);
    const out = bars.map((b) => st.update(b));
    expectSeries(out.map((o) => o.k), [NA, NA, 20, 83.333333]);
    expectSeries(out.map((o) => o.d), [NA, NA, NA, 51.666667]);
  });

  it('returns na when the range is zero', () => {
    const st = new Stochastic(2, 1, 1);
    const flat = { high: 5, low: 5, close: 5 };
    expectSeries([st.update(flat), st.update(flat)].map((o) => o.k), [NA, NA]);
  });
});
```

`src/indicators/bands.test.ts`:

```ts
import { describe, it } from 'vitest';
import { BollingerBands, Stdev } from './bands';
import { expectSeries, runSeries } from './testing';

const NA = NaN;

describe('Stdev', () => {
  it('is the population standard deviation of the window', () => {
    // [1,2,3]: var=2/3 -> 0.816497; [2,3,4]: same; [3,4,10]: mean 17/3, var=28.666667/3 -> 3.091206
    expectSeries(runSeries(new Stdev(3), [1, 2, 3, 4, 10]), [NA, NA, 0.816497, 0.816497, 3.091206]);
  });
});

describe('BollingerBands', () => {
  it('returns middle ± mult * stdev', () => {
    const bb = new BollingerBands(3, 2);
    const out = [1, 2, 3, 4, 10].map((v) => bb.update(v));
    expectSeries(out.map((o) => o.middle), [NA, NA, 2, 3, 5.666667]);
    expectSeries(out.map((o) => o.upper), [NA, NA, 3.632993, 4.632993, 11.849079]);
    expectSeries(out.map((o) => o.lower), [NA, NA, 0.367007, 1.367007, -0.515746]);
  });
});
```

`src/indicators/volatility.test.ts`:

```ts
import { describe, it } from 'vitest';
import { Atr } from './volatility';
import { expectSeries } from './testing';

const NA = NaN;

describe('Atr', () => {
  it('is the RMA of true range, first TR = high - low', () => {
    const bars = [
      { high: 10, low: 8, close: 9 }, // TR 2
      { high: 12, low: 9, close: 11 }, // TR 3
      { high: 11, low: 7, close: 8 }, // TR 4
    ];
    const atr = new Atr(2);
    // seed (2+3)/2 = 2.5; then 0.5*4 + 0.5*2.5 = 3.25
    expectSeries(bars.map((b) => atr.update(b)), [NA, 2.5, 3.25]);
  });
});
```

`src/indicators/vwap.test.ts`:

```ts
import { describe, it } from 'vitest';
import { Vwap } from './vwap';
import { expectSeries } from './testing';

const NA = NaN;
const DAY = 86_400_000;

describe('Vwap', () => {
  it('accumulates hlc3 * volume and resets at each UTC day', () => {
    const vwap = new Vwap();
    const out = [
      { time: 0, open: 9, high: 10, low: 8, close: 9, volume: 2 }, // hlc3 9 -> 9
      { time: 3_600_000, open: 9, high: 12, low: 9, close: 12, volume: 1 }, // hlc3 11 -> (18+11)/3
      { time: DAY, open: 19, high: 20, low: 18, close: 19, volume: 5 }, // new day -> 19
      { time: 2 * DAY, open: 19, high: 20, low: 18, close: 19, volume: 0 }, // new day, no volume -> na
    ].map((c) => vwap.update(c));
    expectSeries(out, [9, 29 / 3, 19, NA]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/indicators`
Expected: the 4 new files FAIL with `Failed to resolve import` (`./oscillators`, `./bands`, `./volatility`, `./vwap`); the Task 4 files still pass.

- [ ] **Step 3: Implement RSI, MACD, Stochastic** — `src/indicators/oscillators.ts`

```ts
import { Ema, Rma, Sma } from './averages';
import { Highest, Lowest } from './extremes';
import type { Hlc, SeriesIndicator } from './types';

/** ta.rsi(source, length): Wilder RSI using RMA of gains and losses. */
export class Rsi implements SeriesIndicator {
  private readonly up: Rma;
  private readonly down: Rma;
  private prev = NaN;

  constructor(readonly length = 14) {
    this.up = new Rma(length);
    this.down = new Rma(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    const prev = this.prev;
    this.prev = value;
    if (Number.isNaN(prev)) return NaN; // first bar: change is na
    const up = this.up.update(Math.max(value - prev, 0));
    const down = this.down.update(Math.max(prev - value, 0));
    if (Number.isNaN(up) || Number.isNaN(down)) return NaN;
    if (down === 0) return 100;
    if (up === 0) return 0;
    return 100 - 100 / (1 + up / down);
  }
}

export interface MacdValue {
  macd: number;
  signal: number;
  hist: number;
}

/** ta.macd(source, fast, slow, signal): EMA(fast) - EMA(slow), signal = EMA(macd). */
export class Macd {
  private readonly fast: Ema;
  private readonly slow: Ema;
  private readonly signal: Ema;

  constructor(fastLength = 12, slowLength = 26, signalLength = 9) {
    this.fast = new Ema(fastLength);
    this.slow = new Ema(slowLength);
    this.signal = new Ema(signalLength);
  }

  update(value: number): MacdValue {
    const macd = this.fast.update(value) - this.slow.update(value);
    const signal = this.signal.update(macd); // NaN macd is skipped, so the signal seeds on the first valid values
    return { macd, signal, hist: macd - signal };
  }
}

export interface StochValue {
  k: number;
  d: number;
}

/**
 * TradingView "Stoch": raw = 100 * (close - lowest(low, periodK)) / (highest(high, periodK) - lowest(low, periodK)),
 * %K = sma(raw, smoothK), %D = sma(%K, periodD). A zero range gives na.
 */
export class Stochastic {
  private readonly highest: Highest;
  private readonly lowest: Lowest;
  private readonly smoothK: Sma;
  private readonly smoothD: Sma;

  constructor(periodK = 14, smoothK = 1, periodD = 3) {
    this.highest = new Highest(periodK);
    this.lowest = new Lowest(periodK);
    this.smoothK = new Sma(smoothK);
    this.smoothD = new Sma(periodD);
  }

  update(bar: Hlc): StochValue {
    const hh = this.highest.update(bar.high);
    const ll = this.lowest.update(bar.low);
    const range = hh - ll;
    const raw = range === 0 ? NaN : (100 * (bar.close - ll)) / range;
    const k = this.smoothK.update(raw);
    const d = this.smoothD.update(k);
    return { k, d };
  }
}
```

- [ ] **Step 4: Implement Stdev and Bollinger Bands** — `src/indicators/bands.ts`

```ts
import { assertLength, type SeriesIndicator } from './types';
import { RingBuffer } from './window';

/** ta.stdev(source, length) with biased=true (population standard deviation), sliding Welford update. */
export class Stdev implements SeriesIndicator {
  private readonly window: RingBuffer;
  private mean = 0;
  private m2 = 0; // sum of squared deviations from the mean

  constructor(readonly length: number) {
    assertLength(length);
    this.window = new RingBuffer(length);
  }

  /** Mean of the current window (valid once the window is full). */
  get average(): number {
    return this.window.full ? this.mean : NaN;
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    if (!this.window.full) {
      this.window.push(value);
      const n = this.window.size;
      const delta = value - this.mean;
      this.mean += delta / n;
      this.m2 += delta * (value - this.mean);
    } else {
      const old = this.window.push(value);
      const oldMean = this.mean;
      this.mean += (value - old) / this.length;
      this.m2 += (value - old) * (value - this.mean + old - oldMean);
    }
    return this.window.full ? Math.sqrt(Math.max(this.m2, 0) / this.length) : NaN;
  }
}

export interface BandsValue {
  middle: number;
  upper: number;
  lower: number;
}

/** ta.bb(source, length, mult): middle = sma, bands = middle ± mult * stdev. */
export class BollingerBands {
  private readonly stdev: Stdev;

  constructor(readonly length = 20, readonly mult = 2) {
    this.stdev = new Stdev(length);
  }

  update(value: number): BandsValue {
    const sd = this.stdev.update(value);
    if (Number.isNaN(sd)) return { middle: NaN, upper: NaN, lower: NaN };
    const middle = this.stdev.average;
    return { middle, upper: middle + this.mult * sd, lower: middle - this.mult * sd };
  }
}
```

- [ ] **Step 5: Implement ATR** — `src/indicators/volatility.ts`

```ts
import { Rma } from './averages';
import { TrueRange } from './primitives';
import type { Hlc } from './types';

/** ta.atr(length) = rma(ta.tr(true), length). */
export class Atr {
  private readonly tr = new TrueRange(true);
  private readonly rma: Rma;

  constructor(readonly length = 14) {
    this.rma = new Rma(length);
  }

  update(bar: Hlc): number {
    return this.rma.update(this.tr.update(bar));
  }
}
```

- [ ] **Step 6: Implement VWAP** — `src/indicators/vwap.ts`

```ts
import type { Candle } from '../data/types';

const DAY_MS = 86_400_000;

/** ta.vwap(hlc3) anchored to the UTC day (TradingView's default "Session" anchor for 24/7 crypto). */
export class Vwap {
  private day = NaN;
  private priceVolume = 0;
  private volume = 0;

  update(candle: Candle): number {
    const day = Math.floor(candle.time / DAY_MS);
    if (day !== this.day) {
      this.day = day;
      this.priceVolume = 0;
      this.volume = 0;
    }
    const hlc3 = (candle.high + candle.low + candle.close) / 3;
    this.priceVolume += hlc3 * candle.volume;
    this.volume += candle.volume;
    return this.volume === 0 ? NaN : this.priceVolume / this.volume;
  }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run src/indicators; npm run typecheck`
Expected: 8 files, 24 tests passed; no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/indicators
git commit -m "feat(indicators): RSI, MACD, Stochastic, Bollinger Bands, ATR, VWAP with TradingView seeding"
```

---

### Task 6: Indicator overlays on the chart (milestone 2)

**Files:**
- Create: `src/ui/overlays.ts`, `src/ui/dom.ts`, `src/ui/overlayPicker.ts`
- Modify (full rewrite): `src/ui/chart.ts`, `src/main.ts`, `src/style.css`
- Test: `src/ui/overlays.test.ts`

**Interfaces:**
- Consumes: all indicator classes (Tasks 4-5); `toChartTime`, `UP_COLOR`, `DOWN_COLOR`, `candleToBar`, `candleToVolume` (Task 3); `Candle` (Task 1).
- Produces:
  - `overlays.ts`: `interface OverlayLine { key: string; color: string }`; `interface OverlayDef { id: string; label: string; pane: 'price' | 'sub'; lines: OverlayLine[]; create(): (candle: Candle) => Record<string, number> }`; `type OverlayPoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>`; `function smaOverlay(length: number, color: string, id = \`sma${length}\`): OverlayDef`; `function emaOverlay(length: number, color: string, id = \`ema${length}\`): OverlayDef`; `const OVERLAYS: readonly OverlayDef[]` (ids `sma20, ema50, bb20, vwap, rsi14, macd, atr14, stoch`); `function overlayPoint(timeMs: number, value: number): OverlayPoint`; `function computeOverlaySeries(def: OverlayDef, candles: readonly Candle[], step = def.create()): Record<string, OverlayPoint[]>`.
  - `dom.ts`: `function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string | undefined>, ...children: Array<Node | string>): HTMLElementTagNameMap[K]`.
  - `overlayPicker.ts`: `function renderOverlayPicker(container: HTMLElement, defs: readonly OverlayDef[], initial: readonly string[], onChange: (ids: string[]) => void): void`.
  - `ChartPanel` gains: `setOverlays(defs: readonly OverlayDef[], candles: readonly Candle[]): void` (removes old overlay series and extra panes; each `'sub'` overlay gets its own pane) and `updateOverlays(candle: Candle): void` (one CLOSED candle, O(1) per overlay).

- [ ] **Step 1: Write the failing test** — `src/ui/overlays.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { OVERLAYS, computeOverlaySeries, overlayPoint, smaOverlay } from './overlays';

const HOUR = 3_600_000;
const candles: Candle[] = [10, 20, 30, 40].map((close, i) => ({
  time: i * HOUR, open: close, high: close + 1, low: close - 1, close, volume: 1,
}));

describe('overlayPoint', () => {
  it('turns NaN into a whitespace point', () => {
    expect(overlayPoint(HOUR, NaN)).toEqual({ time: 3600 });
    expect(overlayPoint(HOUR, 5)).toEqual({ time: 3600, value: 5 });
  });
});

describe('computeOverlaySeries', () => {
  it('computes an SMA line with warm-up gaps', () => {
    const series = computeOverlaySeries(smaOverlay(2, '#fff'), candles);
    expect(series.value).toEqual([{ time: 0 }, { time: 3600, value: 15 }, { time: 7200, value: 25 }, { time: 10800, value: 35 }]);
  });

  it('produces one array per line key, one point per candle, for every built-in overlay', () => {
    for (const def of OVERLAYS) {
      const series = computeOverlaySeries(def, candles);
      expect(Object.keys(series).sort()).toEqual(def.lines.map((l) => l.key).sort());
      for (const line of def.lines) expect(series[line.key]).toHaveLength(candles.length);
    }
  });

  it('has unique overlay ids', () => {
    const ids = OVERLAYS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ui/overlays.test.ts`
Expected: FAIL — `Failed to resolve import "./overlays"`.

- [ ] **Step 3: Implement overlay definitions** — `src/ui/overlays.ts`

```ts
import type { LineData, UTCTimestamp, WhitespaceData } from 'lightweight-charts';
import type { Candle } from '../data/types';
import { Ema, Sma } from '../indicators/averages';
import { BollingerBands } from '../indicators/bands';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Atr } from '../indicators/volatility';
import { Vwap } from '../indicators/vwap';
import { toChartTime } from './chartData';

export interface OverlayLine {
  key: string;
  color: string;
}

/** A chart overlay: which pane it lives in, its lines, and an incremental stepper factory. */
export interface OverlayDef {
  id: string;
  label: string;
  pane: 'price' | 'sub';
  lines: OverlayLine[];
  /** Returns a fresh stepper. Call it once per CLOSED candle; it returns one value per line key (NaN = na). */
  create(): (candle: Candle) => Record<string, number>;
}

export type OverlayPoint = LineData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

export function smaOverlay(length: number, color: string, id = `sma${length}`): OverlayDef {
  return {
    id, label: `SMA ${length}`, pane: 'price', lines: [{ key: 'value', color }],
    create() { const sma = new Sma(length); return (c) => ({ value: sma.update(c.close) }); },
  };
}

export function emaOverlay(length: number, color: string, id = `ema${length}`): OverlayDef {
  return {
    id, label: `EMA ${length}`, pane: 'price', lines: [{ key: 'value', color }],
    create() { const ema = new Ema(length); return (c) => ({ value: ema.update(c.close) }); },
  };
}

/** Overlays offered in the picker. */
export const OVERLAYS: readonly OverlayDef[] = [
  smaOverlay(20, '#f5c542'),
  emaOverlay(50, '#42a5f5'),
  {
    id: 'bb20', label: 'BB 20 2', pane: 'price',
    lines: [{ key: 'upper', color: '#7e57c2' }, { key: 'middle', color: '#b39ddb' }, { key: 'lower', color: '#7e57c2' }],
    create() { const bb = new BollingerBands(20, 2); return (c) => ({ ...bb.update(c.close) }); },
  },
  {
    id: 'vwap', label: 'VWAP', pane: 'price', lines: [{ key: 'value', color: '#ff9800' }],
    create() { const vwap = new Vwap(); return (c) => ({ value: vwap.update(c) }); },
  },
  {
    id: 'rsi14', label: 'RSI 14', pane: 'sub', lines: [{ key: 'value', color: '#ab47bc' }],
    create() { const rsi = new Rsi(14); return (c) => ({ value: rsi.update(c.close) }); },
  },
  {
    id: 'macd', label: 'MACD 12 26 9', pane: 'sub',
    lines: [{ key: 'macd', color: '#2962ff' }, { key: 'signal', color: '#ff6d00' }, { key: 'hist', color: '#26a69a' }],
    create() { const macd = new Macd(12, 26, 9); return (c) => ({ ...macd.update(c.close) }); },
  },
  {
    id: 'atr14', label: 'ATR 14', pane: 'sub', lines: [{ key: 'value', color: '#ef5350' }],
    create() { const atr = new Atr(14); return (c) => ({ value: atr.update(c) }); },
  },
  {
    id: 'stoch', label: 'Stoch 14 1 3', pane: 'sub',
    lines: [{ key: 'k', color: '#2962ff' }, { key: 'd', color: '#ff6d00' }],
    create() { const st = new Stochastic(14, 1, 3); return (c) => ({ ...st.update(c) }); },
  },
];

/** NaN becomes a whitespace point so the line has a gap instead of a bogus value. */
export function overlayPoint(timeMs: number, value: number): OverlayPoint {
  const time = toChartTime(timeMs);
  return Number.isFinite(value) ? { time, value } : { time };
}

/**
 * Runs `step` (default: a fresh stepper) over all candles; returns one point array per line key.
 * Pass your own stepper to keep feeding it live candles afterwards.
 */
export function computeOverlaySeries(
  def: OverlayDef,
  candles: readonly Candle[],
  step: (candle: Candle) => Record<string, number> = def.create(),
): Record<string, OverlayPoint[]> {
  const out: Record<string, OverlayPoint[]> = {};
  for (const line of def.lines) out[line.key] = [];
  for (const c of candles) {
    const values = step(c);
    for (const line of def.lines) out[line.key].push(overlayPoint(c.time, values[line.key]));
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/ui/overlays.test.ts`
Expected: 4 tests passed.

- [ ] **Step 5: DOM helper and overlay picker**

`src/ui/dom.ts`:

```ts
/** Tiny DOM builder: h('label', { class: 'x' }, 'text', child). Attributes with undefined values are skipped. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) if (value !== undefined) el.setAttribute(name, value);
  el.append(...children);
  return el;
}
```

`src/ui/overlayPicker.ts`:

```ts
import { h } from './dom';
import type { OverlayDef } from './overlays';

/** Renders one checkbox per overlay into `container`; calls onChange with the checked ids. */
export function renderOverlayPicker(
  container: HTMLElement,
  defs: readonly OverlayDef[],
  initial: readonly string[],
  onChange: (ids: string[]) => void,
): void {
  const boxes: HTMLInputElement[] = [];
  const wrap = h('span', { class: 'overlay-picker' });
  for (const def of defs) {
    const box = h('input', { type: 'checkbox', value: def.id });
    box.checked = initial.includes(def.id);
    box.addEventListener('change', () => onChange(boxes.filter((b) => b.checked).map((b) => b.value)));
    boxes.push(box);
    wrap.append(h('label', {}, box, def.label));
  }
  container.append(wrap);
}
```

- [ ] **Step 6: Add overlay support to the chart** — replace `src/ui/chart.ts`

```ts
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from 'lightweight-charts';
import type { Candle } from '../data/types';
import { DOWN_COLOR, UP_COLOR, candleToBar, candleToVolume } from './chartData';
import { computeOverlaySeries, overlayPoint, type OverlayDef } from './overlays';

interface ActiveOverlay {
  def: OverlayDef;
  step: (candle: Candle) => Record<string, number>;
  series: Record<string, ISeriesApi<'Line'>>;
}

/** Thin wrapper around a lightweight-charts v5 chart: candles + volume on pane 0, overlays on pane 0 or sub-panes. */
export class ChartPanel {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private overlays: ActiveOverlay[] = [];
  private lastTime = -Infinity;

  constructor(private readonly container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: '', priceFormat: { type: 'volume' } });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  /** Replaces all candles and fits the view. Call setOverlays afterwards to recompute overlays. */
  setCandles(candles: readonly Candle[]): void {
    this.candles.setData(candles.map(candleToBar));
    this.volume.setData(candles.map(candleToVolume));
    this.lastTime = candles.length > 0 ? candles[candles.length - 1].time : -Infinity;
    this.fit();
  }

  /**
   * Fits all bars into view. If the container has no width yet (hidden tab/pane), waits until it gets one:
   * autoSize applies the real width asynchronously and fitContent on a zero-width chart is a no-op.
   */
  fit(): void {
    const fitNow = () => requestAnimationFrame(() => this.chart.timeScale().fitContent());
    if (this.container.clientWidth > 0) {
      fitNow();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (this.container.clientWidth === 0) return;
      observer.disconnect();
      fitNow();
    });
    observer.observe(this.container);
  }

  /** Updates the forming bar or appends a new one. Older bars are ignored (the library throws on them). */
  updateCandle(candle: Candle): void {
    if (candle.time < this.lastTime) return;
    this.candles.update(candleToBar(candle));
    this.volume.update(candleToVolume(candle));
    this.lastTime = candle.time;
  }

  /** Removes every overlay and draws `defs` computed over `candles`. Sub-pane overlays get one pane each. */
  setOverlays(defs: readonly OverlayDef[], candles: readonly Candle[]): void {
    for (const o of this.overlays) for (const s of Object.values(o.series)) this.chart.removeSeries(s);
    this.overlays = [];
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);

    let nextPane = 1;
    for (const def of defs) {
      const paneIndex = def.pane === 'price' ? 0 : nextPane++;
      const step = def.create();
      const points = computeOverlaySeries(def, candles, step);
      const series: Record<string, ISeriesApi<'Line'>> = {};
      for (const line of def.lines) {
        series[line.key] = this.chart.addSeries(
          LineSeries,
          {
            color: line.color,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            title: line.key === 'value' ? def.label : line.key,
          },
          paneIndex,
        );
        series[line.key].setData(points[line.key]);
      }
      this.overlays.push({ def, step, series });
    }
    const panes = this.chart.panes();
    if (panes.length > 1) panes[0].setStretchFactor(3);
  }

  /** Feeds one newly CLOSED candle to every overlay (O(1) per overlay). */
  updateOverlays(candle: Candle): void {
    for (const o of this.overlays) {
      const values = o.step(candle);
      for (const line of o.def.lines) o.series[line.key].update(overlayPoint(candle.time, values[line.key]));
    }
  }

  destroy(): void {
    this.chart.remove();
  }
}
```

- [ ] **Step 7: Wire the picker and live overlay updates** — replace `src/main.ts` and `src/style.css`

```ts
import './style.css';
import { BinanceFuturesAdapter } from './data/binance';
import { isTimeframe, timeframeToMs, type Candle, type Timeframe } from './data/types';
import { ChartPanel } from './ui/chart';
import { renderOverlayPicker } from './ui/overlayPicker';
import { OVERLAYS } from './ui/overlays';

const HISTORY_BARS = 500;

function setStatus(text: string, isError = false): void {
  const status = document.getElementById('status')!;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const symbol = (params.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const tfParam = params.get('tf') ?? '1h';
  const tf: Timeframe = isTimeframe(tfParam) ? tfParam : '1h';

  const adapter = new BinanceFuturesAdapter();
  const chart = new ChartPanel(document.getElementById('chart')!);

  const end = Date.now();
  const start = end - HISTORY_BARS * timeframeToMs(tf);
  const candles: Candle[] = await adapter.fetchCandles(symbol, tf, start, end);
  chart.setCandles(candles);

  let activeIds: string[] = ['sma20'];
  const applyOverlays = () => chart.setOverlays(OVERLAYS.filter((d) => activeIds.includes(d.id)), candles);
  applyOverlays();
  renderOverlayPicker(document.getElementById('topbar')!, OVERLAYS, activeIds, (ids) => {
    activeIds = ids;
    applyOverlays();
  });
  setStatus(`${symbol} ${tf}: ${candles.length} bars loaded, streaming live…`);

  adapter.subscribeCandles(
    symbol,
    tf,
    (candle, closed) => {
      chart.updateCandle(candle);
      if (closed && (candles.length === 0 || candle.time > candles[candles.length - 1].time)) {
        candles.push(candle);
        chart.updateOverlays(candle);
      }
    },
    (err) => setStatus(err.message, true),
  );
}

main().catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
```

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: #131722;
  color: #d1d4dc;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
  display: flex;
  flex-direction: column;
}
#topbar { padding: 6px 10px; border-bottom: 1px solid #2a2e39; }
#main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#chart { flex: 1; min-height: 300px; }
#stats { border-top: 1px solid #2a2e39; }
#status { padding: 4px 10px; border-top: 1px solid #2a2e39; color: #787b86; }
#status.error { color: #ef5350; }
.overlay-picker label { margin-right: 10px; white-space: nowrap; cursor: pointer; }
```

- [ ] **Step 8: Typecheck, test, build**

Run: `npm test; npm run build`
Expected: 12 files, 44 tests passed; build succeeds.

- [ ] **Step 9: Manual browser check (milestone 2)**

Run: `npm run dev`, open `http://localhost:5173/?symbol=ETHUSDT&tf=5m`.
Expected:
- [ ] A checkbox row (SMA 20, EMA 50, BB 20 2, VWAP, RSI 14, MACD 12 26 9, ATR 14, Stoch 14 1 3) sits above the chart; SMA 20 is drawn by default with gaps only during warm-up.
- [ ] Ticking RSI 14 adds a sub-pane under the price pane; ticking MACD adds a second sub-pane with three lines; unticking removes the pane.
- [ ] BB 20 2 draws three lines around price; VWAP restarts at 00:00 UTC.
- [ ] After a 5m candle closes, every visible overlay extends by one point without a page reload.
Stop the dev server.

- [ ] **Step 10: Commit**

```bash
git add src/ui/overlays.ts src/ui/overlays.test.ts src/ui/dom.ts src/ui/overlayPicker.ts src/ui/chart.ts src/main.ts src/style.css
git commit -m "feat(ui): indicator overlays with sub-panes and incremental live updates"
```

---

### Task 7: Broker — orders, fills, fees, slippage, SL/TP, margin, net position

**Files:**
- Create: `src/engine/types.ts`, `src/engine/broker.ts`
- Test: `src/engine/broker.test.ts`

**Interfaces:**
- Consumes: `Candle` (Task 1).
- Produces:
  - `types.ts`: `type Side = 'buy' | 'sell'`; `type OrderType = 'market' | 'limit' | 'stop'`; `type SizeUnit = 'percentEquity' | 'usdt' | 'qty'`; `interface OrderRequest { side: Side; type: OrderType; size: number; unit: SizeUnit; price?: number; reduceOnly?: boolean }`; `interface Order extends OrderRequest { id: number; placedBar: number; placedTime: number }`; `type FillReason = 'market' | 'limit' | 'stop' | 'stopLoss' | 'takeProfit' | 'wiped'`; `interface Fill { orderId: number | null; bar: number; time: number; side: Side; qty: number; price: number; fee: number; reason: FillReason }`; `interface Trade { side: 'long' | 'short'; qty: number; entryBar: number; entryTime: number; entryPrice: number; exitBar: number; exitTime: number; exitPrice: number; pnl: number; fees: number; netPnl: number; exitReason: FillReason }`; `interface PositionView { side: 'long' | 'short' | 'flat'; qty: number /* signed */; entryPrice: number /* NaN flat */; stopLoss: number | null; takeProfit: number | null }`; `interface LogEntry { bar: number; time: number; level: 'info' | 'warn' | 'error'; message: string }`; `interface BrokerConfig { initialBalance: number; leverage: number; takerFee: number; makerFee: number; slippageBps: number }` (fees are fractions: 0.0004 = 0.04%); `const DEFAULT_BROKER_CONFIG: BrokerConfig = { initialBalance: 10_000, leverage: 1, takerFee: 0.0004, makerFee: 0.0002, slippageBps: 2 }`.
  - `broker.ts`: `class Broker { constructor(config: BrokerConfig); readonly config; readonly fills: Fill[]; readonly trades: Trade[]; readonly log: LogEntry[]; get balance(): number; get position(): PositionView; get openOrders(): readonly Order[]; unrealizedPnl(markPrice: number): number; equity(markPrice: number): number; addLog(bar: number, time: number, level: LogEntry['level'], message: string): void; placeOrder(request: OrderRequest, bar: number, time: number): number; cancelOrder(id: number): boolean; cancelAll(): void; setStopLoss(price: number | null): void; setTakeProfit(price: number | null): void; processBar(candle: Candle, bar: number): void; forceClose(price: number, bar: number, time: number, reason: FillReason): void }`.
  - Log messages relied on by tests/UI: `order #<id> skipped: nothing to reduce`, `order #<id> rejected: insufficient margin (needs X.XX, free Y.YY)`.

- [ ] **Step 1: Write the failing test** — `src/engine/broker.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Broker } from './broker';
import type { BrokerConfig } from './types';

const HOUR = 3_600_000;
/** Frictionless account so expected prices are exact; fee/slippage tests override this. */
const NO_COSTS: BrokerConfig = { initialBalance: 10_000, leverage: 1, takerFee: 0, makerFee: 0, slippageBps: 0 };

function bar(i: number, open: number, high: number, low: number, close: number): Candle {
  return { time: i * HOUR, open, high, low, close, volume: 1 };
}

/** Opens a position of `qty` (signed) at price 100 on bar 1 and returns the broker. */
function withPosition(qty: number, config: BrokerConfig = NO_COSTS): Broker {
  const b = new Broker(config);
  b.placeOrder({ side: qty > 0 ? 'buy' : 'sell', type: 'market', size: Math.abs(qty), unit: 'qty' }, 0, 0);
  b.processBar(bar(1, 100, 100, 100, 100), 1);
  return b;
}

describe('market orders', () => {
  it('never fill on the bar they were placed; fill at the next open', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 0, 0);
    b.processBar(bar(0, 50, 50, 50, 50), 0);
    expect(b.fills).toHaveLength(0);
    b.processBar(bar(1, 101, 105, 99, 104), 1);
    expect(b.fills).toEqual([{ orderId: 1, bar: 1, time: HOUR, side: 'buy', qty: 1, price: 101, fee: 0, reason: 'market' }]);
    expect(b.position).toEqual({ side: 'long', qty: 1, entryPrice: 101, stopLoss: null, takeProfit: null });
  });

  it('pay taker fee and slippage', () => {
    const b = new Broker({ ...NO_COSTS, takerFee: 0.0004, slippageBps: 2 });
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.fills[0].price).toBeCloseTo(100.02, 10); // 100 * (1 + 2/10000)
    expect(b.fills[0].fee).toBeCloseTo(0.040008, 10); // 100.02 * 0.0004
    expect(b.balance).toBeCloseTo(10_000 - 0.040008, 10);
  });

  it('size percentEquity: margin = % of equity with the fee reserved inside the budget', () => {
    const b = new Broker({ ...NO_COSTS, takerFee: 0.0004 });
    b.placeOrder({ side: 'buy', type: 'market', size: 100, unit: 'percentEquity' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    // qty = 10000 / (100 * (1/1 + 0.0004)) = 99.960016
    expect(b.position.qty).toBeCloseTo(99.960016, 6);
    expect(b.log).toHaveLength(0);
  });

  it('size usdt: notional / price', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'sell', type: 'market', size: 5000, unit: 'usdt' }, 0, 0);
    b.processBar(bar(1, 125, 125, 125, 125), 1);
    expect(b.position.qty).toBe(-40);
  });
});

describe('limit and stop orders', () => {
  it('limit buy fills at the limit when low touches it, maker fee', () => {
    const b = new Broker({ ...NO_COSTS, makerFee: 0.0002, takerFee: 0.0004, slippageBps: 2 });
    b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.processBar(bar(1, 100, 101, 96, 99), 1);
    expect(b.fills).toHaveLength(0);
    b.processBar(bar(2, 100, 101, 94, 99), 2);
    expect(b.fills[0]).toMatchObject({ price: 95, reason: 'limit' });
    expect(b.fills[0].fee).toBeCloseTo(0.019, 10); // 95 * 0.0002, no slippage on limits
  });

  it('limit buy fills at the open when the bar gaps below the limit', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.processBar(bar(1, 90, 92, 88, 91), 1);
    expect(b.fills[0].price).toBe(90);
  });

  it('stop buy fills at the stop when high touches it, at the open on a gap', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'buy', type: 'stop', size: 1, unit: 'qty', price: 105 }, 0, 0);
    b.placeOrder({ side: 'buy', type: 'stop', size: 1, unit: 'qty', price: 105 }, 0, 0);
    b.processBar(bar(1, 100, 106, 99, 104), 1);
    expect(b.fills.map((f) => f.price)).toEqual([105, 105]);
    const g = new Broker(NO_COSTS);
    g.placeOrder({ side: 'buy', type: 'stop', size: 1, unit: 'qty', price: 105 }, 0, 0);
    g.processBar(bar(1, 107, 108, 106, 107), 1);
    expect(g.fills[0]).toMatchObject({ price: 107, reason: 'stop' });
  });

  it('stop sell fills at the stop when low touches it', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'sell', type: 'stop', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.processBar(bar(1, 100, 101, 94, 96), 1);
    expect(b.fills[0].price).toBe(95);
  });

  it('rejects malformed orders', () => {
    const b = new Broker(NO_COSTS);
    expect(() => b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty' }, 0, 0)).toThrow('limit order needs a positive price');
    expect(() => b.placeOrder({ side: 'buy', type: 'market', size: 0, unit: 'qty' }, 0, 0)).toThrow('order size must be a positive number');
  });

  it('cancels orders', () => {
    const b = new Broker(NO_COSTS);
    const id = b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 90 }, 0, 0);
    expect(b.cancelOrder(id)).toBe(true);
    expect(b.openOrders).toHaveLength(1);
    b.cancelAll();
    expect(b.openOrders).toHaveLength(0);
  });
});

describe('stop-loss / take-profit', () => {
  it('assumes the stop-loss hit first when a bar touches both', () => {
    const b = withPosition(1);
    b.setStopLoss(95);
    b.setTakeProfit(110);
    b.processBar(bar(2, 100, 111, 94, 105), 2);
    expect(b.trades).toHaveLength(1);
    expect(b.trades[0]).toMatchObject({ side: 'long', exitPrice: 95, pnl: -5, exitReason: 'stopLoss' });
    expect(b.position.side).toBe('flat');
  });

  it('fills a stop-loss at the open when the bar gaps through it', () => {
    const b = withPosition(1);
    b.setStopLoss(95);
    b.processBar(bar(2, 90, 92, 88, 91), 2);
    expect(b.trades[0]).toMatchObject({ exitPrice: 90, pnl: -10 });
  });

  it('fills a take-profit at the open on a favourable gap, with maker fee', () => {
    const b = withPosition(1, { ...NO_COSTS, makerFee: 0.001 });
    b.setTakeProfit(110);
    b.processBar(bar(2, 112, 113, 111, 112), 2);
    expect(b.trades[0]).toMatchObject({ exitPrice: 112, pnl: 12, exitReason: 'takeProfit' });
    expect(b.fills[1].fee).toBeCloseTo(0.112, 10);
  });

  it('handles short positions (stop above, target below)', () => {
    const b = withPosition(-1);
    b.setStopLoss(105);
    b.setTakeProfit(90);
    b.processBar(bar(2, 101, 106, 100, 104), 2);
    expect(b.trades[0]).toMatchObject({ side: 'short', exitPrice: 105, pnl: -5 });
  });

  it('keeps SL/TP set while flat for the next entry, clears them when the position closes', () => {
    const b = new Broker(NO_COSTS);
    b.setStopLoss(90);
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.position.stopLoss).toBe(90);
    b.processBar(bar(2, 95, 96, 89, 95), 2);
    expect(b.position).toMatchObject({ side: 'flat', stopLoss: null, takeProfit: null });
  });
});

describe('net position', () => {
  it('averages the entry price when adding', () => {
    const b = withPosition(1);
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2);
    expect(b.position).toMatchObject({ qty: 2, entryPrice: 105 });
  });

  it('reduces partially and records a trade for the closed part', () => {
    const b = withPosition(2);
    b.placeOrder({ side: 'sell', type: 'market', size: 1, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2);
    expect(b.trades[0]).toMatchObject({ qty: 1, pnl: 10 });
    expect(b.position).toMatchObject({ side: 'long', qty: 1, entryPrice: 100 });
    expect(b.balance).toBe(10_010);
  });

  it('flips from long to short with one opposite order', () => {
    const b = withPosition(1);
    b.placeOrder({ side: 'sell', type: 'market', size: 3, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2);
    expect(b.trades[0]).toMatchObject({ side: 'long', qty: 1, pnl: 10 });
    expect(b.position).toMatchObject({ side: 'short', qty: -2, entryPrice: 110 });
  });

  it('attributes entry and exit fees to the trade', () => {
    const b = withPosition(1, { ...NO_COSTS, takerFee: 0.001 }); // entry fee 0.1
    b.placeOrder({ side: 'sell', type: 'market', size: 1, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2); // exit fee 0.11
    expect(b.trades[0].fees).toBeCloseTo(0.21, 10);
    expect(b.trades[0].netPnl).toBeCloseTo(9.79, 10);
    expect(b.balance).toBeCloseTo(10_009.79, 10);
  });

  it('reduceOnly with Infinity size closes exactly the position', () => {
    const b = withPosition(-3);
    b.placeOrder({ side: 'buy', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true }, 1, HOUR);
    b.processBar(bar(2, 90, 90, 90, 90), 2);
    expect(b.position.side).toBe('flat');
    expect(b.trades[0]).toMatchObject({ side: 'short', qty: 3, pnl: 30 });
  });

  it('skips a reduceOnly order when there is nothing to reduce', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'sell', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.fills).toHaveLength(0);
    expect(b.log[0].message).toBe('order #1 skipped: nothing to reduce');
  });

  it('marks to market', () => {
    const b = withPosition(1);
    expect(b.unrealizedPnl(120)).toBe(20);
    expect(b.equity(120)).toBe(10_020);
  });
});

describe('margin', () => {
  it('rejects orders whose margin exceeds free equity and logs why', () => {
    const b = new Broker({ ...NO_COSTS, leverage: 2 });
    b.placeOrder({ side: 'buy', type: 'market', size: 25_000, unit: 'usdt' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.fills).toHaveLength(0);
    expect(b.log[0]).toMatchObject({ level: 'warn', message: 'order #1 rejected: insufficient margin (needs 12500.00, free 10000.00)' });
  });

  it('allows notional up to equity x leverage', () => {
    const b = new Broker({ ...NO_COSTS, leverage: 2 });
    b.placeOrder({ side: 'buy', type: 'market', size: 20_000, unit: 'usdt' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.position.qty).toBe(200);
  });

  it('counts margin already used by the open position', () => {
    const b = withPosition(60); // uses 6000 margin at 1x
    b.placeOrder({ side: 'buy', type: 'market', size: 50, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 100, 100, 100, 100), 2);
    expect(b.position.qty).toBe(60);
    expect(b.log[0].message).toContain('rejected: insufficient margin');
  });

  it('closes the whole position on forceClose', () => {
    const b = withPosition(1);
    b.forceClose(80, 2, 2 * HOUR, 'wiped');
    expect(b.trades[0]).toMatchObject({ exitPrice: 80, exitReason: 'wiped' });
    expect(b.position.side).toBe('flat');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/broker.test.ts`
Expected: FAIL — `Failed to resolve import "./broker"`.

- [ ] **Step 3: Implement the engine types** — `src/engine/types.ts`

```ts
export type Side = 'buy' | 'sell';
export type OrderType = 'market' | 'limit' | 'stop';

/**
 * How `size` is interpreted, resolved at FILL time:
 * - percentEquity: margin = size% of equity, so notional = margin x leverage (fee is reserved inside the budget);
 * - usdt: notional value in USDT;
 * - qty: base-asset quantity.
 */
export type SizeUnit = 'percentEquity' | 'usdt' | 'qty';

export interface OrderRequest {
  side: Side;
  type: OrderType;
  size: number;
  unit: SizeUnit;
  /** Limit or stop trigger price; required for 'limit' and 'stop'. */
  price?: number;
  /** Only reduces the current position; the size is clipped to it (size may be Infinity). */
  reduceOnly?: boolean;
}

export interface Order extends OrderRequest {
  id: number;
  placedBar: number;
  placedTime: number;
}

export type FillReason = 'market' | 'limit' | 'stop' | 'stopLoss' | 'takeProfit' | 'wiped';

export interface Fill {
  /** null for SL/TP and forced fills, which are not orders. */
  orderId: number | null;
  bar: number;
  time: number;
  side: Side;
  qty: number;
  price: number;
  fee: number;
  reason: FillReason;
}

/** A closed (or partially closed) round trip. */
export interface Trade {
  side: 'long' | 'short';
  qty: number;
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  /** Price PnL before fees. */
  pnl: number;
  /** Pro-rata entry fee + exit fee. */
  fees: number;
  netPnl: number;
  exitReason: FillReason;
}

export interface PositionView {
  side: 'long' | 'short' | 'flat';
  /** Signed: > 0 long, < 0 short, 0 flat. */
  qty: number;
  /** Average entry price; NaN when flat. */
  entryPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
}

export interface LogEntry {
  bar: number;
  time: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface BrokerConfig {
  initialBalance: number;
  leverage: number;
  /** Fraction, e.g. 0.0004 = 0.04%. Market, stop and stop-loss fills. */
  takerFee: number;
  /** Fraction, e.g. 0.0002 = 0.02%. Limit and take-profit fills. */
  makerFee: number;
  /** Basis points applied against us on taker fills (market, stop, stop-loss). */
  slippageBps: number;
}

export const DEFAULT_BROKER_CONFIG: BrokerConfig = {
  initialBalance: 10_000,
  leverage: 1,
  takerFee: 0.0004,
  makerFee: 0.0002,
  slippageBps: 2,
};
```

- [ ] **Step 4: Implement the broker** — `src/engine/broker.ts`

```ts
import type { Candle } from '../data/types';
import type {
  BrokerConfig,
  Fill,
  FillReason,
  LogEntry,
  Order,
  OrderRequest,
  PositionView,
  Side,
  Trade,
} from './types';

/**
 * Simulated futures account with ONE net position (opposite fills reduce or flip it).
 * Orders placed on bar t are only processed from bar t+1 on. Per bar, processBar runs:
 *   1. market orders at the open (± slippage), in placement order;
 *   2. stop-loss / take-profit of the position held after step 1 (SL wins ties; gaps fill at the open);
 *   3. resting limit / stop orders against high/low (gaps fill at the open), in placement order.
 * A position opened in step 3 is first checked for SL/TP on the next bar.
 */
export class Broker {
  readonly fills: Fill[] = [];
  readonly trades: Trade[] = [];
  readonly log: LogEntry[] = [];

  private cash: number;
  private qty = 0;
  private entryPrice = NaN;
  private entryBar = -1;
  private entryTime = 0;
  private entryFees = 0;
  private stopLoss: number | null = null;
  private takeProfit: number | null = null;
  private orders: Order[] = [];
  private nextOrderId = 1;

  constructor(readonly config: BrokerConfig) {
    this.cash = config.initialBalance;
  }

  /** Initial balance + realized PnL - all fees paid. */
  get balance(): number {
    return this.cash;
  }

  get position(): PositionView {
    return {
      side: this.qty > 0 ? 'long' : this.qty < 0 ? 'short' : 'flat',
      qty: this.qty,
      entryPrice: this.entryPrice,
      stopLoss: this.stopLoss,
      takeProfit: this.takeProfit,
    };
  }

  get openOrders(): readonly Order[] {
    return this.orders;
  }

  unrealizedPnl(markPrice: number): number {
    return this.qty === 0 ? 0 : this.qty * (markPrice - this.entryPrice);
  }

  equity(markPrice: number): number {
    return this.cash + this.unrealizedPnl(markPrice);
  }

  addLog(bar: number, time: number, level: LogEntry['level'], message: string): void {
    this.log.push({ bar, time, level, message });
  }

  /** Queues an order; it can fill from the NEXT bar on. Returns the order id. Throws on malformed requests. */
  placeOrder(request: OrderRequest, bar: number, time: number): number {
    const sizeOk = request.size > 0 && (Number.isFinite(request.size) || request.reduceOnly === true);
    if (!sizeOk) throw new Error(`order size must be a positive number, got ${request.size}`);
    if (request.type !== 'market' && !(request.price !== undefined && request.price > 0)) {
      throw new Error(`${request.type} order needs a positive price`);
    }
    const order: Order = { ...request, id: this.nextOrderId++, placedBar: bar, placedTime: time };
    this.orders.push(order);
    return order.id;
  }

  cancelOrder(id: number): boolean {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.id !== id);
    return this.orders.length < before;
  }

  cancelAll(): void {
    this.orders = [];
  }

  /** Protective stop for the current (or next) position; cleared when the position closes. null removes it. */
  setStopLoss(price: number | null): void {
    this.stopLoss = price;
  }

  /** Protective target for the current (or next) position; cleared when the position closes. null removes it. */
  setTakeProfit(price: number | null): void {
    this.takeProfit = price;
  }

  /** Processes pending orders and SL/TP against a newly opened bar. `bar` is the candle's index. */
  processBar(candle: Candle, bar: number): void {
    for (const order of this.orders.filter((o) => o.type === 'market' && o.placedBar < bar)) {
      this.removeOrder(order.id);
      this.execute(order, this.slip(candle.open, order.side), this.config.takerFee, 'market', bar, candle.time);
    }

    this.checkProtection(candle, bar);

    for (const order of this.orders.filter((o) => o.type !== 'market' && o.placedBar < bar)) {
      const touched = triggerPrice(order, candle);
      if (touched === null) continue;
      this.removeOrder(order.id);
      if (order.type === 'stop') {
        this.execute(order, this.slip(touched, order.side), this.config.takerFee, 'stop', bar, candle.time);
      } else {
        this.execute(order, touched, this.config.makerFee, 'limit', bar, candle.time);
      }
    }
  }

  /** Closes the whole position at `price` with the taker fee (used when the account is wiped). */
  forceClose(price: number, bar: number, time: number, reason: FillReason): void {
    this.orders = [];
    if (this.qty === 0) return;
    this.applyFill(this.qty > 0 ? 'sell' : 'buy', Math.abs(this.qty), price, this.config.takerFee, reason, null, bar, time);
  }

  private removeOrder(id: number): void {
    this.orders = this.orders.filter((o) => o.id !== id);
  }

  private slip(price: number, side: Side): number {
    const k = this.config.slippageBps / 10_000;
    return side === 'buy' ? price * (1 + k) : price * (1 - k);
  }

  private checkProtection(candle: Candle, bar: number): void {
    if (this.qty === 0) return;
    const long = this.qty > 0;
    const sl = this.stopLoss;
    const tp = this.takeProfit;
    let price: number | null = null;
    let reason: FillReason = 'stopLoss';
    if (long) {
      if (sl !== null && candle.open <= sl) price = candle.open;
      else if (tp !== null && candle.open >= tp) { price = candle.open; reason = 'takeProfit'; }
      else if (sl !== null && candle.low <= sl) price = sl;
      else if (tp !== null && candle.high >= tp) { price = tp; reason = 'takeProfit'; }
    } else {
      if (sl !== null && candle.open >= sl) price = candle.open;
      else if (tp !== null && candle.open <= tp) { price = candle.open; reason = 'takeProfit'; }
      else if (sl !== null && candle.high >= sl) price = sl;
      else if (tp !== null && candle.low <= tp) { price = tp; reason = 'takeProfit'; }
    }
    if (price === null) return;
    const side: Side = long ? 'sell' : 'buy';
    if (reason === 'stopLoss') {
      this.applyFill(side, Math.abs(this.qty), this.slip(price, side), this.config.takerFee, reason, null, bar, candle.time);
    } else {
      this.applyFill(side, Math.abs(this.qty), price, this.config.makerFee, reason, null, bar, candle.time);
    }
  }

  private execute(order: Order, price: number, feeRate: number, reason: FillReason, bar: number, time: number): void {
    const qty = this.resolveQty(order, price, feeRate);
    if (!(qty > 0)) {
      this.addLog(bar, time, 'warn', `order #${order.id} skipped: nothing to reduce`);
      return;
    }
    const margin = this.marginCheck(order.side, qty, price, feeRate);
    if (!margin.ok) {
      this.addLog(
        bar, time, 'warn',
        `order #${order.id} rejected: insufficient margin (needs ${margin.required.toFixed(2)}, free ${margin.free.toFixed(2)})`,
      );
      return;
    }
    this.applyFill(order.side, qty, price, feeRate, reason, order.id, bar, time);
  }

  private resolveQty(order: Order, price: number, feeRate: number): number {
    let qty: number;
    if (order.unit === 'qty') qty = order.size;
    else if (order.unit === 'usdt') qty = order.size / price;
    else {
      const budget = (this.equity(price) * order.size) / 100;
      qty = budget / (price * (1 / this.config.leverage + feeRate));
    }
    if (order.reduceOnly) {
      const opposite = (order.side === 'sell' && this.qty > 0) || (order.side === 'buy' && this.qty < 0);
      qty = opposite ? Math.min(qty, Math.abs(this.qty)) : 0;
    }
    return qty;
  }

  /** Margin needed for the part of the fill that opens or increases exposure, vs margin still free after the fill's fee. */
  private marginCheck(side: Side, qty: number, price: number, feeRate: number): { ok: boolean; required: number; free: number } {
    const dir = side === 'buy' ? 1 : -1;
    const closing = this.qty !== 0 && Math.sign(this.qty) !== dir ? Math.min(qty, Math.abs(this.qty)) : 0;
    const opening = qty - closing;
    if (opening <= 0) return { ok: true, required: 0, free: Infinity };
    const remaining = Math.abs(this.qty) - closing;
    const used = remaining > 0 ? (remaining * this.entryPrice) / this.config.leverage : 0;
    const equityAfterFee = this.equity(price) - qty * price * feeRate;
    const free = equityAfterFee - used;
    const required = (opening * price) / this.config.leverage;
    return { ok: required <= free + 1e-9 * Math.max(1, Math.abs(free)), required, free };
  }

  private applyFill(
    side: Side, qty: number, price: number, feeRate: number, reason: FillReason,
    orderId: number | null, bar: number, time: number,
  ): void {
    const fee = qty * price * feeRate;
    this.cash -= fee;
    this.fills.push({ orderId, bar, time, side, qty, price, fee, reason });

    const dir = side === 'buy' ? 1 : -1;
    let openingQty = qty;
    if (this.qty !== 0 && Math.sign(this.qty) !== dir) {
      const closeQty = Math.min(qty, Math.abs(this.qty));
      const pnl = (price - this.entryPrice) * closeQty * Math.sign(this.qty);
      const entryFeeShare = (this.entryFees * closeQty) / Math.abs(this.qty);
      const exitFeeShare = (fee * closeQty) / qty;
      this.cash += pnl;
      this.entryFees -= entryFeeShare;
      this.trades.push({
        side: this.qty > 0 ? 'long' : 'short',
        qty: closeQty,
        entryBar: this.entryBar,
        entryTime: this.entryTime,
        entryPrice: this.entryPrice,
        exitBar: bar,
        exitTime: time,
        exitPrice: price,
        pnl,
        fees: entryFeeShare + exitFeeShare,
        netPnl: pnl - entryFeeShare - exitFeeShare,
        exitReason: reason,
      });
      this.qty -= Math.sign(this.qty) * closeQty;
      openingQty = qty - closeQty;
      if (this.qty === 0) {
        this.entryPrice = NaN;
        this.entryFees = 0;
        this.stopLoss = null;
        this.takeProfit = null;
      }
    }
    if (openingQty > 0) {
      if (this.qty === 0) {
        this.entryPrice = price;
        this.entryBar = bar;
        this.entryTime = time;
      } else {
        this.entryPrice = (this.entryPrice * Math.abs(this.qty) + price * openingQty) / (Math.abs(this.qty) + openingQty);
      }
      this.entryFees += (fee * openingQty) / qty;
      this.qty += dir * openingQty;
    }
  }
}

/** Price at which a resting limit/stop order fills on this bar, or null if untouched. Gaps fill at the open. */
function triggerPrice(order: Order, c: Candle): number | null {
  const p = order.price as number;
  if (order.type === 'limit') {
    if (order.side === 'buy') return c.open <= p ? c.open : c.low <= p ? p : null;
    return c.open >= p ? c.open : c.high >= p ? p : null;
  }
  if (order.side === 'buy') return c.open >= p ? c.open : c.high >= p ? p : null;
  return c.open <= p ? c.open : c.low <= p ? p : null;
}
```

- [ ] **Step 5: Run tests and typecheck**

Run: `npx vitest run src/engine/broker.test.ts; npm run typecheck`
Expected: 26 tests passed; no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/engine/types.ts src/engine/broker.ts src/engine/broker.test.ts
git commit -m "feat(engine): broker with next-bar fills, SL-first tie-break, gap fills, fees, slippage, margin checks"
```

---

### Task 8: Engine, stats, SMA-cross strategy and the backtest Web Worker

**Files:**
- Create: `src/engine/strategy.ts`, `src/engine/stats.ts`, `src/engine/engine.ts`, `src/engine/strategies/smaCross.ts`, `src/engine/syntheticCandles.ts`
- Create: `src/worker/protocol.ts`, `src/worker/backtest.worker.ts`, `src/worker/client.ts`
- Test: `src/engine/stats.test.ts`, `src/engine/engine.test.ts`, `src/worker/protocol.test.ts`

**Interfaces:**
- Consumes: `Broker`, all of `src/engine/types.ts` (Task 7); `Sma`, `CrossOver`, `CrossUnder` (Task 4); `Candle`, `Timeframe`, `timeframeToMs` (Task 1).
- Produces:
  - `strategy.ts`: `type PriceField = 'open' | 'high' | 'low' | 'close' | 'volume'`; `interface EntryRequest { type?: OrderType; size: number; unit?: SizeUnit; price?: number }` (defaults market / percentEquity); `interface StrategyContext { readonly symbol: string; readonly timeframe: Timeframe; readonly barIndex: number; readonly candle: Candle; value(field: PriceField, offset?: number): number; readonly balance: number; readonly equity: number; readonly unrealizedPnl: number; readonly position: PositionView; readonly openOrderCount: number; buy(request: EntryRequest): number; sell(request: EntryRequest): number; closePosition(): number | null; cancelOrders(): void; setStopLoss(price: number | null): void; setTakeProfit(price: number | null): void; log(message: string): void }`; `interface Strategy { init?(ctx: StrategyContext): void; onBar(ctx: StrategyContext): void }`.
  - `stats.ts`: `interface EquityPoint { time: number; equity: number }`; `interface Stats { initialEquity; finalEquity; netProfit; totalReturnPct; maxDrawdownPct; winRatePct; profitFactor; sharpe; tradeCount; exposurePct }` (all `number`, NaN = undefined); `interface StatsInput { initialEquity: number; equityCurve: readonly EquityPoint[]; trades: readonly Trade[]; barsInPosition: number; timeframe: Timeframe }`; `function computeStats(input: StatsInput): Stats`.
  - `engine.ts`: `interface EngineConfig { symbol: string; timeframe: Timeframe; broker: BrokerConfig }`; `interface BacktestResult { config: EngineConfig; trades: Trade[]; fills: Fill[]; equityCurve: EquityPoint[]; log: LogEntry[]; stats: Stats; wiped: boolean; barsProcessed: number; finalPosition: PositionView }`; `class Engine { constructor(strategy: Strategy, config: EngineConfig); get wiped(): boolean; pushCandle(candle: Candle): boolean; result(): BacktestResult }`; `function runBacktest(candles: readonly Candle[], strategy: Strategy, config: EngineConfig): BacktestResult`. Messages: `account wiped: equity <= 0, run stopped`; strategy exceptions rethrown as `strategy error on bar <n>: <message>`.
  - `strategies/smaCross.ts`: `interface SmaCrossParams { fast: number; slow: number; sizePct: number }`; `const DEFAULT_SMA_CROSS: SmaCrossParams = { fast: 10, slow: 30, sizePct: 100 }`; `function createSmaCross(params?: SmaCrossParams): Strategy` (throws `fast length must be less than slow length`).
  - `syntheticCandles.ts`: `function syntheticCandles(count: number, startMs = 0, stepMs = 3_600_000): Candle[]`.
  - `worker/protocol.ts`: `type StrategySpec = { id: 'smaCross'; params: SmaCrossParams }`; `interface RunRequest { type: 'run'; candles: Candle[]; config: EngineConfig; strategy: StrategySpec }`; `type WorkerResponse = { type: 'result'; result: BacktestResult } | { type: 'error'; message: string }`; `function buildStrategy(spec: StrategySpec): Strategy`; `function handleRequest(request: RunRequest): WorkerResponse`.
  - `worker/client.ts`: `function runBacktestInWorker(request: RunRequest, timeoutMs = 60_000): Promise<BacktestResult>`.

- [ ] **Step 1: Write the failing stats test** — `src/engine/stats.test.ts` (Sharpe reference: returns 0.1, −0.1, 0.2222 → 8.699821)

```ts
import { describe, it, expect } from 'vitest';
import { computeStats } from './stats';
import type { Trade } from './types';

function trade(netPnl: number): Trade {
  return {
    side: 'long', qty: 1, entryBar: 0, entryTime: 0, entryPrice: 100, exitBar: 1, exitTime: 1,
    exitPrice: 100 + netPnl, pnl: netPnl, fees: 0, netPnl, exitReason: 'market',
  };
}

const DAY = 86_400_000;

describe('computeStats', () => {
  it('matches hand-computed values', () => {
    const s = computeStats({
      initialEquity: 100,
      equityCurve: [{ time: 0, equity: 110 }, { time: DAY, equity: 99 }, { time: 2 * DAY, equity: 121 }],
      trades: [trade(10), trade(-5), trade(15)],
      barsInPosition: 2,
      timeframe: '1d',
    });
    expect(s.finalEquity).toBe(121);
    expect(s.netProfit).toBe(21);
    expect(s.totalReturnPct).toBeCloseTo(21, 10);
    expect(s.maxDrawdownPct).toBeCloseTo(10, 10); // peak 110 -> 99
    expect(s.winRatePct).toBeCloseTo(66.666667, 5); // 2 of 3
    expect(s.profitFactor).toBeCloseTo(5, 10); // 25 / 5
    // returns 0.1, -0.1, 0.222222: mean 0.0740741, sample sd 0.1626681, x sqrt(365)
    expect(s.sharpe).toBeCloseTo(8.699821, 5);
    expect(s.tradeCount).toBe(3);
    expect(s.exposurePct).toBeCloseTo(66.666667, 5);
  });

  it('reports undefined ratios as NaN and no-loss profit factor as Infinity', () => {
    const none = computeStats({ initialEquity: 100, equityCurve: [{ time: 0, equity: 100 }], trades: [], barsInPosition: 0, timeframe: '1h' });
    expect(none.winRatePct).toBeNaN();
    expect(none.profitFactor).toBeNaN();
    expect(none.sharpe).toBeNaN();
    expect(none.maxDrawdownPct).toBe(0);

    const allWins = computeStats({ initialEquity: 100, equityCurve: [], trades: [trade(1)], barsInPosition: 0, timeframe: '1h' });
    expect(allWins.profitFactor).toBe(Infinity);
    expect(allWins.exposurePct).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/engine/stats.test.ts`
Expected: FAIL — `Failed to resolve import "./stats"`.

- [ ] **Step 3: Implement stats** — `src/engine/stats.ts`

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/engine/stats.test.ts`
Expected: 2 tests passed.

- [ ] **Step 5: Write the failing engine test** — `src/engine/engine.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Engine, runBacktest, type EngineConfig } from './engine';
import { createSmaCross } from './strategies/smaCross';
import type { Strategy } from './strategy';
import { syntheticCandles } from './syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from './types';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const HOUR = 3_600_000;

describe('Engine', () => {
  it('shows the strategy only closed bars, in order, with history via value()', () => {
    const candles = syntheticCandles(5);
    const seen: Array<[number, number, number, number]> = [];
    let inits = 0;
    const spy: Strategy = {
      init: () => { inits++; },
      onBar: (ctx) => seen.push([ctx.barIndex, ctx.candle.time, ctx.value('close', 1), ctx.value('close', -1)]),
    };
    runBacktest(candles, spy, CONFIG);
    expect(inits).toBe(1);
    expect(seen.map((s) => s[0])).toEqual([0, 1, 2, 3, 4]);
    expect(seen.map((s) => s[1])).toEqual(candles.map((c) => c.time));
    expect(seen[0][2]).toBeNaN(); // nothing before bar 0
    expect(seen[3][2]).toBe(candles[2].close);
    expect(seen.every((s) => Number.isNaN(s[3]))).toBe(true); // future offsets are refused
  });

  it('fills an order placed on bar t at the open of bar t+1 with slippage and fee', () => {
    const candles = syntheticCandles(3);
    const strategy: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 1, unit: 'qty' }); } };
    const result = runBacktest(candles, strategy, CONFIG);
    expect(result.fills).toHaveLength(1);
    expect(result.fills[0].bar).toBe(1);
    expect(result.fills[0].price).toBeCloseTo(candles[1].open * 1.0002, 10);
    expect(result.fills[0].fee).toBeCloseTo(candles[1].open * 1.0002 * 0.0004, 10);
    expect(result.finalPosition.qty).toBe(1);
    expect(result.equityCurve).toHaveLength(3);
  });

  it('closePosition returns null when flat', () => {
    let id: number | null = 0;
    runBacktest(syntheticCandles(1), { onBar: (ctx) => { id = ctx.closePosition(); } }, CONFIG);
    expect(id).toBeNull();
  });

  it('stops the run when equity reaches zero (account wiped)', () => {
    const crash: Candle[] = [100, 100, 85, 80, 120].map((p, i) => ({ time: i * HOUR, open: p, high: p, low: p, close: p, volume: 1 }));
    const allIn: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } };
    const config: EngineConfig = { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } };
    const result = runBacktest(crash, allIn, config);
    // ~10x notional bought at ~100; a 15% drop at bar 2 loses > 100% of equity
    expect(result.wiped).toBe(true);
    expect(result.barsProcessed).toBe(3);
    expect(result.trades[result.trades.length - 1].exitReason).toBe('wiped');
    expect(result.log.some((l) => l.message === 'account wiped: equity <= 0, run stopped')).toBe(true);
    expect(result.finalPosition.side).toBe('flat');
  });

  it('ignores candles after a wipe when driven incrementally', () => {
    const engine = new Engine({ onBar: (ctx) => { if (ctx.barIndex === 0) ctx.buy({ size: 100 }); } }, { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } });
    const prices = [100, 100, 85, 120];
    const results = prices.map((p, i) => engine.pushCandle({ time: i * HOUR, open: p, high: p, low: p, close: p, volume: 1 }));
    expect(results).toEqual([true, true, false, false]);
    expect(engine.wiped).toBe(true);
  });

  it('wraps strategy exceptions with the bar index', () => {
    const bad: Strategy = { onBar: (ctx) => { if (ctx.barIndex === 2) throw new Error('boom'); } };
    expect(() => runBacktest(syntheticCandles(5), bad, CONFIG)).toThrow('strategy error on bar 2: boom');
  });
});

describe('SMA cross backtest', () => {
  it('is deterministic: same candles -> identical result', () => {
    const candles = syntheticCandles(600);
    const a = runBacktest(candles, createSmaCross(), CONFIG);
    const b = runBacktest(candles, createSmaCross(), CONFIG);
    expect(a.trades.length).toBeGreaterThan(5);
    expect(b).toEqual(a);
  });

  it('enters only after the slow SMA warms up and alternates long/short', () => {
    const result = runBacktest(syntheticCandles(600), createSmaCross({ fast: 10, slow: 30, sizePct: 100 }), CONFIG);
    expect(result.fills[0].bar).toBeGreaterThanOrEqual(31); // slow SMA first valid at bar 29, first cross >= 30, fill next bar
    for (let i = 1; i < result.trades.length; i++) {
      expect(result.trades[i].side).not.toBe(result.trades[i - 1].side);
    }
    expect(result.stats.tradeCount).toBe(result.trades.length);
    expect(result.log.filter((l) => l.level !== 'info')).toEqual([]);
  });

  it('rejects fast >= slow', () => {
    expect(() => createSmaCross({ fast: 30, slow: 10, sizePct: 100 })).toThrow('fast length must be less than slow length');
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npx vitest run src/engine/engine.test.ts`
Expected: FAIL — `Failed to resolve import "./engine"`.

- [ ] **Step 7: Strategy interface** — `src/engine/strategy.ts`

```ts
import type { Candle, Timeframe } from '../data/types';
import type { OrderType, PositionView, SizeUnit } from './types';

export type PriceField = 'open' | 'high' | 'low' | 'close' | 'volume';

export interface EntryRequest {
  /** Default 'market'. */
  type?: OrderType;
  size: number;
  /** Default 'percentEquity'. */
  unit?: SizeUnit;
  /** Required for limit/stop. */
  price?: number;
}

/**
 * Everything a strategy may see and do on one CLOSED bar. Hand-written strategies, the Blockly generator
 * and Pine-compiled code all target this interface; live mode feeds the same Engine.
 */
export interface StrategyContext {
  readonly symbol: string;
  readonly timeframe: Timeframe;
  /** 0-based index of the bar that just closed. */
  readonly barIndex: number;
  /** The bar that just closed. Later bars are never visible (no look-ahead). */
  readonly candle: Candle;
  /** `field` of the bar `offset` bars ago (0 = this bar). NaN before the first bar or for negative offsets. */
  value(field: PriceField, offset?: number): number;
  readonly balance: number;
  /** Balance + unrealized PnL marked at this bar's close. */
  readonly equity: number;
  readonly unrealizedPnl: number;
  readonly position: PositionView;
  readonly openOrderCount: number;
  /** Queues a buy for the next bar; returns the order id. */
  buy(request: EntryRequest): number;
  /** Queues a sell for the next bar; returns the order id. */
  sell(request: EntryRequest): number;
  /** Queues a reduce-only market order closing the whole position; null when flat. */
  closePosition(): number | null;
  cancelOrders(): void;
  setStopLoss(price: number | null): void;
  setTakeProfit(price: number | null): void;
  log(message: string): void;
}

export interface Strategy {
  /** Once, on the first bar, before onBar ("when strategy starts"). */
  init?(ctx: StrategyContext): void;
  /** Every closed bar ("when a bar closes"), after the broker processed that bar's fills. */
  onBar(ctx: StrategyContext): void;
}
```

- [ ] **Step 8: Engine** — `src/engine/engine.ts`

```ts
import type { Candle, Timeframe } from '../data/types';
import { Broker } from './broker';
import { computeStats, type EquityPoint, type Stats } from './stats';
import type { EntryRequest, PriceField, Strategy, StrategyContext } from './strategy';
import type { BrokerConfig, Fill, LogEntry, PositionView, Side, Trade } from './types';

export interface EngineConfig {
  symbol: string;
  timeframe: Timeframe;
  broker: BrokerConfig;
}

export interface BacktestResult {
  config: EngineConfig;
  trades: Trade[];
  fills: Fill[];
  equityCurve: EquityPoint[];
  log: LogEntry[];
  stats: Stats;
  /** True when equity hit <= 0 and the run stopped ("account wiped"). */
  wiped: boolean;
  barsProcessed: number;
  /** Position still open after the last bar (not counted in trades). */
  finalPosition: PositionView;
}

/**
 * Bar-by-bar driver shared by backtest and (later) live mode. For each CLOSED candle:
 * 1. broker fills orders queued on earlier bars against it;
 * 2. equity is marked at the close; equity <= 0 force-closes, logs "account wiped" and stops;
 * 3. the strategy runs and may queue orders for the next bar.
 */
export class Engine {
  private readonly broker: Broker;
  private readonly candles: Candle[] = [];
  private readonly equityCurve: EquityPoint[] = [];
  private barsInPosition = 0;
  private started = false;
  private isWiped = false;

  constructor(private readonly strategy: Strategy, readonly config: EngineConfig) {
    this.broker = new Broker(config.broker);
  }

  get wiped(): boolean {
    return this.isWiped;
  }

  /** Feeds one closed candle. Returns false once the account is wiped; later candles are ignored. */
  pushCandle(candle: Candle): boolean {
    if (this.isWiped) return false;
    const bar = this.candles.length;
    this.candles.push(candle);
    this.broker.processBar(candle, bar);

    let equity = this.broker.equity(candle.close);
    if (equity <= 0) {
      this.broker.forceClose(candle.close, bar, candle.time, 'wiped');
      this.broker.addLog(bar, candle.time, 'error', 'account wiped: equity <= 0, run stopped');
      this.isWiped = true;
      equity = this.broker.balance;
      this.equityCurve.push({ time: candle.time, equity });
      return false;
    }
    if (this.broker.position.qty !== 0) this.barsInPosition++;
    this.equityCurve.push({ time: candle.time, equity });

    const ctx = this.context(bar, candle);
    try {
      if (!this.started) {
        this.started = true;
        this.strategy.init?.(ctx);
      }
      this.strategy.onBar(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`strategy error on bar ${bar}: ${message}`);
    }
    return true;
  }

  result(): BacktestResult {
    return {
      config: this.config,
      trades: [...this.broker.trades],
      fills: [...this.broker.fills],
      equityCurve: [...this.equityCurve],
      log: [...this.broker.log],
      stats: computeStats({
        initialEquity: this.config.broker.initialBalance,
        equityCurve: this.equityCurve,
        trades: this.broker.trades,
        barsInPosition: this.barsInPosition,
        timeframe: this.config.timeframe,
      }),
      wiped: this.isWiped,
      barsProcessed: this.candles.length,
      finalPosition: this.broker.position,
    };
  }

  private context(bar: number, candle: Candle): StrategyContext {
    const broker = this.broker;
    const candles = this.candles;
    const order = (side: Side, req: EntryRequest) =>
      broker.placeOrder(
        { side, type: req.type ?? 'market', size: req.size, unit: req.unit ?? 'percentEquity', price: req.price },
        bar,
        candle.time,
      );
    return {
      symbol: this.config.symbol,
      timeframe: this.config.timeframe,
      barIndex: bar,
      candle,
      value(field: PriceField, offset = 0): number {
        if (!Number.isInteger(offset) || offset < 0 || offset > bar) return NaN;
        return candles[bar - offset][field];
      },
      get balance() { return broker.balance; },
      get equity() { return broker.equity(candle.close); },
      get unrealizedPnl() { return broker.unrealizedPnl(candle.close); },
      get position() { return broker.position; },
      get openOrderCount() { return broker.openOrders.length; },
      buy: (req) => order('buy', req),
      sell: (req) => order('sell', req),
      closePosition(): number | null {
        const qty = broker.position.qty;
        if (qty === 0) return null;
        return broker.placeOrder(
          { side: qty > 0 ? 'sell' : 'buy', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true },
          bar,
          candle.time,
        );
      },
      cancelOrders: () => broker.cancelAll(),
      setStopLoss: (price) => broker.setStopLoss(price),
      setTakeProfit: (price) => broker.setTakeProfit(price),
      log: (message) => broker.addLog(bar, candle.time, 'info', message),
    };
  }
}

/** Runs a strategy over historical closed candles. Deterministic: same inputs -> identical result. */
export function runBacktest(candles: readonly Candle[], strategy: Strategy, config: EngineConfig): BacktestResult {
  const engine = new Engine(strategy, config);
  for (const candle of candles) {
    if (!engine.pushCandle(candle)) break;
  }
  return engine.result();
}
```

- [ ] **Step 9: Hard-coded SMA-cross strategy** — `src/engine/strategies/smaCross.ts`

```ts
import { Sma } from '../../indicators/averages';
import { CrossOver, CrossUnder } from '../../indicators/primitives';
import type { Strategy } from '../strategy';

export interface SmaCrossParams {
  fast: number;
  slow: number;
  /** Margin per entry as % of equity. */
  sizePct: number;
}

export const DEFAULT_SMA_CROSS: SmaCrossParams = { fast: 10, slow: 30, sizePct: 100 };

/** Always-in-the-market SMA cross: long when fast crosses over slow, short when it crosses under. */
export function createSmaCross(params: SmaCrossParams = DEFAULT_SMA_CROSS): Strategy {
  if (!(params.fast < params.slow)) throw new Error('fast length must be less than slow length');
  const fast = new Sma(params.fast);
  const slow = new Sma(params.slow);
  const over = new CrossOver();
  const under = new CrossUnder();

  return {
    onBar(ctx) {
      const f = fast.update(ctx.candle.close);
      const s = slow.update(ctx.candle.close);
      const crossUp = over.update(f, s);
      const crossDown = under.update(f, s);
      const qty = ctx.position.qty;
      if (crossUp && qty <= 0) {
        if (qty < 0) ctx.closePosition();
        ctx.buy({ size: params.sizePct, unit: 'percentEquity' });
      } else if (crossDown && qty >= 0) {
        if (qty > 0) ctx.closePosition();
        ctx.sell({ size: params.sizePct, unit: 'percentEquity' });
      }
    },
  };
}
```

- [ ] **Step 10: Deterministic test candles** — `src/engine/syntheticCandles.ts`

```ts
import type { Candle } from '../data/types';

/** Deterministic oscillating price series for tests (no randomness). Hourly bars from `startMs`. */
export function syntheticCandles(count: number, startMs = 0, stepMs = 3_600_000): Candle[] {
  const out: Candle[] = [];
  let prevClose = 100;
  for (let i = 0; i < count; i++) {
    const close = 100 + 10 * Math.sin(i / 8) + 3 * Math.sin(i / 2.3);
    const open = prevClose;
    out.push({
      time: startMs + i * stepMs,
      open,
      high: Math.max(open, close) + 0.5,
      low: Math.min(open, close) - 0.5,
      close,
      volume: 10,
    });
    prevClose = close;
  }
  return out;
}
```

- [ ] **Step 11: Run engine tests**

Run: `npx vitest run src/engine`
Expected: 3 files, 37 tests passed.

- [ ] **Step 12: Write the failing worker-protocol test** — `src/worker/protocol.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_SMA_CROSS } from '../engine/strategies/smaCross';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { handleRequest, type RunRequest } from './protocol';

const request: RunRequest = {
  type: 'run',
  candles: syntheticCandles(300),
  config: { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG },
  strategy: { id: 'smaCross', params: DEFAULT_SMA_CROSS },
};

describe('handleRequest', () => {
  it('runs the SMA-cross backtest and returns a structured-clone-safe result', () => {
    const response = handleRequest(request);
    expect(response.type).toBe('result');
    if (response.type !== 'result') return;
    expect(response.result.barsProcessed).toBe(300);
    expect(response.result.trades.length).toBeGreaterThan(0);
    expect(structuredClone(response)).toEqual(response); // what postMessage will do
  });

  it('returns errors instead of throwing', () => {
    const response = handleRequest({ ...request, strategy: { id: 'smaCross', params: { fast: 30, slow: 10, sizePct: 100 } } });
    expect(response).toEqual({ type: 'error', message: 'fast length must be less than slow length' });
  });
});
```

- [ ] **Step 13: Run test to verify it fails**

Run: `npx vitest run src/worker/protocol.test.ts`
Expected: FAIL — `Failed to resolve import "./protocol"`.

- [ ] **Step 14: Worker protocol, worker glue and client**

`src/worker/protocol.ts`:

```ts
import type { Candle } from '../data/types';
import { runBacktest, type BacktestResult, type EngineConfig } from '../engine/engine';
import { createSmaCross, type SmaCrossParams } from '../engine/strategies/smaCross';
import type { Strategy } from '../engine/strategy';

/** Which strategy the worker should build. Blocks/Pine strategies will be added as new union members. */
export type StrategySpec = { id: 'smaCross'; params: SmaCrossParams };

export interface RunRequest {
  type: 'run';
  candles: Candle[];
  config: EngineConfig;
  strategy: StrategySpec;
}

export type WorkerResponse = { type: 'result'; result: BacktestResult } | { type: 'error'; message: string };

export function buildStrategy(spec: StrategySpec): Strategy {
  switch (spec.id) {
    case 'smaCross':
      return createSmaCross(spec.params);
  }
}

/** Pure request handler (the worker file is only glue), so it is testable without a Worker. */
export function handleRequest(request: RunRequest): WorkerResponse {
  try {
    const result = runBacktest(request.candles, buildStrategy(request.strategy), request.config);
    return { type: 'result', result };
  } catch (err) {
    return { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
```

`src/worker/backtest.worker.ts`:

```ts
import { handleRequest, type RunRequest } from './protocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<RunRequest>) => {
  scope.postMessage(handleRequest(event.data));
};
```

`src/worker/client.ts` (Vite bundles the worker from `new URL('./backtest.worker.ts', import.meta.url)`; `vite.config.ts` already sets `worker.format = 'es'`):

```ts
import type { BacktestResult } from '../engine/engine';
import type { RunRequest, WorkerResponse } from './protocol';

/** Runs one backtest in a fresh Web Worker; the worker is terminated on result, error or timeout. */
export function runBacktestInWorker(request: RunRequest, timeoutMs = 60_000): Promise<BacktestResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backtest.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`backtest timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      finish();
      if (event.data.type === 'result') resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || 'backtest worker crashed'));
    };
    worker.postMessage(request);
  });
}
```

- [ ] **Step 15: Run everything**

Run: `npm test; npm run build`
Expected: 16 files, 83 tests passed; `tsc` clean; Vite output lists a separate `backtest.worker-*.js` asset.

- [ ] **Step 16: Commit**

```bash
git add src/engine src/worker
git commit -m "feat(engine): per-bar engine, stats, SMA-cross strategy and backtest web worker"
```

---

### Task 9: Backtest UI — top bar, run flow, trade markers, stats panel (milestone 3)

**Files:**
- Create: `src/ui/settings.ts`, `src/ui/format.ts`, `src/ui/markers.ts`, `src/ui/statsPanel.ts`, `src/ui/topbar.ts`
- Modify (full rewrite): `src/ui/chart.ts`, `src/main.ts`, `src/style.css`
- Test: `src/ui/settings.test.ts`, `src/ui/format.test.ts`, `src/ui/markers.test.ts`

**Interfaces:**
- Consumes: `ChartPanel` (+ `setOverlays`, `updateOverlays`, `fit`), `OVERLAYS`, `smaOverlay`, `OverlayDef`, `renderOverlayPicker`, `h`, `toChartTime`, `UP_COLOR`, `DOWN_COLOR` (Tasks 3, 6); `BinanceFuturesAdapter`, `CandleSubscription` (Task 2); `TIMEFRAMES`, `isTimeframe`, `timeframeToMs`, `Timeframe`, `Candle` (Task 1); `BrokerConfig`, `Fill`, `FillReason` (Task 7); `Stats`, `BacktestResult`, `DEFAULT_SMA_CROSS`, `runBacktestInWorker` (Task 8).
- Produces:
  - `settings.ts`: `interface RawSettings { symbol; timeframe; startDate; balance; leverage; takerFeePct; makerFeePct; slippageBps }` (all `string`); `interface RunSettings { symbol: string; timeframe: Timeframe; startMs: number; broker: BrokerConfig }`; `type ParseResult = { ok: true; settings: RunSettings } | { ok: false; error: string }`; `const MAX_BARS = 100_000`; `function defaultStartDate(nowMs: number, days = 90): string`; `function defaultRawSettings(nowMs: number): RawSettings`; `function parseSettings(raw: RawSettings, nowMs: number): ParseResult`.
  - `format.ts`: `fmtNum(value: number, digits = 2): string`; `fmtPct(value: number, digits = 2): string`; `fmtTime(ms: number): string`; `interface StatRow { label: string; value: string; tone: 'pos' | 'neg' | 'neutral' }`; `statsRows(s: Stats): StatRow[]`.
  - `markers.ts`: `fillsToMarkers(fills: readonly Fill[]): SeriesMarker<UTCTimestamp>[]`.
  - `ChartPanel.setMarkers(markers: SeriesMarker<UTCTimestamp>[]): void`.
  - `statsPanel.ts`: `class StatsPanel { constructor(container: HTMLElement); clear(): void; render(result: BacktestResult): void }`.
  - `topbar.ts`: `interface TopBar { read(): RawSettings; setRunning(running: boolean): void; readonly extras: HTMLElement }`; `function createTopBar(container: HTMLElement, initial: RawSettings, onRun: () => void): TopBar`.

- [ ] **Step 1: Write the failing tests**

`src/ui/settings.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { defaultRawSettings, defaultStartDate, parseSettings, type RawSettings } from './settings';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const base: RawSettings = defaultRawSettings(NOW);

describe('defaults', () => {
  it('start 90 days back with spec default costs', () => {
    expect(defaultStartDate(NOW)).toBe('2026-07-07');
    expect(base).toMatchObject({ symbol: 'BTCUSDT', timeframe: '1h', takerFeePct: '0.04', makerFeePct: '0.02', slippageBps: '2' });
  });
});

describe('parseSettings', () => {
  it('converts percent fees to fractions and the date to UTC ms', () => {
    const r = parseSettings({ ...base, symbol: ' ethusdt ', leverage: '5' }, NOW);
    expect(r).toEqual({
      ok: true,
      settings: {
        symbol: 'ETHUSDT',
        timeframe: '1h',
        startMs: Date.parse('2026-07-07T00:00:00Z'),
        broker: { initialBalance: 10000, leverage: 5, takerFee: 0.0004, makerFee: 0.0002, slippageBps: 2 },
      },
    });
  });

  it.each([
    [{ symbol: 'BTC/USDT' }, 'symbol must be 2-20 letters/digits, e.g. BTCUSDT'],
    [{ timeframe: '7m' }, 'unsupported timeframe: 7m'],
    [{ startDate: '07/07/2026' }, 'start date must be YYYY-MM-DD'],
    [{ startDate: '2026-12-01' }, 'start date must be in the past'],
    [{ balance: '0' }, 'balance must be greater than 0'],
    [{ leverage: '200' }, 'leverage must be between 1 and 125'],
    [{ takerFeePct: '-1' }, 'fees must be between 0% and 1%'],
    [{ slippageBps: '' }, 'slippage must be between 0 and 1000 bps'],
  ])('rejects %j', (patch, error) => {
    expect(parseSettings({ ...base, ...patch }, NOW)).toEqual({ ok: false, error });
  });

  it('caps the number of bars', () => {
    const r = parseSettings({ ...base, timeframe: '1m', startDate: '2026-01-01' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^range too large: \d+ bars \(max 100000\)/);
  });
});
```

`src/ui/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Stats } from '../engine/stats';
import { fmtNum, fmtPct, fmtTime, statsRows } from './format';

describe('formatting', () => {
  it('formats numbers, percents and special values', () => {
    expect(fmtNum(12345.678)).toBe('12,345.68');
    expect(fmtNum(NaN)).toBe('—');
    expect(fmtNum(Infinity)).toBe('∞');
    expect(fmtPct(-3.14159)).toBe('-3.14%');
    expect(fmtPct(NaN)).toBe('—');
  });

  it('formats times in UTC', () => {
    expect(fmtTime(Date.parse('2026-10-05T07:30:00Z'))).toBe('2026-10-05 07:30');
  });
});

describe('statsRows', () => {
  it('lists every stat in display order with tones', () => {
    const stats: Stats = {
      initialEquity: 10000, finalEquity: 11000, netProfit: 1000, totalReturnPct: 10, maxDrawdownPct: 5,
      winRatePct: 50, profitFactor: 1.5, sharpe: NaN, tradeCount: 4, exposurePct: 75,
    };
    expect(statsRows(stats)).toEqual([
      { label: 'Total return', value: '10.00%', tone: 'pos' },
      { label: 'Net profit', value: '1,000.00', tone: 'pos' },
      { label: 'Final equity', value: '11,000.00', tone: 'neutral' },
      { label: 'Max drawdown', value: '5.00%', tone: 'neg' },
      { label: 'Win rate', value: '50.00%', tone: 'neutral' },
      { label: 'Profit factor', value: '1.50', tone: 'pos' },
      { label: 'Sharpe', value: '—', tone: 'neutral' },
      { label: 'Trades', value: '4', tone: 'neutral' },
      { label: 'Exposure', value: '75.00%', tone: 'neutral' },
    ]);
  });
});
```

`src/ui/markers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Fill } from '../engine/types';
import { fillsToMarkers } from './markers';

const fill = (side: Fill['side'], reason: Fill['reason'], time: number): Fill => ({
  orderId: 1, bar: 1, time, side, qty: 1, price: 100, fee: 0, reason,
});

describe('fillsToMarkers', () => {
  it('maps buys below and sells above the bar, labelled by reason', () => {
    expect(fillsToMarkers([fill('buy', 'market', 3_600_000), fill('sell', 'stopLoss', 7_200_000)])).toEqual([
      { time: 3600, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', text: 'Buy' },
      { time: 7200, position: 'aboveBar', shape: 'arrowDown', color: '#ef5350', text: 'Sell SL' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/ui/settings.test.ts src/ui/format.test.ts src/ui/markers.test.ts`
Expected: 3 files FAIL — `Failed to resolve import` (`./settings`, `./format`, `./markers`).

- [ ] **Step 3: Implement settings parsing** — `src/ui/settings.ts`

```ts
import { isTimeframe, timeframeToMs, type Timeframe } from '../data/types';
import type { BrokerConfig } from '../engine/types';

/** Top-bar field values exactly as typed (strings). Fees are in percent, slippage in bps. */
export interface RawSettings {
  symbol: string;
  timeframe: string;
  startDate: string; // YYYY-MM-DD, UTC midnight
  balance: string;
  leverage: string;
  takerFeePct: string;
  makerFeePct: string;
  slippageBps: string;
}

export interface RunSettings {
  symbol: string;
  timeframe: Timeframe;
  startMs: number;
  broker: BrokerConfig;
}

export type ParseResult = { ok: true; settings: RunSettings } | { ok: false; error: string };

/** Largest range a single run may load (keeps memory and Binance request count sane). */
export const MAX_BARS = 100_000;

const DAY_MS = 86_400_000;

/** UTC date `days` before now, as YYYY-MM-DD. */
export function defaultStartDate(nowMs: number, days = 90): string {
  return new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10);
}

export function defaultRawSettings(nowMs: number): RawSettings {
  return {
    symbol: 'BTCUSDT',
    timeframe: '1h',
    startDate: defaultStartDate(nowMs),
    balance: '10000',
    leverage: '1',
    takerFeePct: '0.04',
    makerFeePct: '0.02',
    slippageBps: '2',
  };
}

function num(value: string): number {
  return value.trim() === '' ? NaN : Number(value);
}

export function parseSettings(raw: RawSettings, nowMs: number): ParseResult {
  const symbol = raw.symbol.trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(symbol)) return { ok: false, error: 'symbol must be 2-20 letters/digits, e.g. BTCUSDT' };
  if (!isTimeframe(raw.timeframe)) return { ok: false, error: `unsupported timeframe: ${raw.timeframe}` };
  const timeframe = raw.timeframe;

  const startMs = /^\d{4}-\d{2}-\d{2}$/.test(raw.startDate) ? Date.parse(`${raw.startDate}T00:00:00Z`) : NaN;
  if (!Number.isFinite(startMs)) return { ok: false, error: 'start date must be YYYY-MM-DD' };
  if (startMs >= nowMs) return { ok: false, error: 'start date must be in the past' };
  const bars = Math.floor((nowMs - startMs) / timeframeToMs(timeframe));
  if (bars > MAX_BARS) {
    return { ok: false, error: `range too large: ${bars} bars (max ${MAX_BARS}); pick a later start date or a larger timeframe` };
  }

  const balance = num(raw.balance);
  if (!(balance > 0)) return { ok: false, error: 'balance must be greater than 0' };
  const leverage = num(raw.leverage);
  if (!(leverage >= 1 && leverage <= 125)) return { ok: false, error: 'leverage must be between 1 and 125' };
  const taker = num(raw.takerFeePct);
  const maker = num(raw.makerFeePct);
  if (!(taker >= 0 && taker <= 1) || !(maker >= 0 && maker <= 1)) return { ok: false, error: 'fees must be between 0% and 1%' };
  const slippageBps = num(raw.slippageBps);
  if (!(slippageBps >= 0 && slippageBps <= 1000)) return { ok: false, error: 'slippage must be between 0 and 1000 bps' };

  return {
    ok: true,
    settings: {
      symbol,
      timeframe,
      startMs,
      broker: { initialBalance: balance, leverage, takerFee: taker / 100, makerFee: maker / 100, slippageBps },
    },
  };
}
```

- [ ] **Step 4: Implement formatting** — `src/ui/format.ts`

```ts
import type { Stats } from '../engine/stats';

/** Fixed-decimals number; NaN -> em dash, ±Infinity -> ∞ / -∞. */
export function fmtNum(value: number, digits = 2): string {
  if (Number.isNaN(value)) return '—';
  if (value === Infinity) return '∞';
  if (value === -Infinity) return '-∞';
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtPct(value: number, digits = 2): string {
  const s = fmtNum(value, digits);
  return Number.isFinite(value) ? `${s}%` : s;
}

/** Epoch ms -> 'YYYY-MM-DD HH:mm' in UTC. */
export function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

export interface StatRow {
  label: string;
  value: string;
  tone: 'pos' | 'neg' | 'neutral';
}

function tone(value: number): StatRow['tone'] {
  return value > 0 ? 'pos' : value < 0 ? 'neg' : 'neutral';
}

/** The stats panel's cards, in display order. */
export function statsRows(s: Stats): StatRow[] {
  return [
    { label: 'Total return', value: fmtPct(s.totalReturnPct), tone: tone(s.totalReturnPct) },
    { label: 'Net profit', value: fmtNum(s.netProfit), tone: tone(s.netProfit) },
    { label: 'Final equity', value: fmtNum(s.finalEquity), tone: 'neutral' },
    { label: 'Max drawdown', value: fmtPct(s.maxDrawdownPct), tone: s.maxDrawdownPct > 0 ? 'neg' : 'neutral' },
    { label: 'Win rate', value: fmtPct(s.winRatePct), tone: 'neutral' },
    { label: 'Profit factor', value: fmtNum(s.profitFactor), tone: Number.isNaN(s.profitFactor) ? 'neutral' : tone(s.profitFactor - 1) },
    { label: 'Sharpe', value: fmtNum(s.sharpe), tone: Number.isNaN(s.sharpe) ? 'neutral' : tone(s.sharpe) },
    { label: 'Trades', value: String(s.tradeCount), tone: 'neutral' },
    { label: 'Exposure', value: fmtPct(s.exposurePct), tone: 'neutral' },
  ];
}
```

- [ ] **Step 5: Implement trade markers** — `src/ui/markers.ts`

```ts
import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import type { Fill, FillReason } from '../engine/types';
import { DOWN_COLOR, UP_COLOR, toChartTime } from './chartData';

const LABEL: Record<FillReason, string> = {
  market: '',
  limit: 'L',
  stop: 'S',
  stopLoss: 'SL',
  takeProfit: 'TP',
  wiped: 'WIPED',
};

/** One chart marker per fill: buys below the bar (green up arrow), sells above (red down arrow). */
export function fillsToMarkers(fills: readonly Fill[]): SeriesMarker<UTCTimestamp>[] {
  return fills.map((f) => {
    const tag = LABEL[f.reason];
    const text = f.side === 'buy' ? `Buy${tag ? ' ' + tag : ''}` : `Sell${tag ? ' ' + tag : ''}`;
    return f.side === 'buy'
      ? { time: toChartTime(f.time), position: 'belowBar', shape: 'arrowUp', color: UP_COLOR, text }
      : { time: toChartTime(f.time), position: 'aboveBar', shape: 'arrowDown', color: DOWN_COLOR, text };
  });
}
```

- [ ] **Step 6: Run the new tests**

Run: `npx vitest run src/ui`
Expected: 5 files, 22 tests passed.

- [ ] **Step 7: Add markers to the chart** — replace `src/ui/chart.ts`

```ts
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../data/types';
import { DOWN_COLOR, UP_COLOR, candleToBar, candleToVolume } from './chartData';
import { computeOverlaySeries, overlayPoint, type OverlayDef } from './overlays';

interface ActiveOverlay {
  def: OverlayDef;
  step: (candle: Candle) => Record<string, number>;
  series: Record<string, ISeriesApi<'Line'>>;
}

/** Thin wrapper around a lightweight-charts v5 chart: candles + volume on pane 0, overlays on pane 0 or sub-panes. */
export class ChartPanel {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private overlays: ActiveOverlay[] = [];
  private markers: ISeriesMarkersPluginApi<Time> | null = null;
  private lastTime = -Infinity;

  constructor(private readonly container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    this.candles = this.chart.addSeries(CandlestickSeries, {
      upColor: UP_COLOR,
      downColor: DOWN_COLOR,
      borderVisible: false,
      wickUpColor: UP_COLOR,
      wickDownColor: DOWN_COLOR,
    });
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: '', priceFormat: { type: 'volume' } });
    this.volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  /** Replaces all candles and fits the view. Call setOverlays afterwards to recompute overlays. */
  setCandles(candles: readonly Candle[]): void {
    this.candles.setData(candles.map(candleToBar));
    this.volume.setData(candles.map(candleToVolume));
    this.lastTime = candles.length > 0 ? candles[candles.length - 1].time : -Infinity;
    this.fit();
  }

  /**
   * Fits all bars into view. If the container has no width yet (hidden tab/pane), waits until it gets one:
   * autoSize applies the real width asynchronously and fitContent on a zero-width chart is a no-op.
   */
  fit(): void {
    const fitNow = () => requestAnimationFrame(() => this.chart.timeScale().fitContent());
    if (this.container.clientWidth > 0) {
      fitNow();
      return;
    }
    const observer = new ResizeObserver(() => {
      if (this.container.clientWidth === 0) return;
      observer.disconnect();
      fitNow();
    });
    observer.observe(this.container);
  }

  /** Updates the forming bar or appends a new one. Older bars are ignored (the library throws on them). */
  updateCandle(candle: Candle): void {
    if (candle.time < this.lastTime) return;
    this.candles.update(candleToBar(candle));
    this.volume.update(candleToVolume(candle));
    this.lastTime = candle.time;
  }

  /** Removes every overlay and draws `defs` computed over `candles`. Sub-pane overlays get one pane each. */
  setOverlays(defs: readonly OverlayDef[], candles: readonly Candle[]): void {
    for (const o of this.overlays) for (const s of Object.values(o.series)) this.chart.removeSeries(s);
    this.overlays = [];
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);

    let nextPane = 1;
    for (const def of defs) {
      const paneIndex = def.pane === 'price' ? 0 : nextPane++;
      const step = def.create();
      const points = computeOverlaySeries(def, candles, step);
      const series: Record<string, ISeriesApi<'Line'>> = {};
      for (const line of def.lines) {
        series[line.key] = this.chart.addSeries(
          LineSeries,
          {
            color: line.color,
            lineWidth: 1,
            priceLineVisible: false,
            lastValueVisible: false,
            title: line.key === 'value' ? def.label : line.key,
          },
          paneIndex,
        );
        series[line.key].setData(points[line.key]);
      }
      this.overlays.push({ def, step, series });
    }
    const panes = this.chart.panes();
    if (panes.length > 1) panes[0].setStretchFactor(3);
  }

  /** Replaces the trade markers on the candle series (empty array clears them). Markers must be sorted by time. */
  setMarkers(markers: SeriesMarker<UTCTimestamp>[]): void {
    if (this.markers === null) this.markers = createSeriesMarkers(this.candles, markers);
    else this.markers.setMarkers(markers);
  }

  /** Feeds one newly CLOSED candle to every overlay (O(1) per overlay). */
  updateOverlays(candle: Candle): void {
    for (const o of this.overlays) {
      const values = o.step(candle);
      for (const line of o.def.lines) o.series[line.key].update(overlayPoint(candle.time, values[line.key]));
    }
  }

  destroy(): void {
    this.chart.remove();
  }
}
```

- [ ] **Step 8: Stats panel** — `src/ui/statsPanel.ts`

```ts
import { ColorType, LineSeries, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import type { BacktestResult } from '../engine/engine';
import { toChartTime } from './chartData';
import { h } from './dom';
import { fmtNum, fmtTime, statsRows } from './format';

const MAX_TRADE_ROWS = 500;

/** Bottom panel: stat cards + equity curve on the left, trade list and log on the right. */
export class StatsPanel {
  private readonly cards: HTMLElement;
  private readonly equityChart: IChartApi;
  private readonly equitySeries: ISeriesApi<'Line'>;
  private readonly trades: HTMLElement;
  private readonly log: HTMLElement;

  constructor(container: HTMLElement) {
    this.cards = h('div', { class: 'stat-cards' });
    const equityEl = h('div', { class: 'equity' });
    this.trades = h('div', { class: 'trades' });
    this.log = h('div', { class: 'log' });
    container.append(
      h('div', { class: 'stats-left' }, this.cards, equityEl),
      h('div', { class: 'stats-right' }, this.trades, this.log),
    );
    this.equityChart = createChart(equityEl, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { visible: false }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true },
    });
    this.equitySeries = this.equityChart.addSeries(LineSeries, { color: '#42a5f5', lineWidth: 2, title: 'Equity' });
    this.clear();
  }

  clear(): void {
    this.cards.replaceChildren(h('div', { class: 'hint' }, 'Press Run to backtest the SMA 10/30 cross strategy.'));
    this.equitySeries.setData([]);
    this.trades.replaceChildren();
    this.log.replaceChildren();
  }

  render(result: BacktestResult): void {
    this.cards.replaceChildren(
      ...statsRows(result.stats).map((row) =>
        h('div', { class: `card ${row.tone}` }, h('div', { class: 'label' }, row.label), h('div', { class: 'value' }, row.value)),
      ),
    );
    if (result.wiped) this.cards.append(h('div', { class: 'card neg wiped' }, 'ACCOUNT WIPED'));

    this.equitySeries.setData(result.equityCurve.map((p) => ({ time: toChartTime(p.time), value: p.equity })));
    requestAnimationFrame(() => this.equityChart.timeScale().fitContent());

    const header = h('tr', {}, ...['#', 'Side', 'Entry', 'Entry px', 'Exit', 'Exit px', 'Qty', 'Net PnL', 'Exit by'].map((t) => h('th', {}, t)));
    const shown = result.trades.slice(-MAX_TRADE_ROWS);
    const offset = result.trades.length - shown.length;
    const rows = shown.map((t, i) =>
      h(
        'tr', {},
        h('td', {}, String(offset + i + 1)),
        h('td', { class: t.side === 'long' ? 'pos' : 'neg' }, t.side),
        h('td', {}, fmtTime(t.entryTime)),
        h('td', {}, fmtNum(t.entryPrice)),
        h('td', {}, fmtTime(t.exitTime)),
        h('td', {}, fmtNum(t.exitPrice)),
        h('td', {}, fmtNum(t.qty, 4)),
        h('td', { class: t.netPnl >= 0 ? 'pos' : 'neg' }, fmtNum(t.netPnl)),
        h('td', {}, t.exitReason),
      ),
    );
    const note = offset > 0 ? [h('div', { class: 'hint' }, `showing last ${MAX_TRADE_ROWS} of ${result.trades.length} trades`)] : [];
    this.trades.replaceChildren(...note, h('table', {}, h('thead', {}, header), h('tbody', {}, ...rows)));

    this.log.replaceChildren(
      ...result.log.map((l) => h('div', { class: `log-${l.level}` }, `${fmtTime(l.time)}  ${l.message}`)),
    );
  }
}
```

- [ ] **Step 9: Top bar** — `src/ui/topbar.ts`

```ts
import { TIMEFRAMES } from '../data/types';
import { h } from './dom';
import type { RawSettings } from './settings';

export interface TopBar {
  read(): RawSettings;
  setRunning(running: boolean): void;
  /** Element where extra controls (the overlay picker) can be appended. */
  readonly extras: HTMLElement;
}

/** Builds the run form: product, timeframe, start date, balance, leverage, fees, slippage, Run. */
export function createTopBar(container: HTMLElement, initial: RawSettings, onRun: () => void): TopBar {
  const input = (name: keyof RawSettings, type: string, width: string, attrs: Record<string, string> = {}) => {
    const el = h('input', { name, type, style: `width:${width}`, ...attrs });
    el.value = initial[name];
    return el;
  };
  const symbol = input('symbol', 'text', '90px', { list: 'symbols' });
  const symbols = h('datalist', { id: 'symbols' }, ...['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'].map((s) => h('option', { value: s })));
  const timeframe = h('select', { name: 'timeframe' }, ...TIMEFRAMES.map((tf) => h('option', { value: tf }, tf)));
  timeframe.value = initial.timeframe;
  const startDate = input('startDate', 'date', '130px');
  const balance = input('balance', 'number', '90px', { min: '0', step: '100' });
  const leverage = input('leverage', 'number', '55px', { min: '1', max: '125', step: '1' });
  const takerFeePct = input('takerFeePct', 'number', '60px', { min: '0', step: '0.01' });
  const makerFeePct = input('makerFeePct', 'number', '60px', { min: '0', step: '0.01' });
  const slippageBps = input('slippageBps', 'number', '55px', { min: '0', step: '1' });
  const run = h('button', { type: 'submit', class: 'run' }, 'Run');

  const field = (label: string, el: HTMLElement) => h('label', {}, h('span', {}, label), el);
  const form = h(
    'form', { class: 'run-form' },
    field('Product', symbol), symbols,
    field('TF', timeframe),
    field('Start', startDate),
    field('Balance', balance),
    field('Leverage', leverage),
    field('Taker %', takerFeePct),
    field('Maker %', makerFeePct),
    field('Slip bps', slippageBps),
    run,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    onRun();
  });
  const extras = h('div', { class: 'extras' });
  container.append(form, extras);

  return {
    extras,
    read: () => ({
      symbol: symbol.value,
      timeframe: timeframe.value,
      startDate: startDate.value,
      balance: balance.value,
      leverage: leverage.value,
      takerFeePct: takerFeePct.value,
      makerFeePct: makerFeePct.value,
      slippageBps: slippageBps.value,
    }),
    setRunning(running: boolean) {
      run.disabled = running;
      run.textContent = running ? 'Running…' : 'Run';
    },
  };
}
```

- [ ] **Step 10: Wire the run flow** — replace `src/main.ts`

```ts
import './style.css';
import type { CandleSubscription } from './data/adapter';
import { BinanceFuturesAdapter } from './data/binance';
import type { Candle } from './data/types';
import { DEFAULT_SMA_CROSS } from './engine/strategies/smaCross';
import { ChartPanel } from './ui/chart';
import { fillsToMarkers } from './ui/markers';
import { renderOverlayPicker } from './ui/overlayPicker';
import { OVERLAYS, smaOverlay, type OverlayDef } from './ui/overlays';
import { defaultRawSettings, parseSettings, type RunSettings } from './ui/settings';
import { StatsPanel } from './ui/statsPanel';
import { createTopBar } from './ui/topbar';
import { runBacktestInWorker } from './worker/client';

/** The hard-coded strategy's own lines, always drawn. */
const STRATEGY_OVERLAYS: OverlayDef[] = [
  smaOverlay(DEFAULT_SMA_CROSS.fast, '#f5c542', 'strategy-fast'),
  smaOverlay(DEFAULT_SMA_CROSS.slow, '#42a5f5', 'strategy-slow'),
];

function setStatus(text: string, isError = false): void {
  const status = document.getElementById('status')!;
  status.textContent = text;
  status.classList.toggle('error', isError);
}

const adapter = new BinanceFuturesAdapter();
const chart = new ChartPanel(document.getElementById('chart')!);
const stats = new StatsPanel(document.getElementById('stats')!);
let candles: Candle[] = [];
let live: CandleSubscription | null = null;
let pickedOverlayIds: string[] = [];

function applyOverlays(): void {
  chart.setOverlays([...STRATEGY_OVERLAYS, ...OVERLAYS.filter((d) => pickedOverlayIds.includes(d.id))], candles);
}

/** Loads history from `settings.startMs` to now, redraws the chart and restarts the live stream. */
async function loadMarket(settings: RunSettings): Promise<void> {
  live?.close();
  live = null;
  setStatus(`Loading ${settings.symbol} ${settings.timeframe} candles…`);
  candles = await adapter.fetchCandles(settings.symbol, settings.timeframe, settings.startMs, Date.now());
  chart.setCandles(candles);
  chart.setMarkers([]);
  applyOverlays();
  live = adapter.subscribeCandles(
    settings.symbol,
    settings.timeframe,
    (candle, closed) => {
      chart.updateCandle(candle);
      if (closed && (candles.length === 0 || candle.time > candles[candles.length - 1].time)) {
        candles.push(candle);
        chart.updateOverlays(candle);
      }
    },
    (err) => setStatus(err.message, true),
  );
}

async function run(): Promise<void> {
  const parsed = parseSettings(topBar.read(), Date.now());
  if (!parsed.ok) {
    setStatus(parsed.error, true);
    return;
  }
  const settings = parsed.settings;
  topBar.setRunning(true);
  stats.clear();
  try {
    await loadMarket(settings);
    if (candles.length < 2) throw new Error('not enough candles in the selected range');
    setStatus(`Running backtest on ${candles.length} bars…`);
    const result = await runBacktestInWorker({
      type: 'run',
      candles,
      config: { symbol: settings.symbol, timeframe: settings.timeframe, broker: settings.broker },
      strategy: { id: 'smaCross', params: DEFAULT_SMA_CROSS },
    });
    chart.setMarkers(fillsToMarkers(result.fills));
    stats.render(result);
    setStatus(
      `Backtest done: ${result.barsProcessed} bars, ${result.trades.length} trades` +
        (result.wiped ? ' (ACCOUNT WIPED)' : '') +
        '. Indicator warm-up bars may differ slightly from TradingView.',
    );
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  } finally {
    topBar.setRunning(false);
  }
}

const topBar = createTopBar(document.getElementById('topbar')!, defaultRawSettings(Date.now()), () => void run());
renderOverlayPicker(topBar.extras, OVERLAYS, pickedOverlayIds, (ids) => {
  pickedOverlayIds = ids;
  applyOverlays();
});

const initial = parseSettings(topBar.read(), Date.now());
if (initial.ok) {
  loadMarket(initial.settings)
    .then(() => setStatus(`${initial.settings.symbol} ${initial.settings.timeframe}: ${candles.length} bars, streaming live. Press Run to backtest.`))
    .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
}
```

- [ ] **Step 11: Styles** — replace `src/style.css`

```css
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body {
  background: #131722;
  color: #d1d4dc;
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif;
  display: flex;
  flex-direction: column;
}
input, select, button {
  background: #1e222d;
  color: #d1d4dc;
  border: 1px solid #2a2e39;
  border-radius: 3px;
  padding: 3px 5px;
  font: inherit;
}
button.run { background: #2962ff; border-color: #2962ff; color: #fff; padding: 4px 16px; cursor: pointer; }
button.run:disabled { opacity: 0.6; cursor: progress; }

#topbar { padding: 6px 10px; border-bottom: 1px solid #2a2e39; }
.run-form { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; }
.run-form label { display: flex; flex-direction: column; font-size: 11px; color: #787b86; }
.extras { margin-top: 6px; }
.overlay-picker label { margin-right: 10px; white-space: nowrap; cursor: pointer; }

#main { flex: 1; display: flex; flex-direction: column; min-height: 0; }
#chart { flex: 1; min-height: 300px; }

#stats { border-top: 1px solid #2a2e39; display: flex; height: 260px; }
.stats-left { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.stats-right { width: 50%; display: flex; flex-direction: column; border-left: 1px solid #2a2e39; min-width: 0; }
.stat-cards { display: flex; flex-wrap: wrap; gap: 6px; padding: 6px; }
.card { background: #1e222d; border-radius: 4px; padding: 4px 8px; min-width: 92px; }
.card .label { font-size: 11px; color: #787b86; }
.card .value { font-size: 15px; font-weight: 600; }
.card.wiped { font-weight: 700; align-self: center; }
.equity { flex: 1; min-height: 90px; }
.trades { flex: 1; overflow: auto; }
.trades table { width: 100%; border-collapse: collapse; font-size: 12px; }
.trades th, .trades td { padding: 2px 6px; text-align: right; border-bottom: 1px solid #1e222d; white-space: nowrap; }
.trades th { position: sticky; top: 0; background: #131722; color: #787b86; }
.log { max-height: 70px; overflow: auto; border-top: 1px solid #2a2e39; padding: 2px 6px; font: 11px/1.4 ui-monospace, monospace; }
.log-warn { color: #ffb74d; }
.log-error { color: #ef5350; }
.pos { color: #26a69a; }
.neg { color: #ef5350; }
.hint { color: #787b86; padding: 6px; }

#status { padding: 4px 10px; border-top: 1px solid #2a2e39; color: #787b86; }
#status.error { color: #ef5350; }
```

- [ ] **Step 12: Typecheck, test, build**

Run: `npm test; npm run build`
Expected: 19 files, 98 tests passed; `tsc` clean; build succeeds with the worker chunk.

- [ ] **Step 13: Manual browser verification (milestones 1-3, full flow)**

Run: `npm run dev`, open `http://localhost:5173/`, open DevTools console.
- [ ] Top bar shows Product `BTCUSDT`, TF `1h`, Start = 90 days ago, Balance `10000`, Leverage `1`, Taker % `0.04`, Maker % `0.02`, Slip bps `2`, a blue **Run** button, and the overlay checkbox row.
- [ ] On load: ~2,160 1h candles fill the chart with yellow SMA 10 and blue SMA 30 lines; footer `BTCUSDT 1h: N bars, streaming live. Press Run to backtest.`; stats area shows the "Press Run…" hint.
- [ ] Click **Run**: button shows `Running…` then `Run`; footer `Backtest done: N bars, T trades. Indicator warm-up bars may differ slightly from TradingView.` (observed 2026-10-05: 2166 bars, 76 trades).
- [ ] Green `Buy` arrows below bars and red `Sell` arrows above bars appear only where the SMA 10/30 lines crossed on the PREVIOUS bar (fills at the next open, no look-ahead).
- [ ] Nine stat cards (Total return, Net profit, Final equity, Max drawdown, Win rate, Profit factor, Sharpe, Trades, Exposure); Trades equals the number of rows in the trade table; the equity curve spans the whole range.
- [ ] Click **Run** again with identical inputs within the same bar period (no new candle closed in between): every stat card value is identical (determinism; the automated proof is the Task 8 determinism test).
- [ ] Set Leverage `125`, Run: footer contains `(ACCOUNT WIPED)`, an `ACCOUNT WIPED` card appears, the last trade's "Exit by" is `wiped`, the log shows `account wiped: equity <= 0, run stopped`.
- [ ] Set Start to a future date, Run: red footer `start date must be in the past`, no request is sent.
- [ ] Set Product `NOPEUSDT`, Run: red footer starting `Binance HTTP 400`, Run button re-enabled.
- [ ] Set TF `1m` and Start a year back: red footer starting `range too large:`.
- [ ] Tick RSI 14: a sub-pane appears; trade markers and SMA lines remain.
- [ ] Console shows no errors other than the intentional HTTP 400.
Stop the dev server.

- [ ] **Step 14: Commit**

```bash
git add src/ui src/main.ts src/style.css
git commit -m "feat(ui): backtest run flow with top bar, trade markers, stats panel and equity curve"
```

---

## Spec coverage (milestones 1-3)

| Spec requirement | Task |
|---|---|
| Vite + TypeScript + Vitest scaffold, lightweight-charts v5 | 1, 3 |
| `data/` Binance REST klines, normalized `Candle`, swappable adapter interface, fallback host possible | 2 |
| `data/` websocket live candles | 2, 3 |
| Chart showing live and historical candles (milestone 1) | 3 |
| Indicators SMA, EMA, RMA, WMA, highest, lowest, change, tr, crossover/crossunder, O(1) | 4 |
| Indicators RSI, MACD, Bollinger Bands, ATR, Stochastic, VWAP; TradingView seeding; hand-verified tests | 5 |
| Indicator overlays and sub-panes on the chart (milestone 2) | 6 |
| Broker: market at next open, limit/stop vs high/low, SL/TP with SL-first tie-break, gap fills at open, fees, slippage, margin rejection logged, one net position (reduce/flip), defaults 0.04/0.02/2 bps | 7 |
| Engine per-bar loop (broker then strategy), no look-ahead, equity ≤ 0 stops run "account wiped", determinism test | 8 |
| Stats: total return, max drawdown, win rate, profit factor, Sharpe (annualized by timeframe), trade count, exposure | 8 |
| Backtest with hard-coded strategy, engine in a Web Worker | 8, 9 |
| UI top bar (product, timeframe, start date, balance, leverage, fee, slippage, Run), chart with markers/overlays, stats panel with equity curve, trade list, log | 9 |
| Manual browser check at the end of each milestone | 3, 6, 9 |
| Interfaces ready for Blockly/Pine/live (`Strategy`, `StrategyContext`, `Engine.pushCandle`, `StrategySpec` union, `MarketDataAdapter`) | 2, 8 |
