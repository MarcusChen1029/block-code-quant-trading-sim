import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { BENCHMARK_DEFINITION, benchmarkDefinition, benchmarkLabel, type Benchmark } from '../engine/benchmark';
import type { BacktestResult } from '../engine/engine';
import type { EquityPoint, Stats } from '../engine/stats';
import type { LogEntry, Trade } from '../engine/types';
import { toChartTime } from './chartData';
import { benchmarkCardRows } from './verdict';
import { h } from './dom';
import { fmtNum, fmtTime, statsRows, type StatRow } from './format';
import { loadText, saveText } from './storage';
import { icon } from './icons';
import { onThemeChange, themeColors } from './theme';
import { tip } from './tooltip';
import { datedFileName, downloadFile, tradesToCsv } from './exportFiles';
import { bestRunIndex, type RunRecord } from './runHistory';

export const BENCHMARK_LINE_STORAGE_KEY = 'quant-sim.benchmark-line';
export const STATS_VIEW_STORAGE_KEY = 'quant-sim.stats-view';

export type StatsView = 'summary' | 'trades' | 'log' | 'history';
const parseView = (raw: string | null): StatsView => (raw === 'trades' || raw === 'log' || raw === 'history' ? raw : 'summary');


const MAX_TRADE_ROWS = 500;

/** What each stat card means, in plain words (shown when the card is hovered, focused or tapped). */
export const STAT_HELP: Record<string, string> = {
  'Total return': 'How much your money grew or shrank, in percent. +10% means $10,000 became $11,000.',
  'Net profit': 'The pretend dollars you made (or lost) in total, after fees.',
  'Final equity': 'What the account was worth at the end, including any trade still open.',
  'Max drawdown': 'The biggest drop from a high point to a low point along the way. Smaller is calmer. 20% means at one point you were down a fifth from your best.',
  'Win rate': 'The share of trades that made money. 60% means 6 out of 10 trades were winners.',
  'Profit factor': 'Money won on winners divided by money lost on losers. Above 1 means winners beat losers; 2 means they won twice as much.',
  Sharpe: 'Sharpe ratio: return compared with how bumpy the ride was. Above 1 is good, above 2 is very good, below 0 lost money.',
  Trades: 'How many complete trades (in and back out) the strategy made.',
  Exposure: 'How much of the time the strategy was holding a trade. 100% means it was always in the market.',
};

/** Help for the buy & hold cards ('Buy & hold (3x) return' etc.). */
function benchHelp(label: string): string {
  if (label.endsWith('return')) return 'What you would have made by simply buying at the start and holding until the end. Your strategy should try to beat this.';
  if (label.endsWith('max DD')) return 'The biggest drop that just buying and holding would have suffered along the way.';
  return 'Just buying and holding would have lost the whole account (too much leverage).';
}

/** Column help for the trade list. */
const TRADE_COLUMNS: Array<[string, string]> = [
  ['#', 'Trade number, in order.'],
  ['Side', 'Long = bought, hoping the price goes up. Short = sold, hoping the price goes down.'],
  ['Entry', 'When the trade started (UTC time).'],
  ['Entry price', 'The price the trade started at.'],
  ['Exit', 'When the trade ended (UTC time).'],
  ['Exit price', 'The price the trade ended at.'],
  ['Size', 'How many coins the trade was for.'],
  ['Profit', 'Money made (green) or lost (red) on this trade, after fees.'],
  ['Exit by', 'What closed the trade: your rule (market / limit / stop order), a stop-loss, a take-profit, or the account being wiped.'],
];

const EXIT_NAMES: Record<string, string> = {
  market: 'rule', limit: 'limit order', stop: 'stop order', stopLoss: 'stop-loss', takeProfit: 'take-profit', wiped: 'wiped out',
};

/** Bottom panel: stat cards + equity curve on the left, trade list and log on the right. */
export class StatsPanel {
  private readonly cards: HTMLElement;
  private readonly equityChart: IChartApi;
  private readonly equitySeries: ISeriesApi<'Line'>;
  private readonly benchSeries: ISeriesApi<'Line'>;
  private readonly benchToggle: HTMLInputElement;
  private readonly benchLabel: HTMLElement;
  private readonly benchLabelText: Text;
  private readonly trades: HTMLElement;
  private readonly log: HTMLElement;
  private readonly csvButton: HTMLButtonElement;
  private readonly summary: HTMLElement;
  private readonly tradesTabCount: HTMLElement;
  private readonly history: HTMLElement;
  private readonly historyTabCount: HTMLElement;
  /** Set by the app: forgets every remembered test. */
  onClearHistory: () => void = () => {};
  private readonly clearHistoryButton = tip(h('button', { type: 'button', class: 'btn btn-small' }, icon('trash', 14), h('span', {}, 'Clear')),
    'Forget the tests listed here. Your blocks and settings are not touched.');
  private readonly views = new Map<StatsView, { tab: HTMLButtonElement; view: HTMLElement }>();
  private view: StatsView = parseView(loadText(STATS_VIEW_STORAGE_KEY));

  constructor(private readonly container: HTMLElement) {
    this.cards = h('div', { class: 'stat-cards' });
    const equityEl = h('div', { class: 'equity' });
    this.benchToggle = h('input', { type: 'checkbox' });
    this.benchToggle.checked = loadText(BENCHMARK_LINE_STORAGE_KEY) !== '0';
    this.benchLabel = h('label', { class: 'bench-toggle', title: BENCHMARK_DEFINITION }, this.benchToggle, (this.benchLabelText = document.createTextNode('Buy & hold line')));
    this.benchLabel.hidden = true;
    this.trades = h('div', { class: 'trades', tabindex: '0', role: 'region', 'aria-label': 'Trade list' });
    this.log = h('div', { class: 'log' });
    this.csvButton = tip(h('button', { type: 'button', class: 'btn btn-small', disabled: '' }, icon('download', 14), h('span', {}, 'CSV')),
      'Download the trade list as a spreadsheet file (CSV) you can open in Excel, Numbers or Google Sheets.');
    this.csvButton.addEventListener('click', () => {
      if (this.lastTrades.length > 0) downloadFile(datedFileName('quant-sim-trades', 'csv', Date.now()), tradesToCsv(this.lastTrades), 'text/csv;charset=utf-8');
    });
    // Three views behind tabs: the summary (cards + money over time), the trade list, the robot's log.
    this.summary = h('div', { class: 'stats-view stats-summary', role: 'tabpanel', id: 'stats-view-summary', 'aria-labelledby': 'stats-tab-summary' },
      this.cards, h('div', { class: 'equity-wrap' }, equityEl, this.benchLabel));
    const tradesView = h('div', { class: 'stats-view', role: 'tabpanel', id: 'stats-view-trades', 'aria-labelledby': 'stats-tab-trades' }, this.trades);
    const logView = h('div', { class: 'stats-view', role: 'tabpanel', id: 'stats-view-log', 'aria-labelledby': 'stats-tab-log' }, this.log);
    this.history = h('div', { class: 'trades history', tabindex: '0', role: 'region', 'aria-label': 'Test history' });
    const historyView = h('div', { class: 'stats-view', role: 'tabpanel', id: 'stats-view-history', 'aria-labelledby': 'stats-tab-history' }, this.history);
    this.historyTabCount = h('span', { class: 'tab-count' });
    this.tradesTabCount = h('span', { class: 'tab-count' });
    const tabDefs: Array<[StatsView, Array<Node | string>, string, HTMLElement]> = [
      ['summary', ['Summary'], 'The key numbers and a chart of your money over time. Hover over (or tap) a number to learn what it means.', this.summary],
      ['trades', ['Trades', this.tradesTabCount], 'Every finished trade: when it started and ended, the prices, and how much it made or lost.', tradesView],
      ['log', ['Robot log'], 'Messages from your strategy (the “log” block) and from the simulator, with the time of each candle.', logView],
      ['history', ['History', this.historyTabCount], 'Your recent tests side by side, newest first, so you can see whether a change made your strategy better. 🏆 marks the best one.', historyView],
    ];
    const tablist = h('div', { class: 'stats-tabs', role: 'tablist', 'aria-label': 'Results views' });
    for (const [id, label, help, view] of tabDefs) {
      const b = h('button', { type: 'button', role: 'tab', id: `stats-tab-${id}`, 'aria-controls': view.id, 'data-tip': help }, ...label);
      b.addEventListener('click', () => this.showView(id));
      this.views.set(id, { tab: b, view });
      tablist.append(b);
    }
    tablist.addEventListener('keydown', (ev) => {
      const ids = tabDefs.map(([id]) => id);
      const at = ids.indexOf(this.view);
      const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      const next = ids[(at + step + ids.length) % ids.length];
      this.showView(next);
      this.views.get(next)!.tab.focus();
    });
    container.append(h('div', { class: 'stats-bar' }, tablist, h('div', { class: 'panel-spacer' }), this.csvButton, this.clearHistoryButton), this.summary, tradesView, logView, historyView);
    this.equityChart = createChart(equityEl, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, lockVisibleTimeRangeOnResize: true, minBarSpacing: 0.01 }, // the whole run fits
    });

    this.equitySeries = this.equityChart.addSeries(LineSeries, { color: '#42a5f5', lineWidth: 2, title: 'Equity' });
    // Muted and dashed: a reference line, not a second result.
    this.benchSeries = this.equityChart.addSeries(LineSeries, {
      color: '#787b86', lineWidth: 1, lineStyle: LineStyle.Dashed, title: 'Buy & hold', visible: this.benchToggle.checked,
      priceLineVisible: false, lastValueVisible: false,
    });
    this.benchToggle.addEventListener('change', () => {
      this.benchSeries.applyOptions({ visible: this.benchToggle.checked });
      saveText(BENCHMARK_LINE_STORAGE_KEY, this.benchToggle.checked ? '1' : '0');
    });
    this.clearHistoryButton.addEventListener('click', () => this.onClearHistory());
    this.applyTheme();
    onThemeChange(() => this.applyTheme());
    this.showView(this.view);
    this.clear();
  }

  /** Shows one of the three views (remembered across reloads). */
  showView(view: StatsView): void {
    this.view = view;
    saveText(STATS_VIEW_STORAGE_KEY, view);
    for (const [id, { tab, view: el }] of this.views) {
      const on = id === view;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      el.hidden = !on;
    }
    this.csvButton.hidden = view !== 'trades';
    this.clearHistoryButton.hidden = view !== 'history';
  }

  /** Leaves the History tab (it is backtest-only; Live mode hides it). */
  leaveHistory(): void {
    if (this.view === 'history') this.showView('summary');
  }

  /** Fills the History tab (newest first). The tabs stay reachable while it has entries, even before a run. */
  setHistory(runs: readonly RunRecord[]): void {
    this.historyTabCount.textContent = runs.length > 0 ? String(runs.length) : '';
    this.container.dataset.history = runs.length > 0 ? 'true' : 'false';
    this.clearHistoryButton.disabled = runs.length === 0;
    if (runs.length === 0) {
      this.history.replaceChildren(h('div', { class: 'hint' }, 'No tests yet. Every time you press ▶ Run test, the result is added here so you can compare.'));
      return;
    }
    const best = bestRunIndex(runs);
    const pct = (v: number) => `${v > 0 ? '+' : ''}${fmtNum(v)}%`;
    const cols: Array<[string, string]> = [
      ['When', 'When you ran the test (your local time).'],
      ['Strategy', 'Which strategy was tested.'],
      ['Market', 'Coin and candle size.'],
      ['From', 'The start date of the test.'],
      ['Return', 'How much the money grew or shrank.'],
      ['vs buy & hold', 'Your return minus just buying and holding, in percentage points. Positive = your strategy did better.'],
      ['Worst drop', 'The biggest fall along the way (max drawdown).'],
      ['Trades', 'How many finished trades.'],
    ];
    const rows = runs.map((r, i) => {
      const vs = r.benchReturnPct === null ? null : r.returnPct - r.benchReturnPct;
      return h('tr', { class: i === best ? 'best' : undefined },
        h('td', {}, new Date(r.at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })),
        h('td', { class: 'left' }, i === best ? '🏆 ' : '', r.strategy),
        h('td', {}, `${r.symbol} ${r.timeframe}`),
        h('td', {}, r.startDate),
        h('td', { class: r.returnPct >= 0 ? 'pos' : 'neg' }, pct(r.returnPct), r.wiped ? ' (wiped)' : ''),
        h('td', { class: vs === null ? '' : vs >= 0 ? 'pos' : 'neg' }, vs === null ? '—' : `${vs > 0 ? '+' : ''}${fmtNum(vs)} pts`),
        h('td', {}, `${fmtNum(r.maxDrawdownPct)}%`),
        h('td', {}, String(r.trades)),
      );
    });
    this.history.replaceChildren(h('table', {},
      h('thead', {}, h('tr', {}, ...cols.map(([t, help]) => h('th', { scope: 'col', 'data-tip': help }, t)))),
      h('tbody', {}, ...rows)));
  }

  /** Chart colours from the shown theme. */
  private applyTheme(): void {
    const c = themeColors();
    this.equityChart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.chartBg }, textColor: c.chartText },
      grid: { horzLines: { color: c.chartGrid } },
      rightPriceScale: { borderColor: c.chartBorder },
      timeScale: { borderColor: c.chartBorder },
    });
    this.equitySeries.applyOptions({ color: c.accent });
    this.benchSeries.applyOptions({ color: c.muted });
  }

  /** The trades last shown (for "Download trades"). */
  get shownTrades(): readonly Trade[] {
    return this.lastTrades;
  }

  private lastTrades: readonly Trade[] = [];

  clear(hint = 'Press ▶ Run test to see how your strategy would have done.'): void {
    this.lastTrades = [];
    this.csvButton.disabled = true;
    this.tradesTabCount.textContent = '';
    this.container.dataset.empty = 'true';
    this.cards.replaceChildren(hint === '' ? '' : h('div', { class: 'empty-state' },
      h('span', { class: 'empty-icon', 'aria-hidden': 'true' }, icon('trophy', 26)),
      h('div', {}, h('strong', {}, 'No results yet'), h('p', {}, hint))));
    this.equitySeries.setData([]);
    this.setBenchmark(null);
    this.trades.replaceChildren();
    this.log.replaceChildren();
  }

  render(result: BacktestResult): void {
    this.container.dataset.empty = 'false';
    this.showStats(result.stats, result.wiped, result.benchmark ?? null);
    this.setBenchmark(result.benchmark ?? null);
    this.setEquity(result.equityCurve);
    this.setTrades(result.trades);
    this.log.replaceChildren();
    this.appendLog(result.log);
  }

  /** The stat cards (live sessions call this per update, without a benchmark). */
  showStats(stats: Stats, wiped: boolean, benchmark: Benchmark | null = null): void {
    this.container.dataset.empty = 'false';
    // Cards explain themselves on hover, keyboard focus or a tap (data-tip-click).
    const card = (row: StatRow, cls = '', help?: string) =>
      h('div', { class: `card ${row.tone}${cls}`, tabindex: '0', 'data-tip': help, 'data-tip-title': help ? row.label : undefined, 'data-tip-click': help ? '' : undefined },
        h('div', { class: 'label' }, row.label), h('div', { class: 'value' }, row.value));
    const rows = statsRows(stats);
    const cards = rows.map((row) => card(row, '', STAT_HELP[row.label]));
    if (benchmark) {
      const at = rows.findIndex((r) => r.label === 'Max drawdown') + 1;
      const info = benchmarkDefinition(benchmark.leverage ?? 1);
      // Buy & hold cards right after the strategy's max drawdown (a wiped leveraged hold says so: verdict.ts).
      cards.splice(at, 0, ...benchmarkCardRows({ ...benchmark, wipedTime: benchmark.wipedTime ?? null }).map((row) => card(row, ' bench', `${benchHelp(row.label)}\n\n${info}`)));
    }
    this.cards.replaceChildren(...cards);
    if (wiped) this.cards.append(tip(h('div', { class: 'card neg wiped', tabindex: '0' }, 'ACCOUNT WIPED'), 'The account lost all its money (usually from too much leverage), so the test stopped there.'));
  }

  /** The buy & hold line (null removes it and its toggle). */
  setBenchmark(benchmark: Benchmark | null): void {
    this.benchSeries.setData(benchmark ? benchmark.equityCurve.map((p) => ({ time: toChartTime(p.time), value: p.equity })) : []);
    this.benchLabel.hidden = benchmark === null;
    // Named after the leverage it was sized at: 'Buy & hold (3x)' in the legend, toggle and tooltip.
    const name = benchmarkLabel(benchmark?.leverage ?? 1);
    this.benchSeries.applyOptions({ title: name });
    this.benchLabelText.textContent = `${name} line`;
    this.benchLabel.title = benchmarkDefinition(benchmark?.leverage ?? 1);
  }

  setEquity(points: readonly EquityPoint[]): void {
    this.equitySeries.setData(points.map((p) => ({ time: toChartTime(p.time), value: p.equity })));
    requestAnimationFrame(() => this.equityChart.timeScale().fitContent());
  }

  /** Appends points newer than the last one drawn. */
  appendEquity(points: readonly EquityPoint[]): void {
    for (const p of points) this.equitySeries.update({ time: toChartTime(p.time), value: p.equity });
  }

  /** Appends log lines; keeps the view pinned to the bottom when it already was. */
  appendLog(entries: readonly LogEntry[]): void {
    if (entries.length === 0) return;
    const pinned = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 4;
    this.log.append(...entries.map((l) => h('div', { class: `log-${l.level}` }, `${fmtTime(l.time)}  ${l.message}`)));
    if (pinned) this.log.scrollTop = this.log.scrollHeight;
  }

  setTrades(trades: readonly Trade[]): void {
    this.lastTrades = trades;
    this.csvButton.disabled = trades.length === 0;
    this.tradesTabCount.textContent = trades.length > 0 ? String(trades.length) : '';
    if (trades.length === 0) {
      this.trades.replaceChildren(h('div', { class: 'hint' }, 'No finished trades yet. Trades appear here once your strategy buys and then sells (or the other way round).'));
      return;
    }
    const header = h('tr', {}, ...TRADE_COLUMNS.map(([t, help]) => h('th', { scope: 'col', 'data-tip': help }, t)));
    const shown = trades.slice(-MAX_TRADE_ROWS);
    const offset = trades.length - shown.length;
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
        h('td', {}, EXIT_NAMES[t.exitReason] ?? t.exitReason),
      ),
    );
    const note = offset > 0 ? [h('div', { class: 'hint' }, `showing last ${MAX_TRADE_ROWS} of ${trades.length} trades`)] : [];
    this.trades.replaceChildren(...note, h('table', {}, h('thead', {}, header), h('tbody', {}, ...rows)));
  }
}
