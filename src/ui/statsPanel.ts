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
