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

export const BENCHMARK_LINE_STORAGE_KEY = 'quant-sim.benchmark-line';


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

  constructor(private readonly container: HTMLElement) {
    this.cards = h('div', { class: 'stat-cards' });
    const equityEl = h('div', { class: 'equity' });
    this.benchToggle = h('input', { type: 'checkbox' });
    this.benchToggle.checked = loadText(BENCHMARK_LINE_STORAGE_KEY) !== '0';
    this.benchLabel = h('label', { class: 'bench-toggle', title: BENCHMARK_DEFINITION }, this.benchToggle, (this.benchLabelText = document.createTextNode('Buy & hold line')));
    this.benchLabel.hidden = true;
    this.trades = h('div', { class: 'trades' });
    this.log = h('div', { class: 'log' });
    this.csvButton = tip(h('button', { type: 'button', class: 'btn btn-small', disabled: '' }, icon('download', 14), h('span', {}, 'CSV')),
      'Download the trade list as a spreadsheet file (CSV) you can open in Excel, Numbers or Google Sheets.');
    this.csvButton.addEventListener('click', () => {
      if (this.lastTrades.length > 0) downloadFile(datedFileName('quant-sim-trades', 'csv', Date.now()), tradesToCsv(this.lastTrades), 'text/csv;charset=utf-8');
    });
    container.append(
      h('div', { class: 'stats-left' }, this.cards, h('div', { class: 'equity-wrap' }, equityEl, this.benchLabel)),
      h('div', { class: 'stats-right' },
        h('div', { class: 'sub-head' }, h('span', { 'data-tip': 'Every finished trade, newest at the bottom. Hover over a column title to learn what it means.' }, 'Trade list'), this.csvButton),
        this.trades,
        h('div', { class: 'sub-head' }, h('span', { 'data-tip': 'Messages from your strategy (the “log” block) and from the simulator, with the time of the candle.' }, 'Robot log')),
        this.log),
    );
    this.equityChart = createChart(equityEl, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc', attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, lockVisibleTimeRangeOnResize: true },
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
    this.applyTheme();
    onThemeChange(() => this.applyTheme());
    this.clear();
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
