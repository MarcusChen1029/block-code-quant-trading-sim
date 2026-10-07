import './style.css';
import { compileBlocks } from './blocks/compiler';
import { getIndicator } from './blocks/registry';
import type { CompileIssue, IndicatorUse } from './blocks/generator';
import type { CandleSubscription } from './data/adapter';
import { BinanceFuturesAdapter } from './data/binance';
import type { Candle } from './data/types';
import { DEFAULT_SMA_CROSS } from './engine/strategies/smaCross';
import { createBlockEditor } from './ui/blockEditor';
import { blockIndicatorOverlays, defaultIndicatorUse, zoneToggleOverlays } from './ui/blockOverlays';
import { ChartPanel } from './ui/chart';
import { h } from './ui/dom';
import { createProblemsView, createStrategyPicker, setupLayout, setupSplitter, type LeftTab } from './ui/layout';
import { getStarter, STARTERS, type StarterId } from './blocks/starters';
import { parseStoredFraction } from './ui/splitter';
import { StarterMemory } from './ui/starterMemory';
import { pickStarter as pickStarterFlow, restorePrevious as restorePreviousFlow, type FlowDeps } from './ui/starterFlow';
import { createStarterPicker } from './ui/starterPicker';
import { buildVerdict } from './ui/verdict';
import { VerdictView } from './ui/verdictView';
import { smaCrossHistoryNeed, strategyHistoryNeed, type HistoryNeed } from './ui/warmup';
import type { BacktestResult } from './engine/engine';
import { syncPineIndicators } from './pine/library';
import { createPineEditor } from './ui/pineEditor';
import { loadPineRecords, loadPineRetired, loadPineShown, savePineShown } from './ui/pineStore';
import { fillsToMarkers } from './ui/markers';
import { renderOverlayPicker } from './ui/overlayPicker';
import { OVERLAYS, smaOverlay, type OverlayDef } from './ui/overlays';
import { defaultRawSettings, defaultStartDate, parseSettings, type RunSettings } from './ui/settings';
import { blocksSnapshot, smaCrossSnapshot } from './live/session';
import { LiveMode, type SessionBase } from './ui/liveMode';
import { StatsPanel } from './ui/statsPanel';
import { loadJson, loadText, saveJson, saveText } from './ui/storage';
import { createTopBar, type AppMode } from './ui/topbar';
import { BacktestError, runBacktestInWorker } from './worker/client';
import type { StrategySpec } from './worker/protocol';

type StrategyChoice = 'blocks' | 'smaCross';
const STRATEGY_STORAGE_KEY = 'quant-sim.strategy';
const LEFT_TAB_STORAGE_KEY = 'quant-sim.left-tab';
const MODE_STORAGE_KEY = 'quant-sim.mode';
const OVERLAYS_STORAGE_KEY = 'quant-sim.overlays.v1';
const SPLIT_STORAGE_KEY = 'quant-sim.split.v1';

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
}

const adapter = new BinanceFuturesAdapter();
const chart = new ChartPanel(document.getElementById('chart')!);
const stats = new StatsPanel(document.getElementById('stats')!);
const verdict = new VerdictView(document.getElementById('verdict')!);
const starterMemory = new StarterMemory({ get: loadJson, set: saveJson });
let candles: Candle[] = [];
let live: CandleSubscription | null = null;
let pickedOverlayIds: string[] = loadPickedOverlays();
let strategyChoice: StrategyChoice = loadText(STRATEGY_STORAGE_KEY) === 'smaCross' ? 'smaCross' : 'blocks';
let mode: AppMode = loadText(MODE_STORAGE_KEY) === 'live' ? 'live' : 'backtest';
/** Created after the editor (whose first compile already redraws overlays). */
let liveMode: LiveMode | null = null;
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

const problems = createProblemsView(document.getElementById('problems')!, (blockId, message) => editor.highlightError(blockId, message));

/** Recompiles on every workspace edit: problems list, warning icons, status line, auto-drawn indicators. */
function onWorkspaceChange(json: unknown): void {
  const result = compileBlocks(json);
  const hadErrors = compileState.errors.length > 0;
  compileState = result.ok ? { errors: [], warnings: result.warnings } : { errors: result.errors, warnings: result.warnings };
  problems.show(compileState.errors, compileState.warnings);
  editor.showIssues([...compileState.errors, ...compileState.warnings]);
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
  if (hadErrors) setStatus('Blocks compile again. Press Run to backtest.');
  const overlayKey = JSON.stringify(result.program.indicators.map(({ blockId: _id, ...use }) => use));
  blockIndicators = result.program.indicators;
  if (overlayKey !== blockOverlayKey && strategyChoice === 'blocks') {
    blockOverlayKey = overlayKey;
    applyOverlays();
  }
}

const editor = createBlockEditor(document.getElementById('blockly')!, onWorkspaceChange, (message) => setStatus(message, true));
if (editor.restored === 'default-after-error') {
  setStatus(`The saved block workspace could not be loaded (${editor.loadError}). It is kept unchanged in browser storage; ` +
    "the SMA cross example is shown and edits are not saved until you pick a starter from 'Start from…'.", true);
}
// A fresh user starts on the SMA cross: remember it as an untouched starter (replacing it later needs no confirm).
if (editor.restored === 'default') starterMemory.recordLoaded('smaCross', JSON.stringify(editor.save()), getStarter('smaCross')!.label);
if (pineStartup.length > 0) setStatus(`${pineStartup.length} saved Pine script${pineStartup.length > 1 ? 's do' : ' does'} not compile; open the Pine tab to fix ${pineStartup.length > 1 ? 'them' : 'it'}.`, true);

const pineEditor = createPineEditor(document.getElementById('pine')!, {
  records: pineRecords,
  retired: pineRetired,
  onChange(records, retired) {
    pineRecords = records;
    pineRetired = retired;
    const results = syncPineIndicators(records, retired);
    blockOverlayKey = ''; // same parameters may now mean different code: redraw
    editor.refreshIndicators();
    applyOverlays(); // shown scripts may have changed code
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
  if (pane === 'left') editor.resize();
}, initialTab, (tab) => {
  saveText(LEFT_TAB_STORAGE_KEY, tab);
  if (tab === 'blocks') editor.resize();
  else pineEditor.refresh();
});
new ResizeObserver(() => editor.resize()).observe(document.getElementById('blockly')!);
const fitButton = h('button', { type: 'button', class: 'fit-blocks', title: 'Zoom and scroll so the whole strategy is visible' }, 'Fit');
fitButton.addEventListener('click', () => editor.fit());
document.getElementById('left-tabs')!.append(fitButton);
/** Fit after Blockly has laid the new blocks out (animation frames may stall in a hidden window: use a timer). */
const fitSoon = () => setTimeout(() => editor.fit(), 60);
if (editor.restored === 'default') fitSoon(); // a fresh user sees the whole starter strategy

setupSplitter(
  document.getElementById('layout')!,
  document.getElementById('splitter')!,
  parseStoredFraction(loadText(SPLIT_STORAGE_KEY)),
  (fraction) => saveText(SPLIT_STORAGE_KEY, String(fraction)),
  () => editor.resize(),
);

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
  return { id: 'blocks', workspace, pineScripts: pineRecords, pineRetired };
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
    benchmark: result.benchmark ? { returnPct: result.benchmark.returnPct, maxDrawdownPct: result.benchmark.maxDrawdownPct } : null,
    activity: result.activity ?? null,
    warmup,
  });
}

async function run(): Promise<void> {
  if (mode !== 'backtest') return; // Enter in the top-bar form while in Live mode
  const parsed = parseSettings(topBar.read(), Date.now());
  if (!parsed.ok) {
    setStatus(`Cannot run: ${parsed.error}.`, true);
    topBar.showInvalid(parsed.field);
    return;
  }
  const spec = strategySpec();
  if (!spec) return;
  const settings = parsed.settings;
  topBar.setRunning(true);
  stats.clear();
  verdict.clear();
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
    verdict.show(verdictFor(result, candles.length, strategyWarmup(spec)));
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

const topBar = createTopBar(document.getElementById('topbar')!, defaultRawSettings(Date.now()), () => void run(), mode, (m) => switchMode(m),
  () => strategyChoice === 'smaCross');

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
  const spec = strategySpec();
  if (!spec || spec.id !== 'blocks') return { ok: false, error: 'Cannot start a live session: fix the block problems first (listed under the workspace).' };
  return { ok: true, symbol, timeframe, brokerConfig: broker, strategy: blocksSnapshot(spec.workspace, spec.pineScripts ?? [], spec.pineRetired ?? []) };
}

const liveSessions = new LiveMode(document.getElementById('live')!, {
  chart,
  stats,
  setStatus,
  highlightBlock: (blockId, message) => editor.highlightError(blockId, message),
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
}

const flowDeps: FlowDeps = {
  editor,
  memory: starterMemory,
  confirm: (message) => window.confirm(message),
  status: (message, isError = false) => setStatus(message, isError),
  now: () => Date.now(),
};

/** Loads a starter (starterFlow.ts: edits are confirmed and kept among the last 3 previous workspaces). */
function pickStarter(id: StarterId): void {
  const starter = getStarter(id);
  if (!starter || !pickStarterFlow(flowDeps, starter)) return;
  if (strategyChoice !== 'blocks') setStrategyChoice('blocks'); // Run must test the strategy just loaded
  fitSoon();
}

/** Brings previous workspace `id` back; the blocks it replaces take its place in the list. */
function restorePrevious(id: string): void {
  if (!restorePreviousFlow(flowDeps, id)) return;
  if (strategyChoice !== 'blocks') setStrategyChoice('blocks');
  fitSoon();
}

createStarterPicker(topBar.tools, STARTERS, { onPick: pickStarter, onRestore: restorePrevious, previousList: () => starterMemory.previousList });
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
