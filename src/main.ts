import './style.css';
import { compileBlocks } from './blocks/compiler';
import { getIndicator } from './blocks/registry';
import type { CompileIssue, IndicatorUse } from './blocks/generator';
import type { CandleSubscription } from './data/adapter';
import { BinanceFuturesAdapter } from './data/binance';
import type { Candle } from './data/types';
import { DEFAULT_SMA_CROSS } from './engine/strategies/smaCross';
// Blockly (~800 kB) is loaded on demand (see editorLoader) so the chart and top bar render first.
import type { BlockEditor } from './ui/blockEditor';
import { describeFlowError, LazyLoader, notReadyMessage } from './ui/lazyLoader';
import { blockIndicatorOverlays, defaultIndicatorUse, zoneToggleOverlays } from './ui/blockOverlays';
import { ChartPanel } from './ui/chart';
import { h } from './ui/dom';
import { createProblemsView, createStrategyPicker, setupLayout, setupRowSplitter, setupSplitter, type LeftTab } from './ui/layout';
import { getStarter, STARTERS, type StarterDef, type StarterId } from './blocks/starters';
import { parseStoredFraction } from './ui/splitter';
import { StarterMemory } from './ui/starterMemory';
import { pickStarter as pickStarterFlow, restorePrevious as restorePreviousFlow, type FlowDeps } from './ui/starterFlow';
import { createStarterPicker } from './ui/starterPicker';
import { buildVerdict } from './ui/verdict';
import { ResultTracker, STALE_NOTE, workspaceKey, type RunKey } from './ui/resultFreshness';
import { VerdictView } from './ui/verdictView';
import { smaCrossHistoryNeed, strategyHistoryNeed, type HistoryNeed } from './ui/warmup';
import type { BacktestResult } from './engine/engine';
import { benchmarkDefinition, benchmarkLabel } from './engine/benchmark';
import { syncPineIndicators } from './pine/library';
import { createPineEditor } from './ui/pineEditor';
import { loadPineRecords, loadPineRetired, loadPineShown, savePineShown } from './ui/pineStore';
import { fillsToMarkers } from './ui/markers';
import { renderOverlayPicker } from './ui/overlayPicker';
import { OVERLAYS, smaOverlay, type OverlayDef } from './ui/overlays';
import { defaultRawSettings, defaultStartDate, parseSettings, type RunSettings } from './ui/settings';
import { blocksSnapshot, smaCrossSnapshot } from './live/session';
import type { SessionBase } from './ui/liveMode';
import { LiveTargets } from './ui/liveTargets';
import { StatsPanel } from './ui/statsPanel';
import { loadJson, loadText, saveJson, saveText } from './ui/storage';
import { createTopBar, type AppMode } from './ui/topbar';
import { BacktestError, runBacktestInWorker } from './worker/client';
import type { StrategySpec } from './worker/protocol';
import { createAppBar } from './ui/appbar';
import { buildStrategyFile, datedFileName, downloadFile, newPineScripts, parseStrategyFile } from './ui/exportFiles';
import { createHelpWindow } from './ui/help';
import { icon } from './ui/icons';
import { setupPanels } from './ui/panels';
import { savePineRecords } from './ui/pineStore';
import { initShortcuts } from './ui/shortcuts';
import { initTheme, toggleTheme } from './ui/theme';
import { addRun, parseRunHistory, RUN_HISTORY_STORAGE_KEY, type RunRecord } from './ui/runHistory';
import { infoButton, initTooltips, tip } from './ui/tooltip';
import { startTour, tourDone } from './ui/tour';
import { CANDLE_DB_NAME } from './data/candleCache';
import { DB_NAME as LIVE_DB_NAME } from './live/store';

initTheme();
initTooltips();

type StrategyChoice = 'blocks' | 'smaCross';
const STRATEGY_STORAGE_KEY = 'quant-sim.strategy';
const LEFT_TAB_STORAGE_KEY = 'quant-sim.left-tab';
const MODE_STORAGE_KEY = 'quant-sim.mode';
const OVERLAYS_STORAGE_KEY = 'quant-sim.overlays.v1';
const SPLIT_STORAGE_KEY = 'quant-sim.split.v1';
const RESULTS_HEIGHT_STORAGE_KEY = 'quant-sim.results-height.v1';

/** Top-bar picker: the classic overlays plus the zone indicators' "show on chart" toggles (default settings). */
const PICKER_OVERLAYS: OverlayDef[] = [...OVERLAYS, ...zoneToggleOverlays()];

/** Picked overlay ids remembered across reloads (unknown ids from storage are dropped). */
function loadPickedOverlays(): string[] {
  const saved = loadJson(OVERLAYS_STORAGE_KEY);
  const known = new Set(PICKER_OVERLAYS.map((d) => d.id));
  return Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
}

// Pine indicators must be registered before the block editor loads a workspace that uses them.
let pineRecords = loadPineRecords();
let pineRetired = loadPineRetired();
const pineStartup = syncPineIndicators(pineRecords, pineRetired).filter((r) => !r.ok);

/** The hard-coded strategy's own lines, drawn while it is selected. */
const SMA_CROSS_OVERLAYS: OverlayDef[] = [
  smaOverlay(DEFAULT_SMA_CROSS.fast, '#f5c542', 'strategy-fast'),
  smaOverlay(DEFAULT_SMA_CROSS.slow, '#42a5f5', 'strategy-slow'),
];

function setStatus(text: string, isError = false): void {
  const status = document.getElementById('status')!;
  status.textContent = text;
  status.classList.toggle('error', isError);
  status.dataset.tone = isError ? 'error' : /^(Backtest done|Loaded|Imported)/.test(text) ? 'ok' : 'info';
}

const adapter = new BinanceFuturesAdapter();
const chart = new ChartPanel(document.getElementById('chart')!);
const stats = new StatsPanel(document.getElementById('stats')!);
const verdict = new VerdictView(document.getElementById('verdict')!);
/** Recent backtests (Results › History), newest first. */
let runHistory: RunRecord[] = parseRunHistory(loadJson(RUN_HISTORY_STORAGE_KEY));
stats.setHistory(runHistory);
stats.onClearHistory = () => {
  if (!window.confirm('Forget all the tests in History? Your blocks and settings stay as they are.')) return;
  runHistory = [];
  saveJson(RUN_HISTORY_STORAGE_KEY, runHistory);
  stats.setHistory(runHistory);
};
const starterMemory = new StarterMemory({ get: loadJson, set: saveJson });
/** Which strategy + settings the results on screen were run with (stale / cleared handling). */
const results = new ResultTracker();
const staleNote = h('div', { class: 'stale-note', role: 'status' });
staleNote.hidden = true;
document.getElementById('verdict')!.before(staleNote);
let candles: Candle[] = [];
let live: CandleSubscription | null = null;
let pickedOverlayIds: string[] = loadPickedOverlays();
let strategyChoice: StrategyChoice = loadText(STRATEGY_STORAGE_KEY) === 'smaCross' ? 'smaCross' : 'blocks';
let mode: AppMode = loadText(MODE_STORAGE_KEY) === 'live' ? 'live' : 'backtest';
/** Created after the editor (whose first compile already redraws overlays). */
let liveMode: LiveTargets | null = null;
/** Indicators used by the current block workspace (last successful compile), drawn automatically. */
let blockIndicators: IndicatorUse[] = [];
let blockOverlayKey = '';
let compileState: { errors: CompileIssue[]; warnings: CompileIssue[] } = { errors: [], warnings: [] };

/** Saved Pine scripts drawn on the chart from the Pine tab ("Show on chart"). */
let pineShown = loadPineShown();

/** "Show on chart" scripts as indicator uses (defaults, every signal); unregistered ones are skipped. */
function shownUses(): IndicatorUse[] {
  return pineShown.flatMap((id) => {
    const def = getIndicator(id);
    return def ? [defaultIndicatorUse(def)] : [];
  });
}

function strategyOverlays(): OverlayDef[] {
  // Merged with the strategy's uses, so a shown script that the strategy also uses is drawn once.
  return strategyChoice === 'smaCross'
    ? [...SMA_CROSS_OVERLAYS, ...blockIndicatorOverlays(shownUses())]
    : blockIndicatorOverlays([...blockIndicators, ...shownUses()]);
}

function applyOverlays(): void {
  if (mode === 'live') {
    liveMode?.redrawOverlays(); // a live session draws its own snapshot's indicators
    return;
  }
  chart.setOverlays([...strategyOverlays(), ...PICKER_OVERLAYS.filter((d) => pickedOverlayIds.includes(d.id))], candles);
}

const problems = createProblemsView(document.getElementById('problems')!, (blockId, message) => editor?.highlightError(blockId, message));

/** Recompiles on every workspace edit: problems list, warning icons, status line, auto-drawn indicators. */
function onWorkspaceChange(json: unknown): void {
  refreshFreshness(); // an edit makes the shown results stale (an undo back to what ran makes them fresh again)
  const result = compileBlocks(json);
  const hadErrors = compileState.errors.length > 0;
  compileState = result.ok ? { errors: [], warnings: result.warnings } : { errors: result.errors, warnings: result.warnings };
  problems.show(compileState.errors, compileState.warnings);
  editor?.showIssues([...compileState.errors, ...compileState.warnings]);
  if (!result.ok) {
    // Keep drawing the last good indicators, except ones whose definition is gone (a deleted Pine script).
    const still = blockIndicators.filter((use) => getIndicator(use.indicatorId) !== undefined);
    if (still.length !== blockIndicators.length) {
      blockIndicators = still;
      blockOverlayKey = '';
      if (strategyChoice === 'blocks') applyOverlays();
    }
    setStatus(`Blocks: ${result.errors.length} problem${result.errors.length > 1 ? 's' : ''}: ${result.errors[0].message}`, true);
    return;
  }
  if (hadErrors) setStatus('All blocks are OK again. Press ▶ Run test to try them.');
  const overlayKey = JSON.stringify(result.program.indicators.map(({ blockId: _id, ...use }) => use));
  blockIndicators = result.program.indicators;
  if (overlayKey !== blockOverlayKey && strategyChoice === 'blocks') {
    blockOverlayKey = overlayKey;
    applyOverlays();
  }
}

/** The block editor, once its lazily loaded chunk (Blockly) is in; null until then. */
let editor: BlockEditor | null = null;
const blocklyEl = document.getElementById('blockly')!;
const blocksLoading = h('div', { class: 'blocks-loading', role: 'status' }, 'Loading blocks…');
blocklyEl.append(blocksLoading);
/**
 * The editor, once Blockly is loaded and the saved workspace restored. Everything that needs the blocks (Run with
 * the block strategy, "Start from…", a live session start) waits for get() or reads current (loading vs failed).
 * After a failed load, get() imports again: Run and the Retry button in the Blocks pane both retry.
 */
const editorLoader = new LazyLoader<BlockEditor>(() => import('./ui/blockEditor').then(({ createBlockEditor }) => {
  blocksLoading.remove();
  const ed = createBlockEditor(blocklyEl, onWorkspaceChange, (message) => setStatus(message, true));
  editor = ed;
  if (ed.restored === 'default-after-error') {
    setStatus(`The saved block workspace could not be loaded (${ed.loadError}). It is kept unchanged in browser storage; ` +
      "the SMA cross example is shown and edits are not saved until you pick a starter from 'Start from…'.", true);
  }
  // A fresh user starts on the SMA cross: remember it as an untouched starter (replacing it later needs no confirm).
  if (ed.restored === 'default') {
    starterMemory.recordLoaded('smaCross', JSON.stringify(ed.save()), getStarter('smaCross')!.label);
    fitSoon(); // a fresh user sees the whole starter strategy
  }
  refreshFreshness();
  return ed;
}), (error) => {
  const retry = h('button', { type: 'button', class: 'blocks-retry' }, 'Retry');
  retry.addEventListener('click', () => {
    blocksLoading.textContent = 'Loading blocks…';
    setStatus('Retrying the block editor load…');
    editorLoader.get().catch(() => {}); // a new failure is reported by this same handler
  });
  blocksLoading.replaceChildren(`${error} `, retry);
  setStatus(`${error} Press Retry in the Blocks pane, or Run to try again.`, true);
});
editorLoader.get().catch(() => {}); // start loading now; failures are reported by the handler above
if (pineStartup.length > 0) setStatus(`${pineStartup.length} saved Pine script${pineStartup.length > 1 ? 's do' : ' does'} not compile; open the Pine tab to fix ${pineStartup.length > 1 ? 'them' : 'it'}.`, true);

const pineEditor = createPineEditor(document.getElementById('pine')!, {
  records: pineRecords,
  retired: pineRetired,
  onChange(records, retired) {
    pineRecords = records;
    pineRetired = retired;
    const results = syncPineIndicators(records, retired);
    blockOverlayKey = ''; // same parameters may now mean different code: redraw
    editor?.refreshIndicators(); // not loaded yet: it will load with the new registrations
    applyOverlays(); // shown scripts may have changed code
    refreshFreshness();
    return results;
  },
  shown: pineShown,
  onShowChange(ids) {
    pineShown = ids;
    savePineShown(ids);
    applyOverlays();
  },
});

const initialTab: LeftTab = loadText(LEFT_TAB_STORAGE_KEY) === 'pine' ? 'pine' : 'blocks';
setupLayout(document.getElementById('pane-switch')!, document.getElementById('left-tabs')!, (pane) => {
  if (pane === 'left') editor?.resize();
}, initialTab, (tab) => {
  saveText(LEFT_TAB_STORAGE_KEY, tab);
  if (tab === 'blocks') editor?.resize();
  else pineEditor.refresh();
});
new ResizeObserver(() => editor?.resize()).observe(blocklyEl);
const fitButton = tip(h('button', { type: 'button', class: 'btn btn-small fit-blocks' }, icon('fit', 14), h('span', {}, 'Fit')),
  'Zoom so your whole strategy fits on screen (as far as the blocks stay readable).');
fitButton.addEventListener('click', () => editor?.fit());
const undoButton = tip(h('button', { type: 'button', class: 'icon-btn' }, icon('undo')), 'Undo your last change to the blocks. Shortcut: Ctrl + Z');
undoButton.setAttribute('aria-label', 'Undo');
undoButton.addEventListener('click', () => editor?.undo());
const redoButton = tip(h('button', { type: 'button', class: 'icon-btn' }, icon('redo')), 'Redo: bring back the change you just undid. Shortcut: Ctrl + Y');
redoButton.setAttribute('aria-label', 'Redo');
redoButton.addEventListener('click', () => editor?.undo(true));
document.getElementById('left-tabs')!.append(h('div', { class: 'blocks-tools' }, undoButton, redoButton, fitButton));
/** Fit after Blockly has laid the new blocks out (animation frames may stall in a hidden window: use a timer). */
function fitSoon(): void {
  setTimeout(() => editor?.fit(), 60);
}

const panels = setupPanels([
  { id: 'strategy', el: document.getElementById('left')!, step: '1', title: 'Strategy', icon: 'blocks',
    description: 'Your robot’s rules, built from blocks. Drag blocks from the categories on the left and snap them together. The robot runs the “when a bar closes” blocks once for every candle.' },
  { id: 'chart', el: document.getElementById('chart-panel')!, step: '2', title: 'Price chart', icon: 'chart',
    description: 'Each candle is one slice of time: green means the price went up, red means it went down. After a test, arrows show where your robot bought and sold. Scroll to zoom, drag to move around.' },
  { id: 'results', el: document.getElementById('results-panel')!, step: '3', title: 'Results', icon: 'trophy',
    description: 'How your strategy did: a one-line summary, the key numbers (hover over each to learn what it means), how your money changed over time, and a list of every trade.' },
], () => editor?.resize());

// Chart actions: reset the view, save a picture.
const chartFit = tip(h('button', { type: 'button', class: 'icon-btn' }, icon('fit')), 'Zoom out to show all the candles again.');
chartFit.setAttribute('aria-label', 'Show all candles');
chartFit.addEventListener('click', () => chart.fit());
const chartShot = tip(h('button', { type: 'button', class: 'icon-btn' }, icon('camera')), 'Save a picture of the chart (PNG), for example to share your result.');
chartShot.setAttribute('aria-label', 'Save the chart as a picture');
chartShot.addEventListener('click', () => {
  void chart.screenshot().then((blob) => {
    if (blob) downloadFile(datedFileName('quant-sim-chart', 'png', Date.now()), blob, 'image/png');
  });
});
panels.actions('chart').append(chartFit, chartShot);

const rowSplitter = h('div', { class: 'row-splitter' });
document.getElementById('results-panel')!.before(rowSplitter);
const savedResultsHeight = Number(loadText(RESULTS_HEIGHT_STORAGE_KEY));
setupRowSplitter(document.getElementById('main')!, rowSplitter, savedResultsHeight > 0 ? savedResultsHeight : null,
  (px) => saveText(RESULTS_HEIGHT_STORAGE_KEY, px === null ? '' : String(px)));

setupSplitter(
  document.getElementById('layout')!,
  document.getElementById('splitter')!,
  parseStoredFraction(loadText(SPLIT_STORAGE_KEY)),
  (fraction) => saveText(SPLIT_STORAGE_KEY, String(fraction)),
  () => editor?.resize(),
);

/** Loads history from `settings.startMs` to now, redraws the chart and restarts the live stream. */
async function loadMarket(settings: RunSettings): Promise<void> {
  live?.close();
  live = null;
  setStatus(`Loading ${settings.symbol} ${settings.timeframe} candles…`);
  const chartPanel = document.getElementById('chart-panel')!;
  chartPanel.classList.add('loading');
  try {
    candles = await adapter.fetchCandles(settings.symbol, settings.timeframe, settings.startMs, Date.now());
  } finally {
    chartPanel.classList.remove('loading');
  }
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
  if (!editor) {
    setStatus('Cannot run yet: the block editor is still loading.', true);
    return null;
  }
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
  return { id: 'blocks', workspace, pineScripts: pineRecords, pineRetired };
}

/** What the next Run would depend on, as comparable strings (see resultFreshness.ts). */
function currentRunKey(): RunKey {
  const strategy = strategyChoice === 'smaCross'
    ? 'smaCross'
    : `blocks:${workspaceKey(editor?.save() ?? null)}|pine:${JSON.stringify([pineRecords, pineRetired])}`;
  return { strategy, settings: JSON.stringify(topBar.read()) };
}

/** Dims the shown results (with a note) once the strategy or settings differ from what produced them. */
function refreshFreshness(): void {
  // Nothing shown (also during startup, before the top bar exists): nothing can be stale.
  const f = mode === 'backtest' && results.showing ? results.check(currentRunKey()) : null;
  const note = f?.status === 'stale' ? STALE_NOTE[f.reason] : '';
  for (const id of ['verdict', 'stats']) document.getElementById(id)!.classList.toggle('stale', note !== '');
  staleNote.textContent = note;
  staleNote.hidden = note === '';
}

/** Removes the previous run's verdict, benchmark, stats and trade markers (another strategy was loaded). */
function clearResults(): void {
  stats.clear();
  verdict.clear();
  chart.setMarkers([]);
  results.discard();
  refreshFreshness();
}

const EMPTY_VERDICT_INPUT = {
  tradeCount: 0, openPosition: false, fillCount: 0, totalReturnPct: 0, maxDrawdownPct: 0, wiped: false,
  barsProcessed: 0, barsLoaded: 0, benchmark: null, activity: null, warmup: null,
};

/** Bars the strategy that ran needs before its first order can fill (for the "not enough history" hint). */
function strategyWarmup(spec: StrategySpec): HistoryNeed {
  if (spec.id === 'smaCross') return smaCrossHistoryNeed(Math.max(spec.params.fast, spec.params.slow));
  return strategyHistoryNeed(spec.workspace);
}

function verdictFor(result: BacktestResult, barsLoaded: number, warmup: HistoryNeed | null) {
  return buildVerdict({
    tradeCount: result.trades.length,
    openPosition: result.finalPosition.side !== 'flat',
    fillCount: result.fills.length,
    totalReturnPct: result.stats.totalReturnPct,
    maxDrawdownPct: result.stats.maxDrawdownPct,
    wiped: result.wiped,
    barsProcessed: result.barsProcessed,
    barsLoaded,
    benchmark: result.benchmark
      ? { returnPct: result.benchmark.returnPct, maxDrawdownPct: result.benchmark.maxDrawdownPct, label: benchmarkLabel(result.benchmark.leverage), wipedTime: result.benchmark.wipedTime ?? null }
      : null,
    activity: result.activity ?? null,
    warmup,
  });
}

/** Waits for the block editor when the block strategy is selected (a Run clicked while Blockly loads). */
async function blocksReady(): Promise<boolean> {
  if (strategyChoice !== 'blocks' || editor) return true;
  const last = editorLoader.current;
  setStatus(last.status === 'failed' ? 'Retrying the block editor load before running…' : 'Loading the block editor before running…');
  try {
    await editorLoader.get(); // after a failed load this is a new attempt
    return true;
  } catch (err) {
    // Keep the real error in the status (the loader's handler wrote it; say why the run did not happen).
    setStatus(`Cannot run: ${err instanceof Error ? err.message : String(err)} Press Run or Retry to try again.`, true);
    return false;
  }
}

let running = false;

async function run(): Promise<void> {
  if (mode !== 'backtest' || running) return; // Enter in the top-bar form while in Live mode / a run in progress
  const parsed = parseSettings(topBar.read(), Date.now());
  if (!parsed.ok) {
    setStatus(`Cannot run: ${parsed.error}.`, true);
    topBar.showInvalid(parsed.field, parsed.error);
    return;
  }
  running = true;
  topBar.setRunning(true);
  try {
    if (!(await blocksReady())) return;
    await runWith(parsed.settings);
  } finally {
    running = false;
    topBar.setRunning(false);
  }
}

async function runWith(settings: RunSettings): Promise<void> {
  const spec = strategySpec();
  if (!spec) return;
  const runKey = currentRunKey();
  clearResults();
  try {
    await loadMarket(settings);
    if (candles.length < 2) {
      verdict.show(buildVerdict({ ...EMPTY_VERDICT_INPUT, barsLoaded: candles.length, barsProcessed: candles.length }));
      throw new Error('not enough candles in the selected range');
    }
    setStatus(`Testing your strategy on ${candles.length.toLocaleString('en-US')} candles…`);
    const result = await runBacktestInWorker({
      type: 'run',
      candles,
      config: { symbol: settings.symbol, timeframe: settings.timeframe, broker: settings.broker },
      strategy: spec,
    });
    chart.setMarkers(fillsToMarkers(result.fills));
    stats.render(result);
    results.ranWith(runKey);
    verdict.show(verdictFor(result, candles.length, strategyWarmup(spec)), benchmarkDefinition(result.benchmark?.leverage ?? 1));
    runHistory = addRun(runHistory, {
      at: Date.now(), strategy: spec.id === 'blocks' ? 'Your blocks' : 'Built-in SMA cross', symbol: settings.symbol, timeframe: settings.timeframe,
      startDate: new Date(settings.startMs).toISOString().slice(0, 10), returnPct: result.stats.totalReturnPct,
      benchReturnPct: result.benchmark?.returnPct ?? null, maxDrawdownPct: result.stats.maxDrawdownPct, trades: result.trades.length, wiped: result.wiped,
    });
    saveJson(RUN_HISTORY_STORAGE_KEY, runHistory);
    stats.setHistory(runHistory);
    setStatus(
      `Backtest done (${spec.id === 'blocks' ? 'your blocks' : 'built-in SMA cross'}): ${result.barsProcessed.toLocaleString('en-US')} candles, ${result.trades.length} trade${result.trades.length === 1 ? '' : 's'}` +
        (result.wiped ? ' (ACCOUNT WIPED)' : '') +
        '. See the Results panel below the chart.',
    );
    refreshFreshness(); // edits made while it ran already make it stale
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BacktestError && err.blockId) {
      editor?.highlightError(err.blockId, message);
      setStatus(`Run halted by a block: ${message}`, true);
    } else {
      setStatus(message, true);
    }
  }
}

const topBar = createTopBar(document.getElementById('topbar')!, defaultRawSettings(Date.now()), () => void run(), mode, (m) => switchMode(m),
  () => strategyChoice === 'smaCross');

/** Product/timeframe/account from the top bar plus a frozen copy of the selected strategy, for a new live session. */
function sessionBase(): SessionBase {
  const now = Date.now();
  const parsed = parseSettings({ ...topBar.read(), startDate: defaultStartDate(now, 1) }, now); // the start date is backtest-only
  if (!parsed.ok) {
    topBar.showInvalid(parsed.field, parsed.error);
    return { ok: false, error: `Cannot start: ${parsed.error}.` };
  }
  const { symbol, timeframe, broker } = parsed.settings;
  if (strategyChoice === 'smaCross') return { ok: true, symbol, timeframe, brokerConfig: broker, strategy: smaCrossSnapshot(DEFAULT_SMA_CROSS) };
  if (!editor) return { ok: false, error: notReadyMessage(editorLoader.current, 'start a live session') };
  const spec = strategySpec();
  if (!spec || spec.id !== 'blocks') return { ok: false, error: 'Cannot start a live session: fix the block problems first (listed under the workspace).' };
  return { ok: true, symbol, timeframe, brokerConfig: broker, strategy: blocksSnapshot(spec.workspace, spec.pineScripts ?? [], spec.pineRetired ?? []) };
}

// The Live strip folds down to its header like the panels (remembered).
const LIVE_OPEN_STORAGE_KEY = 'quant-sim.live-open';
{
  const liveEl = document.getElementById('live')!;
  const body = h('div', { class: 'live-body', id: 'live-body' });
  const toggle = h('button', { type: 'button', class: 'icon-btn', 'aria-controls': 'live-body' });
  const paint = (open: boolean) => {
    liveEl.classList.toggle('folded', !open);
    body.hidden = !open;
    toggle.replaceChildren(icon(open ? 'chevronUp' : 'chevronDown'));
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Hide the live controls' : 'Show the live controls');
    tip(toggle, open ? 'Hide the live controls to make more room for the chart. Your sessions keep running.' : 'Show the live controls again.');
    saveText(LIVE_OPEN_STORAGE_KEY, open ? '1' : '0');
  };
  toggle.addEventListener('click', (ev) => {
    ev.stopPropagation(); // the icon is swapped, so the header's own handler could not tell the click was on this button
    paint(liveEl.classList.contains('folded'));
  });
  const head = h('div', { class: 'live-head' },
    h('span', { class: 'panel-icon', 'aria-hidden': 'true' }, icon('live')),
    h('h2', { class: 'panel-title' }, 'Live practice'),
    infoButton('Let your strategy trade on prices as they happen right now, with pretend money. Start a session below; you can stop it, look back at old sessions, or delete them.', 'What is live practice?', 'Live practice'),
    h('div', { class: 'panel-spacer' }), toggle);
  head.addEventListener('click', (ev) => {
    if (liveEl.classList.contains('folded') && !(ev.target as Element).closest('button')) paint(true);
  });
  liveEl.append(head, body);
  paint(loadText(LIVE_OPEN_STORAGE_KEY) !== '0');
}

const liveSessions = new LiveTargets(document.getElementById('live-body')!, {
  chart,
  stats,
  setStatus,
  highlightBlock: (blockId, message) => editor?.highlightError(blockId, message),
  sessionBase,
  extraOverlays: () => [...blockIndicatorOverlays(shownUses()), ...PICKER_OVERLAYS.filter((d) => pickedOverlayIds.includes(d.id))],
  confirm: (message) => window.confirm(message),
  now: () => Date.now(),
});
liveMode = liveSessions;

function switchMode(next: AppMode): void {
  mode = next;
  topBar.setMode(next);
  saveText(MODE_STORAGE_KEY, next);
  verdict.clear(); // backtest-only (live sessions keep their own stats; no benchmark there)
  results.discard();
  refreshFreshness();
  if (next === 'live') {
    stats.leaveHistory();
    live?.close(); // the backtest chart's own stream
    live = null;
    liveSessions.activate();
    if (!liveSessions.hasRunning) setStatus('Live mode: paper trading on real Binance prices. No real orders are ever sent.');
    return;
  }
  liveSessions.deactivate();
  stats.clear();
  const parsed = parseSettings(topBar.read(), Date.now());
  if (!parsed.ok) {
    setStatus(parsed.error, true);
    return;
  }
  loadMarket(parsed.settings)
    .then(() => setStatus(`${parsed.settings.symbol} ${parsed.settings.timeframe}: ${candles.length.toLocaleString('en-US')} candles loaded. Press ▶ Run test to try your strategy.` +
      (liveSessions.hasRunning ? ' A live session keeps running in the background.' : '')))
    .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
}
const strategyPicker = createStrategyPicker(topBar.extras, strategyChoice, (id) => setStrategyChoice(id === 'smaCross' ? 'smaCross' : 'blocks'));

function setStrategyChoice(choice: StrategyChoice): void {
  strategyChoice = choice;
  strategyPicker.set(choice);
  saveText(STRATEGY_STORAGE_KEY, choice);
  topBar.refreshSummary();
  applyOverlays();
  refreshFreshness();
}
// Any top-bar field (product, timeframe, dates, account settings) edited after a run makes its results stale.
for (const type of ['input', 'change']) document.getElementById('topbar')!.addEventListener(type, () => refreshFreshness());

/** Starter flows run only once the editor exists (pickStarter / restorePrevious wait for it). */
const flowDeps = (ed: BlockEditor): FlowDeps => ({
  editor: ed,
  memory: starterMemory,
  confirm: (message) => window.confirm(message),
  status: (message, isError = false) => setStatus(message, isError),
  now: () => Date.now(),
});

/** An editor that could not load is explained in the status; any other error is a bug: status + console. */
function reportFlowError(err: unknown, action: string): void {
  const { message, bug } = describeFlowError(err, action);
  if (bug) console.error(err);
  setStatus(message, true);
}

/** Loads a starter (starterFlow.ts: edits are confirmed and kept among the last 3 previous workspaces). */
async function pickStarter(id: StarterId): Promise<void> {
  const starter = getStarter(id);
  if (!starter) return;
  const ed = await editorLoader.get(); // picked while Blockly loads: applied once it is in
  if (!pickStarterFlow(flowDeps(ed), starter)) return;
  clearResults(); // the previous run's verdict and stats describe a strategy that is gone
  if (strategyChoice !== 'blocks') setStrategyChoice('blocks'); // Run must test the strategy just loaded
  fitSoon();
}

/** Brings previous workspace `id` back; the blocks it replaces take its place in the list. */
async function restorePrevious(id: string): Promise<void> {
  if (!restorePreviousFlow(flowDeps(await editorLoader.get()), id)) return;
  clearResults();
  if (strategyChoice !== 'blocks') setStrategyChoice('blocks');
  fitSoon();
}

createStarterPicker(topBar.tools, STARTERS, {
  onPick: (id) => void pickStarter(id).catch((err: unknown) => reportFlowError(err, 'load the starter')),
  onRestore: (id) => void restorePrevious(id).catch((err: unknown) => reportFlowError(err, 'restore that workspace')),
  previousList: () => starterMemory.previousList });
renderOverlayPicker(topBar.tools, PICKER_OVERLAYS, pickedOverlayIds, (ids) => {
  pickedOverlayIds = ids;
  saveJson(OVERLAYS_STORAGE_KEY, ids);
  applyOverlays();
});

const help = createHelpWindow(() => startTour());

/** Saves the blocks and the Pine scripts as a file. */
async function exportStrategy(): Promise<void> {
  const ed = await editorLoader.get();
  downloadFile(datedFileName('quant-sim-strategy', 'json', Date.now()), JSON.stringify(buildStrategyFile(ed.save(), pineRecords, Date.now()), null, 2), 'application/json');
  setStatus('Exported your strategy as a file. Use Settings › Import strategy to load it again, here or on another computer.');
}

/** Loads blocks (and any Pine scripts this browser lacks) from an exported file; the current blocks are kept. */
async function importStrategy(file: File): Promise<void> {
  const parsed = parseStrategyFile(await file.text());
  if (!parsed.ok) {
    setStatus(parsed.error, true);
    return;
  }
  const added = newPineScripts(pineRecords, parsed.file.pineScripts);
  if (added.length > 0) {
    // The Pine editor owns the script list: store the merged list and reload, so every part picks it up.
    if (!window.confirm(`This strategy brings ${added.length} Pine script${added.length > 1 ? 's' : ''}. Add ${added.length > 1 ? 'them' : 'it'} and reload the page?\n\nYour current blocks are kept under “Start from…” → Previous workspaces.`)) return;
  }
  const ed = await editorLoader.get();
  const name = file.name.replace(/\.json$/i, '').slice(0, 60) || 'imported strategy';
  if (!pickStarterFlow(flowDeps(ed), { id: 'imported', label: `Imported: ${name}`, description: 'Loaded from a file.', build: () => parsed.file.workspace as ReturnType<StarterDef['build']> })) return;
  clearResults();
  if (strategyChoice !== 'blocks') setStrategyChoice('blocks');
  if (added.length > 0) {
    savePineRecords([...pineRecords, ...added]);
    location.reload();
    return;
  }
  setStatus(`Imported your strategy from “${file.name}”. Press ▶ Run test to try it.`);
  fitSoon();
}

/** Deletes everything this app stored in the browser (after asking) and starts fresh. */
function resetEverything(): void {
  if (!window.confirm('Delete everything Quant Sim saved in this browser?\n\nThis removes your blocks, Pine scripts, previous workspaces, live sessions and settings. It cannot be undone. (Tip: Export strategy first to keep a copy.)')) return;
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('quant-sim.')) localStorage.removeItem(key);
  } catch {
    // storage blocked: nothing to remove
  }
  try {
    indexedDB.deleteDatabase(LIVE_DB_NAME);
    indexedDB.deleteDatabase(CANDLE_DB_NAME);
  } catch {
    // no IndexedDB
  }
  location.reload();
}

// Footer: quick links into Help.
const footerLink = (label: string, tab: Parameters<typeof help.open>[0]) => {
  const b = h('button', { type: 'button', class: 'footer-link' }, label);
  b.addEventListener('click', () => help.open(tab));
  return b;
};
document.getElementById('footer')!.append(h('nav', { class: 'footer-links', 'aria-label': 'Help links' },
  footerLink('How it works', 'start'), footerLink('Word list', 'glossary'), footerLink('Shortcuts', 'keys'), footerLink('Safety & privacy', 'about')));

// Anything unexpected: a plain message instead of silence (details stay in the browser console).
const reportCrash = (err: unknown) => {
  console.error(err);
  setStatus(`Something went wrong: ${err instanceof Error ? err.message : String(err)}. Your work is saved; reloading the page usually fixes it.`, true);
};
window.addEventListener('error', (ev) => {
  // Harmless browser notices (resize timing) and opaque errors from other origins (extensions) are not ours.
  if (/ResizeObserver loop|^Script error\.?$/.test(String(ev.message))) return;
  reportCrash(ev.error ?? ev.message);
});
window.addEventListener('unhandledrejection', (ev) => reportCrash(ev.reason));

createAppBar(document.getElementById('appbar')!, {
  onHelp: () => help.open(),
  onTour: () => startTour(),
  onResetLayout: () => {
    panels.reset();
    // Both drag handles reset on double-click.
    for (const id of ['splitter']) document.getElementById(id)!.dispatchEvent(new MouseEvent('dblclick'));
    rowSplitter.dispatchEvent(new MouseEvent('dblclick'));
    setStatus('Layout reset: every panel is back at its normal size.');
  },
  onExportStrategy: () => void exportStrategy().catch((err: unknown) => reportFlowError(err, 'export the strategy')),
  onImportStrategy: (file) => void importStrategy(file).catch((err: unknown) => reportFlowError(err, 'import the strategy')),
  onResetEverything: resetEverything,
});

initShortcuts({
  run: () => {
    if (mode === 'backtest') void run();
  },
  help: () => help.open(),
  toggleStrategy: () => panels.toggle('strategy'),
  toggleResults: () => panels.toggle('results'),
  fullChart: () => panels.full('chart'),
  theme: toggleTheme,
});

// Tell people when the internet drops: prices stop updating, and loading new candles fails until it is back.
window.addEventListener('offline', () => setStatus('You are offline: prices are not updating. Everything you made is still saved in this browser.', true));
window.addEventListener('online', () => setStatus('Back online. Press ▶ Run test to load fresh prices.'));

// First visit: a short guided tour (after the first paint, so it can point at real things).
if (!tourDone()) setTimeout(() => startTour(), 900);

// Development builds only: lets a browser check read what the chart drew (zone boxes, signal counts).
if (import.meta.env.DEV) (window as unknown as { __quantSim?: unknown }).__quantSim = { chart };

liveSessions
  .init()
  .then((resumed) => {
    if (resumed && mode !== 'live') switchMode('live'); // a session left running: show it
  })
  .catch((err: unknown) => setStatus(`Live sessions unavailable: ${err instanceof Error ? err.message : String(err)}`, true));
if (mode === 'live') {
  stats.leaveHistory();
  liveSessions.activate();
}

const initial = parseSettings(topBar.read(), Date.now());
if (initial.ok && mode === 'backtest') {
  loadMarket(initial.settings)
    .then(() => {
      if (compileState.errors.length === 0) {
        setStatus(`${initial.settings.symbol} ${initial.settings.timeframe}: ${candles.length.toLocaleString('en-US')} candles loaded, live prices on. Press ▶ Run test to try your strategy.`);
      }
    })
    .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
}
