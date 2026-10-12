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
import { createAppBar, type AppBar } from './ui/appBar';
import { createChartOverlay } from './ui/chartOverlay';
import { MODE_TEXT, THEME_TEXT } from './ui/descriptions';
import { modalIsOpen } from './ui/dialog';
import { downloadBlob, downloadText } from './ui/download';
import { installExplainers } from './ui/explain';
import { exportFileName, tradesToCsv } from './ui/exportCsv';
import { fmtTime } from './ui/format';
import { friendlyMessage } from './ui/friendly';
import type { HelpDialog, HelpPage } from './ui/helpDialog';
import { WELCOMED_STORAGE_KEY } from './ui/keys';
import { icon } from './ui/icons';
import { createPanelChrome, type PanelChrome } from './ui/panelChrome';
import type { PanelState } from './ui/panels';
import { shortcutFor } from './ui/shortcuts';
import { summaryText } from './ui/summaryText';
import { parseStrategyFile, serializeStrategy, strategyLabelFromFileName, MAX_STRATEGY_FILE_BYTES } from './ui/strategyFile';
import { applyTheme, otherTheme, resolveTheme, THEME_STORAGE_KEY, type Theme } from './ui/theme';
import { explain, toast } from './ui/toast';
import { installTooltips } from './ui/tooltip';
import { createProblemsView, createStrategyPicker, setupLayout, setupSplitter, type LeftTab } from './ui/layout';
import { getStarter, STARTERS, type StarterId } from './blocks/starters';
import { parseStoredFraction } from './ui/splitter';
import { isEmptyWorkspace, StarterMemory } from './ui/starterMemory';
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
import { defaultRawSettings, defaultStartDate, mergeStoredSettings, parseSettings, SETTINGS_STORAGE_KEY, type RunSettings } from './ui/settings';
import { blocksSnapshot, smaCrossSnapshot } from './live/session';
import type { SessionBase } from './ui/liveMode';
import { LiveTargets } from './ui/liveTargets';
import { StatsPanel } from './ui/statsPanel';
import { clearOwnData, loadJson, loadText, saveJson, saveText } from './ui/storage';
import { createTopBar, type AppMode } from './ui/topbar';
import { BacktestError, runBacktestInWorker } from './worker/client';
import type { StrategySpec } from './worker/protocol';

type StrategyChoice = 'blocks' | 'smaCross';
const STRATEGY_STORAGE_KEY = 'quant-sim.strategy';
const LEFT_TAB_STORAGE_KEY = 'quant-sim.left-tab';
const MODE_STORAGE_KEY = 'quant-sim.mode';
const OVERLAYS_STORAGE_KEY = 'quant-sim.overlays.v1';
const SPLIT_STORAGE_KEY = 'quant-sim.split.v1';
const FIRST_RUN_TIP_KEY = 'quant-sim.first-run-tip';

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

// Colours first (the charts and the block editor read them as they are built), then the page-wide helpers.
applyTheme(resolveTheme(loadText(THEME_STORAGE_KEY), window.matchMedia('(prefers-color-scheme: light)').matches));
installTooltips();
installExplainers();

let lastCrashNote = 0;
/** A bug nobody caught: log it for the developer, and tell the person once in plain words (their work is saved). */
function reportCrash(what: unknown): void {
  console.error(what);
  if (Date.now() - lastCrashNote < 10_000) return;
  lastCrashNote = Date.now();
  toast('Something unexpected happened', 'If anything looks stuck, reload the page. Your blocks and settings are saved in this browser.', 'warn');
}
window.addEventListener('error', (ev) => {
  if (/ResizeObserver loop|^Script error\.?$/.test(ev.message)) return; // browser noise, not a bug in this page
  reportCrash(ev.error ?? ev.message);
});
window.addEventListener('unhandledrejection', (ev) => reportCrash(ev.reason));

let lastErrorToast = { text: '', at: 0 };

/** The footer line. Errors are put in plain words and also pop up once (the footer alone is easy to miss). */
function setStatus(text: string, isError = false, notify = true): void {
  const shown = isError ? friendlyMessage(text) : text;
  const status = document.getElementById('status')!;
  status.textContent = shown;
  status.classList.toggle('error', isError);
  if (isError && notify && !chartOverlay.showingError && (shown !== lastErrorToast.text || Date.now() - lastErrorToast.at > 15_000)) {
    lastErrorToast = { text: shown, at: Date.now() };
    toast('Something went wrong', shown, 'warn');
  }
}

const adapter = new BinanceFuturesAdapter();
const chart = new ChartPanel(document.getElementById('chart')!);
const chartOverlay = createChartOverlay(document.getElementById('chart')!, () => void reloadMarket());
const stats = new StatsPanel(document.getElementById('stats')!);
const verdict = new VerdictView(document.getElementById('verdict')!);
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
  blocksEmpty.hidden = !isEmptyWorkspace(json);
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
    setStatus(`Blocks: ${result.errors.length} problem${result.errors.length > 1 ? 's' : ''}: ${result.errors[0].message}`, true, false); // listed under the blocks too
    return;
  }
  if (hadErrors) setStatus('Your blocks are fixed. Press Run to backtest.');
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
const blocksLoading = h('div', { class: 'blocks-loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading blocks…');
blocklyEl.append(blocksLoading);
/** Shown over an empty workspace so a blank grid never looks broken. */
const blocksEmpty = h('div', { class: 'blocks-empty', hidden: '' },
  h('div', {}, h('strong', {}, 'Your workspace is empty'), 'Press \u201CStart from\u2026\u201D above for a ready-made robot, or open a block group on the left and drag blocks onto the grid.'));
blocklyEl.append(blocksEmpty);
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
    blocksLoading.replaceChildren(h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Loading blocks…');
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
const fitButton = h('button', { type: 'button', class: 'fit-blocks', 'data-tip': 'Zoom and move the editor so you can see all of your blocks at once' }, icon('fit', 14), 'Fit');
fitButton.addEventListener('click', () => editor?.fit());
document.getElementById('left-tabs')!.append(fitButton);
/** Fit after Blockly has laid the new blocks out (animation frames may stall in a hidden window: use a timer). */
function fitSoon(): void {
  setTimeout(() => editor?.fit(), 60);
}

const split = setupSplitter(
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
  chartOverlay.busy(`Loading ${settings.symbol} ${settings.timeframe} prices…`);
  try {
    candles = await adapter.fetchCandles(settings.symbol, settings.timeframe, settings.startMs, Date.now());
  } catch (err) {
    chartOverlay.error(friendlyMessage(err instanceof Error ? err.message : String(err)));
    throw err;
  }
  chartOverlay.hide();
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

/** "Try again" on the chart cover: loads the prices again with what the top bar says. */
async function reloadMarket(): Promise<void> {
  const parsed = parseSettings(topBar.read(), Date.now());
  if (!parsed.ok) {
    setStatus(`Cannot load prices: ${parsed.error}.`, true);
    topBar.showInvalid(parsed.field);
    return;
  }
  try {
    await loadMarket(parsed.settings);
    setStatus(`${parsed.settings.symbol} ${parsed.settings.timeframe}: ${candles.length} bars, streaming live. Press Run to backtest.`);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
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
    topBar.showInvalid(parsed.field);
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
    setStatus(`Running backtest on ${candles.length} bars…`);
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
    setStatus(
      `Backtest done (${spec.id === 'blocks' ? 'block strategy' : 'built-in SMA cross'}): ${result.barsProcessed} bars, ${result.trades.length} trades` +
        (result.wiped ? ' (ACCOUNT WIPED)' : '') +
        '. Indicator warm-up bars may differ slightly from TradingView.',
    );
    refreshFreshness(); // edits made while it ran already make it stale
    if (loadText(FIRST_RUN_TIP_KEY) !== '1') {
      saveText(FIRST_RUN_TIP_KEY, '1');
      explain({ title: 'Your first run!', on: 'Hover over any score card to see what it means. Try \u201CFull page\u201D on the Results panel to see every trade, and change the blocks or the candle size to run it again.' });
    }
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

const topBar = createTopBar(document.getElementById('topbar')!, mergeStoredSettings(defaultRawSettings(Date.now()), loadJson(SETTINGS_STORAGE_KEY)), () => void run(), mode, (m) => switchMode(m),
  () => strategyChoice === 'smaCross');
// What was typed in the top bar is remembered for the next visit.
document.getElementById('topbar')!.addEventListener('change', () => saveJson(SETTINGS_STORAGE_KEY, topBar.read()));

/** Product/timeframe/account from the top bar plus a frozen copy of the selected strategy, for a new live session. */
function sessionBase(): SessionBase {
  const now = Date.now();
  const parsed = parseSettings({ ...topBar.read(), startDate: defaultStartDate(now, 1) }, now); // the start date is backtest-only
  if (!parsed.ok) {
    topBar.showInvalid(parsed.field);
    return { ok: false, error: `Cannot start: ${parsed.error}.` };
  }
  const { symbol, timeframe, broker } = parsed.settings;
  if (strategyChoice === 'smaCross') return { ok: true, symbol, timeframe, brokerConfig: broker, strategy: smaCrossSnapshot(DEFAULT_SMA_CROSS) };
  if (!editor) return { ok: false, error: notReadyMessage(editorLoader.current, 'start a live session') };
  const spec = strategySpec();
  if (!spec || spec.id !== 'blocks') return { ok: false, error: 'Cannot start a live session: fix the block problems first (listed under the workspace).' };
  return { ok: true, symbol, timeframe, brokerConfig: broker, strategy: blocksSnapshot(spec.workspace, spec.pineScripts ?? [], spec.pineRetired ?? []) };
}

const liveBody = h('div', { class: 'live-body' });
document.getElementById('live')!.append(liveBody);
const liveSessions = new LiveTargets(liveBody, {
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

/** Clicking a trade in the list shows it on the chart (leaving full page, or un-hiding the chart, if needed). */
stats.onTradePick((trade) => {
  chrome.reveal('chart');
  requestAnimationFrame(() => {
    if (chart.showTrade(trade.entryTime, trade.exitTime)) {
      document.getElementById('chart-panel')!.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      setStatus(`Showing the ${trade.side} trade from ${fmtTime(trade.entryTime)} to ${fmtTime(trade.exitTime)} UTC on the chart.`);
    } else {
      toast('That trade is not on the chart', 'The chart shows a different set of candles. Press Run again to load the matching ones.', 'warn');
    }
  });
});

/** A small header button for a panel (chart picture, export trades). */
function panelAction(label: string, iconName: string, tip: string, onClick: () => void): HTMLButtonElement {
  const button = h('button', { type: 'button', class: 'panel-btn is-action', 'data-tip': tip }, icon(iconName, 16), h('span', { class: 'panel-btn-label' }, label));
  button.addEventListener('click', onClick);
  return button;
}

const chartPicture = panelAction('Picture', 'camera', 'Save a picture (PNG) of the chart exactly as you see it', () => {
  chart.screenshot().toBlob((blob) => {
    if (!blob) return toast('Could not save the picture', 'Your browser would not make an image of the chart. Try again.', 'warn');
    const { symbol, timeframe } = topBar.read();
    downloadBlob(exportFileName('chart', [symbol.trim().toUpperCase(), timeframe], 'png'), blob);
    toast('Picture saved', 'The chart picture is in your Downloads folder.', 'good');
  }, 'image/png');
});
const fitChart = panelAction('Fit view', 'fit', 'Zoom the chart so every candle is in view', () => chart.fit());
const copySummary = panelAction('Copy summary', 'copy', 'Copy the result as a few lines of text to paste into a message', () => {
  const sentence = verdict.currentText;
  if (sentence === '') return toast('Nothing to copy yet', 'Press Run first, so there is a result to copy.', 'warn');
  const { symbol, timeframe, startDate, balance } = topBar.read();
  const text = summaryText({ verdict: sentence, symbol, timeframe, startDate, balance, strategy: strategyChoice === 'smaCross' ? 'the built-in SMA cross example' : 'my blocks' });
  navigator.clipboard.writeText(text).then(
    () => toast('Copied', 'The summary is on your clipboard. Paste it anywhere.', 'good'),
    () => toast('Could not copy', 'Your browser blocked copying. Select the sentence under the chart and copy it by hand.', 'warn'),
  );
});
const exportTrades = panelAction('Export trades', 'download', 'Save your list of trades as a spreadsheet file (CSV) for Excel or Google Sheets', () => {
  const trades = stats.currentTrades;
  if (trades.length === 0) return toast('Nothing to export yet', 'Run a backtest (or open a live session) that made some trades, then try again.', 'warn');
  const { symbol, timeframe } = topBar.read();
  downloadText(exportFileName('trades', [symbol.trim().toUpperCase(), timeframe], 'csv'), tradesToCsv(trades), 'text/csv');
  toast('Trades saved', `${trades.length} trade${trades.length === 1 ? '' : 's'} saved as a spreadsheet file in your Downloads folder.`, 'good');
});

const undoButton = panelAction('Undo', 'undo', 'Take back your last change to the blocks (shortcut: Ctrl + Z)', () => editor?.undo());
const redoButton = panelAction('Redo', 'redo', 'Put back the change you just took back (shortcut: Ctrl + Shift + Z)', () => editor?.redo());
for (const b of [undoButton, redoButton]) b.classList.add('blocks-only');

const chrome: PanelChrome = createPanelChrome([
  { id: 'strategy', el: document.getElementById('left')!, actions: [undoButton, redoButton] },
  { id: 'chart', el: document.getElementById('chart-panel')!, actions: [fitChart, chartPicture] },
  { id: 'results', el: document.getElementById('results-panel')!, actions: [copySummary, exportTrades] },
  { id: 'live', el: document.getElementById('live')! },
], document.getElementById('dock')!);
// Panels changed size: let the canvases measure again (the charts watch their own size).
const strategyView = (state: PanelState) => `${state.full === 'strategy'}|${state.hidden.includes('strategy')}`;
let lastPanels = chrome.state;
chrome.onChange((state) => {
  requestAnimationFrame(() => editor?.resize());
  // The block editor got a different amount of room (full page, or shown again): fit the blocks to it.
  const before = lastPanels;
  lastPanels = state;
  if (strategyView(state) !== strategyView(before)) fitSoon();
});

// The Help window, the tour and the welcome are loaded the first time they are wanted (they are not needed to draw the page).
let helpDialog: Promise<HelpDialog> | null = null;
function openHelp(page?: HelpPage): void {
  helpDialog ??= import('./ui/helpDialog').then(({ createHelpDialog }) => createHelpDialog({
    onTour: startTour,
    onReset: () => {
      if (!window.confirm('Forget the blocks, settings and layout saved in this browser?\n\nLive practice sessions are not touched. The page reloads afterwards.')) return;
      clearOwnData();
      window.location.reload();
    },
  }));
  void helpDialog.then((dialog) => dialog.open(page));
}
function startTour(): void {
  void import('./ui/tour').then((m) => m.startTour());
}
/** The guided tour covers the page while it runs; shortcuts stand down. */
const tourIsRunning = (): boolean => document.querySelector('.tour-card') !== null;
let appBar: AppBar | null = null;

function setTheme(next: Theme, announce = true): void {
  applyTheme(next);
  saveText(THEME_STORAGE_KEY, next);
  appBar?.setTheme(next);
  if (announce) explain(THEME_TEXT[next]);
}

const modeNote = document.getElementById('mode-note')!;
/** The always-visible sentence under the top bar that says what the current mode does. */
function showModeNote(): void {
  const text = MODE_TEXT[mode];
  modeNote.replaceChildren(icon('info', 16), h('span', {}, h('strong', {}, `${text.title}: `), text.on));
}
showModeNote();

appBar = createAppBar(document.getElementById('appbar')!, {
  chrome,
  theme: resolveTheme(loadText(THEME_STORAGE_KEY), window.matchMedia('(prefers-color-scheme: light)').matches),
  isLive: () => mode === 'live',
  onTheme: (next) => setTheme(next),
  onHelp: () => openHelp(),
  onTour: startTour,
  onResetSplit: () => split.reset(),
});
document.getElementById('footer-help')!.addEventListener('click', () => openHelp('about'));

function switchMode(next: AppMode): void {
  mode = next;
  topBar.setMode(next);
  saveText(MODE_STORAGE_KEY, next);
  showModeNote();
  chrome.refresh();
  appBar?.refreshView();
  verdict.clear(); // backtest-only (live sessions keep their own stats; no benchmark there)
  results.discard();
  refreshFreshness();
  if (next === 'live') {
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
    .then(() => setStatus(`${parsed.settings.symbol} ${parsed.settings.timeframe}: ${candles.length} bars. Press Run to backtest.` +
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

/** "Save blocks to a file": the workspace as a small JSON file. */
function saveStrategyFile(): void {
  if (!editor) return toast('Blocks are still loading', 'Give the block editor a second to finish loading, then try again.', 'warn');
  downloadText(exportFileName('strategy', [], 'json'), serializeStrategy(editor.save(), Date.now()), 'application/json');
  toast('Blocks saved', 'Your strategy file is in your Downloads folder. Use "Open a file" to load it again, or send it to a friend.', 'good');
}

const strategyFileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: '', 'aria-label': 'Open a strategy file' });
document.body.append(strategyFileInput);
strategyFileInput.addEventListener('change', () => {
  const file = strategyFileInput.files?.[0];
  strategyFileInput.value = ''; // the same file can be picked again later
  if (!file) return;
  void openStrategyFile(file).catch((err: unknown) => reportFlowError(err, 'open that file'));
});

/** "Open a file": loads the blocks like a starter does (edits are confirmed first and kept under Previous workspaces). */
async function openStrategyFile(file: File): Promise<void> {
  if (file.size > MAX_STRATEGY_FILE_BYTES) return toast('That file is too big', 'A strategy file is only a few kilobytes. This does not look like one.', 'warn');
  const parsed = parseStrategyFile(await file.text());
  if (!parsed.ok) return toast('Could not open that file', parsed.error, 'warn');
  const ed = await editorLoader.get();
  const label = strategyLabelFromFileName(file.name);
  if (!pickStarterFlow(flowDeps(ed), { id: 'file', label, description: 'Blocks from your file.', build: () => parsed.workspace })) return;
  clearResults();
  if (strategyChoice !== 'blocks') setStrategyChoice('blocks');
  fitSoon();
}

createStarterPicker(topBar.tools, STARTERS, {
  onPick: (id) => void pickStarter(id).catch((err: unknown) => reportFlowError(err, 'load the starter')),
  onRestore: (id) => void restorePrevious(id).catch((err: unknown) => reportFlowError(err, 'restore that workspace')),
  previousList: () => starterMemory.previousList,
  onSaveFile: saveStrategyFile,
  onOpenFile: () => strategyFileInput.click() });
renderOverlayPicker(topBar.tools, PICKER_OVERLAYS, pickedOverlayIds, (ids) => {
  pickedOverlayIds = ids;
  saveJson(OVERLAYS_STORAGE_KEY, ids);
  applyOverlays();
});

// Development builds only: lets a browser check read what the chart drew (zone boxes, signal counts).
if (import.meta.env.DEV) (window as unknown as { __quantSim?: unknown }).__quantSim = { chart };

liveSessions
  .init()
  .then((resumed) => {
    if (resumed && mode !== 'live') switchMode('live'); // a session left running: show it
  })
  .catch((err: unknown) => setStatus(`Live sessions unavailable: ${err instanceof Error ? err.message : String(err)}`, true));
if (mode === 'live') liveSessions.activate();

const initial = parseSettings(topBar.read(), Date.now());
if (initial.ok && mode === 'backtest') {
  loadMarket(initial.settings)
    .then(() => {
      if (compileState.errors.length === 0) {
        setStatus(`${initial.settings.symbol} ${initial.settings.timeframe}: ${candles.length} bars, streaming live. Press Run to backtest.`);
      }
    })
    .catch((err: unknown) => setStatus(err instanceof Error ? err.message : String(err), true));
}

/** Keyboard shortcuts (shortcuts.ts decides what a key means; plain letters never fire while typing). */
document.addEventListener('keydown', (ev) => {
  if (modalIsOpen() || tourIsRunning()) return;
  const target = ev.target instanceof Element ? ev.target : null;
  const action = shortcutFor({
    key: ev.key, code: ev.code, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, shiftKey: ev.shiftKey,
    typing: target?.closest('input, textarea, select, [contenteditable="true"]') != null,
    inBlocks: target?.closest('#blockly') != null,
  });
  if (!action) return;
  switch (action.type) {
    case 'run':
      ev.preventDefault();
      if (mode === 'backtest') void run();
      else toast('Run is for Backtest mode', 'In Live mode, use "Start live session" in the Live practice panel.', 'warn');
      break;
    case 'help': ev.preventDefault(); openHelp(); break;
    case 'tour': ev.preventDefault(); startTour(); break;
    case 'theme': ev.preventDefault(); setTheme(otherTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')); break;
    case 'exit-full': if (chrome.state.full !== null) { ev.preventDefault(); chrome.exitFull(); } break;
    case 'toggle-hidden':
    case 'toggle-full':
      if (action.panel === 'live' && mode !== 'live') {
        toast('Live practice is only in Live mode', 'Switch to Live at the top left to use that panel.', 'warn');
        break;
      }
      ev.preventDefault();
      if (action.type === 'toggle-hidden') chrome.hide(action.panel);
      else chrome.full(action.panel);
      break;
  }
});

// First visit: a short welcome (never again after that; Help and Tour are always in the top bar).
if (loadText(WELCOMED_STORAGE_KEY) !== '1') {
  setTimeout(() => void import('./ui/welcome').then((m) => m.showWelcome({ onTour: startTour, onRun: () => void run() })), 600);
}
