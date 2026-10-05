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
