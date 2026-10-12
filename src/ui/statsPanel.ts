import { ColorType, LineSeries, LineStyle, createChart, type IChartApi, type ISeriesApi } from 'lightweight-charts';
import { BENCH_TEXT } from './descriptions';
import { setExplain } from './explain';
import { icon } from './icons';
import { EXIT_REASON_HELP, EXIT_REASON_LABEL, STAT_HELP, TRADE_COLUMNS } from './statHelp';
import { CANVAS_COLORS, onThemeChange, type Theme } from './theme';
import { BENCHMARK_DEFINITION, benchmarkDefinition, benchmarkLabel, type Benchmark } from '../engine/benchmark';
import type { BacktestResult } from '../engine/engine';
import type { EquityPoint, Stats } from '../engine/stats';
import type { LogEntry, Trade } from '../engine/types';
import { toChartTime } from './chartData';
import { benchmarkCardRows } from './verdict';
import { h } from './dom';
import { fmtNum, fmtTime, statsRows, type StatRow } from './format';
import { loadText, saveText } from './storage';

export const BENCHMARK_LINE_STORAGE_KEY = 'quant-sim.benchmark-line';


const MAX_TRADE_ROWS = 500;

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
  private shownTrades: readonly Trade[] = [];
  private tradePicked: (trade: Trade) => void = () => {};

  constructor(container: HTMLElement) {
    this.cards = h('div', { class: 'stat-cards', tabindex: '0', role: 'region', 'aria-label': 'Score cards' });
    const equityEl = h('div', { class: 'equity' });
    this.benchToggle = h('input', { type: 'checkbox' });
    this.benchToggle.checked = loadText(BENCHMARK_LINE_STORAGE_KEY) !== '0';
    setExplain(this.benchToggle, BENCH_TEXT.title, BENCH_TEXT.on, BENCH_TEXT.off);
    this.benchLabel = h('label', { class: 'bench-toggle', title: BENCHMARK_DEFINITION }, this.benchToggle, (this.benchLabelText = document.createTextNode('Buy & hold line')));
    this.benchLabel.hidden = true;
    this.trades = h('div', { class: 'trades', tabindex: '0', role: 'region', 'aria-label': 'List of trades' });
    this.log = h('div', { class: 'log' });
    container.append(
      h('div', { class: 'stats-left' }, this.cards, h('div', { class: 'equity-wrap' }, equityEl, this.benchLabel)),
      h('div', { class: 'stats-right' }, this.trades, this.log),
    );
    const colors = CANVAS_COLORS.dark;
    this.equityChart = createChart(equityEl, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: colors.background }, textColor: colors.text },
      grid: { vertLines: { visible: false }, horzLines: { color: colors.gridSoft } },
      timeScale: { timeVisible: true, borderColor: colors.border },
      rightPriceScale: { borderColor: colors.border },
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
    onThemeChange((theme) => this.setTheme(theme));
    this.clear();
  }

  /** Re-colours the equity chart for the page's colour scheme. */
  setTheme(theme: Theme): void {
    const c = CANVAS_COLORS[theme];
    this.equityChart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.background }, textColor: c.text },
      grid: { vertLines: { visible: false }, horzLines: { color: c.gridSoft } },
      timeScale: { borderColor: c.border },
      rightPriceScale: { borderColor: c.border },
    });
    this.benchSeries.applyOptions({ color: c.muted });
  }

  /** Called when a trade row is clicked ("show this trade on the chart"). */
  onTradePick(handler: (trade: Trade) => void): void {
    this.tradePicked = handler;
  }

  /** The trades of the result on screen (for "Export trades"); empty after clear(). */
  get currentTrades(): readonly Trade[] {
    return this.shownTrades;
  }

  clear(hint = 'Press Run and the computer replays old prices with your strategy. Your score card shows up here.'): void {
    this.shownTrades = [];
    this.cards.replaceChildren(hint === ''
      ? h('div', { class: 'hint' })
      : h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, icon('play', 18)), h('div', {}, h('strong', {}, 'No results yet'), hint)));
    this.equitySeries.setData([]);
    this.setBenchmark(null);
    this.trades.replaceChildren(hint === '' ? '' : h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, icon('list', 18)), h('div', {}, h('strong', {}, 'No trades yet'), 'Every time your robot buys or sells, a row appears here.')));
    this.log.replaceChildren();
  }

  render(result: BacktestResult): void {
    this.showStats(result.stats, result.wiped, result.benchmark ?? null);
    this.setBenchmark(result.benchmark ?? null);
    this.setEquity(result.equityCurve);
    this.setTrades(result.trades);
    this.log.replaceChildren();
    this.appendLog(result.log);
  }

  /** The stat cards (live sessions call this per update, without a benchmark). */
  showStats(stats: Stats, wiped: boolean, benchmark: Benchmark | null = null): void {
    const card = (row: StatRow, cls = '', title?: string) =>
      h('div', { class: `card ${row.tone}${cls}`, 'data-tip': title }, h('div', { class: 'label' }, row.label), h('div', { class: 'value' }, row.value));
    const rows = statsRows(stats);
    const cards = rows.map((row) => card(row, '', STAT_HELP[row.label]));
    if (benchmark) {
      const at = rows.findIndex((r) => r.label === 'Max drawdown') + 1;
      const info = benchmarkDefinition(benchmark.leverage ?? 1);
      // Buy & hold cards right after the strategy's max drawdown (a wiped leveraged hold says so: verdict.ts).
      cards.splice(at, 0, ...benchmarkCardRows({ ...benchmark, wipedTime: benchmark.wipedTime ?? null }).map((row) => card(row, ' bench', info)));
    }
    this.cards.replaceChildren(...cards);
    if (wiped) this.cards.append(h('div', { class: 'card neg wiped' }, 'ACCOUNT WIPED'));
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
    this.shownTrades = trades;
    if (trades.length === 0) {
      this.trades.replaceChildren(h('div', { class: 'empty' }, h('span', { class: 'empty-icon' }, icon('list', 18)), h('div', {}, h('strong', {}, 'No trades yet'), 'Every time your robot buys or sells, a row appears here.')));
      return;
    }
    const header = h('tr', {}, ...TRADE_COLUMNS.map((c) => h('th', { 'data-tip': c.help }, c.title)));
    const shown = trades.slice(-MAX_TRADE_ROWS);
    const offset = trades.length - shown.length;
    const rows = shown.map((t, i) => {
      const jump = h('button', { type: 'button', class: 'trade-jump', 'aria-label': `Show trade ${offset + i + 1} on the chart`, 'data-tip': 'Show this trade on the chart' }, String(offset + i + 1));
      jump.addEventListener('click', (ev) => { ev.stopPropagation(); this.tradePicked(t); });
      const row = h(
        'tr', { class: 'trade-row' },
        h('td', {}, jump),
        h('td', { class: t.side === 'long' ? 'pos' : 'neg' }, t.side),
        h('td', {}, fmtTime(t.entryTime)),
        h('td', {}, fmtNum(t.entryPrice)),
        h('td', {}, fmtTime(t.exitTime)),
        h('td', {}, fmtNum(t.exitPrice)),
        h('td', {}, fmtNum(t.qty, 4)),
        h('td', { class: t.netPnl >= 0 ? 'pos' : 'neg' }, fmtNum(t.netPnl)),
        h('td', { 'data-tip': EXIT_REASON_HELP[t.exitReason] }, EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason),
      );
      row.addEventListener('click', () => this.tradePicked(t));
      return row;
    });
    const note = offset > 0 ? [h('div', { class: 'hint' }, `showing last ${MAX_TRADE_ROWS} of ${trades.length} trades`)] : [];
    this.trades.replaceChildren(...note, h('table', {}, h('thead', {}, header), h('tbody', {}, ...rows)));
  }
}
