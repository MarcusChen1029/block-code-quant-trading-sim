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
