import './style.css';
import { compileBlocks } from './blocks/compiler';
import type { CompileIssue, IndicatorUse } from './blocks/generator';
import type { CandleSubscription } from './data/adapter';
import { BinanceFuturesAdapter } from './data/binance';
import type { Candle } from './data/types';
import { DEFAULT_SMA_CROSS } from './engine/strategies/smaCross';
import { createBlockEditor } from './ui/blockEditor';
import { blockIndicatorOverlays } from './ui/blockOverlays';
import { ChartPanel } from './ui/chart';
import { h } from './ui/dom';
import { createProblemsView, createStrategyPicker, setupLayout, type LeftTab } from './ui/layout';
import { syncPineIndicators } from './pine/library';
import { createPineEditor } from './ui/pineEditor';
import { loadPineRecords } from './ui/pineStore';
import { fillsToMarkers } from './ui/markers';
import { renderOverlayPicker } from './ui/overlayPicker';
import { OVERLAYS, smaOverlay, type OverlayDef } from './ui/overlays';
import { defaultRawSettings, parseSettings, type RunSettings } from './ui/settings';
import { StatsPanel } from './ui/statsPanel';
import { loadText, saveText } from './ui/storage';
import { createTopBar } from './ui/topbar';
import { BacktestError, runBacktestInWorker } from './worker/client';
import type { StrategySpec } from './worker/protocol';

type StrategyChoice = 'blocks' | 'smaCross';
const STRATEGY_STORAGE_KEY = 'quant-sim.strategy';
const LEFT_TAB_STORAGE_KEY = 'quant-sim.left-tab';

// Pine indicators must be registered before the block editor loads a workspace that uses them.
let pineRecords = loadPineRecords();
const pineStartup = syncPineIndicators(pineRecords).filter((r) => !r.ok);

/** The hard-coded strategy's own lines, drawn while it is selected. */
const SMA_CROSS_OVERLAYS: OverlayDef[] = [
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
let strategyChoice: StrategyChoice = loadText(STRATEGY_STORAGE_KEY) === 'smaCross' ? 'smaCross' : 'blocks';
/** Indicators used by the current block workspace (last successful compile), drawn automatically. */
let blockIndicators: IndicatorUse[] = [];
let blockOverlayKey = '';
let compileState: { errors: CompileIssue[]; warnings: CompileIssue[] } = { errors: [], warnings: [] };

function strategyOverlays(): OverlayDef[] {
  return strategyChoice === 'smaCross' ? SMA_CROSS_OVERLAYS : blockIndicatorOverlays(blockIndicators);
}

function applyOverlays(): void {
  chart.setOverlays([...strategyOverlays(), ...OVERLAYS.filter((d) => pickedOverlayIds.includes(d.id))], candles);
}

const problems = createProblemsView(document.getElementById('problems')!, (blockId, message) => editor.highlightError(blockId, message));

/** Recompiles on every workspace edit: problems list, warning icons, status line, auto-drawn indicators. */
function onWorkspaceChange(json: unknown): void {
  const result = compileBlocks(json);
  const hadErrors = compileState.errors.length > 0;
  compileState = result.ok ? { errors: [], warnings: result.warnings } : { errors: result.errors, warnings: result.warnings };
  problems.show(compileState.errors, compileState.warnings);
  editor.showIssues([...compileState.errors, ...compileState.warnings]);
  if (!result.ok) {
    setStatus(`Blocks: ${result.errors.length} problem${result.errors.length > 1 ? 's' : ''}: ${result.errors[0].message}`, true);
    return;
  }
  if (hadErrors) setStatus('Blocks compile again. Press Run to backtest.');
  const overlayKey = JSON.stringify(result.program.indicators.map(({ blockId: _id, ...use }) => use));
  blockIndicators = result.program.indicators;
  if (overlayKey !== blockOverlayKey && strategyChoice === 'blocks') {
    blockOverlayKey = overlayKey;
    applyOverlays();
  }
}

const editor = createBlockEditor(document.getElementById('blockly')!, onWorkspaceChange);
if (editor.restored === 'default-after-error') setStatus('The saved block workspace could not be loaded; the SMA cross example was restored.', true);
if (pineStartup.length > 0) setStatus(`${pineStartup.length} saved Pine script${pineStartup.length > 1 ? 's do' : ' does'} not compile; open the Pine tab to fix ${pineStartup.length > 1 ? 'them' : 'it'}.`, true);

const pineEditor = createPineEditor(document.getElementById('pine')!, {
  records: pineRecords,
  onChange(records) {
    pineRecords = records;
    const results = syncPineIndicators(records);
    blockOverlayKey = ''; // same parameters may now mean different code: redraw
    editor.refreshIndicators();
    return results;
  },
});

const initialTab: LeftTab = loadText(LEFT_TAB_STORAGE_KEY) === 'pine' ? 'pine' : 'blocks';
setupLayout(document.getElementById('pane-switch')!, document.getElementById('left-tabs')!, (pane) => {
  if (pane === 'left') editor.resize();
}, initialTab, (tab) => {
  saveText(LEFT_TAB_STORAGE_KEY, tab);
  if (tab === 'blocks') editor.resize();
  else pineEditor.refresh();
});
new ResizeObserver(() => editor.resize()).observe(document.getElementById('blockly')!);
const resetButton = h('button', { type: 'button', class: 'reset-blocks', title: 'Replace the workspace with the SMA cross example' }, 'Reset to example');
resetButton.addEventListener('click', () => {
  if (window.confirm('Replace your blocks with the SMA 10/30 cross example?')) editor.resetToExample();
});
document.getElementById('left-tabs')!.append(resetButton);

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

/** The spec for the selected strategy, or null (with the problems shown) when the blocks do not compile. */
function strategySpec(): StrategySpec | null {
  if (strategyChoice === 'smaCross') return { id: 'smaCross', params: DEFAULT_SMA_CROSS };
  const workspace = editor.save();
  const result = compileBlocks(workspace);
  if (!result.ok) {
    problems.show(result.errors, result.warnings);
    editor.showIssues([...result.errors, ...result.warnings]);
    const first = result.errors.find((e) => e.blockId);
    if (first?.blockId) editor.highlightError(first.blockId, first.message);
    setStatus(`Cannot run: ${result.errors.length} block problem${result.errors.length > 1 ? 's' : ''}: ${result.errors[0].message}`, true);
    return null;
  }
  return { id: 'blocks', workspace, pineScripts: pineRecords };
}

async function run(): Promise<void> {
  const parsed = parseSettings(topBar.read(), Date.now());
  if (!parsed.ok) {
    setStatus(parsed.error, true);
    return;
  }
  const spec = strategySpec();
  if (!spec) return;
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
      strategy: spec,
    });
    chart.setMarkers(fillsToMarkers(result.fills));
    stats.render(result);
    setStatus(
      `Backtest done (${spec.id === 'blocks' ? 'block strategy' : 'built-in SMA cross'}): ${result.barsProcessed} bars, ${result.trades.length} trades` +
        (result.wiped ? ' (ACCOUNT WIPED)' : '') +
        '. Indicator warm-up bars may differ slightly from TradingView.',
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BacktestError && err.blockId) {
      editor.highlightError(err.blockId, message);
      setStatus(`Run halted by a block: ${message}`, true);
    } else {
      setStatus(message, true);
    }
  } finally {
    topBar.setRunning(false);
  }
}

const topBar = createTopBar(document.getElementById('topbar')!, defaultRawSettings(Date.now()), () => void run());
createStrategyPicker(topBar.extras, strategyChoice, (id) => {
  strategyChoice = id === 'smaCross' ? 'smaCross' : 'blocks';
  saveText(STRATEGY_STORAGE_KEY, strategyChoice);
  applyOverlays();
});
renderOverlayPicker(topBar.extras, OVERLAYS, pickedOverlayIds, (ids) => {
  pickedOverlayIds = ids;
  applyOverlays();
});

const initial = parseSettings(topBar.read(), Date.now());
if (initial.ok) {
  loadMarket(initial.settings)
    .then(() => {
      if (compileState.errors.length === 0) {
        setStatus(`${initial.settings.symbol} ${initial.settings.timeframe}: ${candles.length} bars, streaming live. Press Run to backtest.`);
      }
    })
    .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
}
