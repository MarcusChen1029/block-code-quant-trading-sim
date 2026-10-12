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
import { MarkerSet } from './markerSet';
import { MAX_MARKERS_PER_SIGNAL, MAX_TEXT_MARKERS, signalMarkers, type SignalHit } from './markers';
import { computeOverlaySeries, dedupeOverlaySignals, lineTitle, overlayPoint, signalPriceKey, type OverlayDef, type OverlaySignal } from './overlays';
import type { LogicalRange } from './viewRange';
import { ZoneStore, type ZoneRect } from './zoneGeometry';
import { ZoneLayer } from './zonePrimitive';
import { onThemeChange, themeColors } from './theme';

interface ActiveSignal {
  signal: OverlaySignal;
  hits: SignalHit[];
  /** Marker group (and id prefix) of this signal, and its rank: at one time, trades come first, then signals in overlay order. */
  group: string;
  rank: number;
}

interface ActiveOverlay {
  def: OverlayDef;
  step: (candle: Candle) => Record<string, number>;
  series: Record<string, ISeriesApi<'Line'>>;
  signals: ActiveSignal[];
  /** Where its signal markers go: its first line series (sub-pane overlays), else the candles. */
  markerSeries: ISeriesApi<'Line'> | null;
  /** Zone indicators: its zones (null when another overlay already draws the same zones, or none). */
  zones: ZoneStore | null;
}

const GLYPH = new Map([['arrowUp', '▲'], ['arrowDown', '▼'], ['circle', '●'], ['square', '■']]);

/**
 * Thin wrapper around a lightweight-charts v5 chart: candles + volume on pane 0, overlays on pane 0 or sub-panes.
 * Markers: trade fills and price-pane signals share the candle series (merged by time); sub-pane signals sit on
 * their indicator's first line. A small legend names each drawn signal and, under the crosshair, what fired.
 */
export class ChartPanel {
  private readonly chart: IChartApi;
  private readonly candles: ISeriesApi<'Candlestick'>;
  private readonly volume: ISeriesApi<'Histogram'>;
  private overlays: ActiveOverlay[] = [];
  private markers: ISeriesMarkersPluginApi<Time> | null = null;
  /** Trade (fill) markers, kept apart from signal markers so either can be replaced alone. */
  private tradeMarkers: SeriesMarker<UTCTimestamp>[] = [];
  /** Candle-series markers (trades + price-pane signals), maintained incrementally. */
  private readonly candleSet = new MarkerSet();
  /** Marker plugins (and their marker sets) of sub-pane line series that carry signal markers. */
  private readonly paneMarkers = new Map<ISeriesApi<'Line'>, ISeriesMarkersPluginApi<Time>>();
  private readonly paneSets = new Map<ISeriesApi<'Line'>, MarkerSet>();
  private readonly legend: HTMLElement;
  private hoverTime: number | null = null;
  private lastTime = -Infinity;
  /** Open times (ms) of the bars on the chart, ascending: logical index lookup for the zone layer. */
  private times: number[] = [];
  private readonly zoneLayer: ZoneLayer;
  /** Bumped by every explicit view change, so a fit still waiting for a frame never overrides it. */
  private viewToken = 0;

  constructor(private readonly container: HTMLElement) {
    this.chart = createChart(container, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#131722' }, textColor: '#d1d4dc' },
      grid: { vertLines: { color: '#1e222d' }, horzLines: { color: '#1e222d' } },
      timeScale: { timeVisible: true, secondsVisible: false, lockVisibleTimeRangeOnResize: true },
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
    this.zoneLayer = new ZoneLayer((time) => this.timeIndex(time), () => this.lastTime);
    this.candles.attachPrimitive(this.zoneLayer);
    this.legend = document.createElement('div');
    this.legend.className = 'signal-legend';
    this.legend.hidden = true;
    container.append(this.legend);
    this.applyTheme();
    onThemeChange(() => this.applyTheme());
    this.chart.subscribeCrosshairMove((param) => {
      const t = typeof param.time === 'number' ? param.time * 1000 : null;
      if (t === this.hoverTime) return;
      this.hoverTime = t;
      this.renderLegend();
    });
  }

  /**
   * Replaces all candles and fits the view (`fit` false: the caller restores a view instead, see showRange).
   * Call setOverlays afterwards to recompute overlays.
   */
  setCandles(candles: readonly Candle[], fit = true): void {
    this.candles.setData(candles.map(candleToBar));
    this.volume.setData(candles.map(candleToVolume));
    this.lastTime = candles.length > 0 ? candles[candles.length - 1].time : -Infinity;
    this.times = candles.map((c) => c.time);
    if (fit) this.fit();
  }

  /** Background, text, grid and border colours from the shown theme. */
  private applyTheme(): void {
    const c = themeColors();
    this.chart.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.chartBg }, textColor: c.chartText },
      grid: { vertLines: { color: c.chartGrid }, horzLines: { color: c.chartGrid } },
      rightPriceScale: { borderColor: c.chartBorder },
      timeScale: { borderColor: c.chartBorder },
    });
  }

  /** The chart as a PNG image (what is on screen, with price and time axes). */
  screenshot(): Promise<Blob | null> {
    const canvas = this.chart.takeScreenshot();
    return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  }

  /** The visible logical range (bar indexes), or null when nothing is laid out yet. */
  visibleRange(): LogicalRange | null {
    const r = this.chart.timeScale().getVisibleLogicalRange();
    return r ? { from: r.from, to: r.to } : null;
  }

  /** Shows `range` (bar indexes); cancels a fit that is still waiting for a frame. */
  showRange(range: LogicalRange): void {
    this.viewToken++;
    this.chart.timeScale().setVisibleLogicalRange(range);
  }

  /** Open times of the bars on the chart (forming bar included), ascending. Do not mutate. */
  barTimes(): readonly number[] {
    return this.times;
  }

  /** Called whenever the visible range changes (user zoom/scroll, or programmatic). */
  onVisibleRangeChange(listener: () => void): void {
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(() => listener());
  }

  /**
   * Fits all bars into view. If the container has no width yet (hidden tab/pane), waits until it gets one:
   * autoSize applies the real width asynchronously and fitContent on a zero-width chart is a no-op.
   */
  fit(): void {
    const token = ++this.viewToken;
    const fitNow = () => requestAnimationFrame(() => {
      if (token === this.viewToken) this.chart.timeScale().fitContent();
    });
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
    if (candle.time > this.lastTime) this.times.push(candle.time);
    this.lastTime = candle.time;
  }

  /** Removes every overlay and draws `defs` computed over `candles`. Sub-pane overlays get one pane each. */
  setOverlays(defs: readonly OverlayDef[], candles: readonly Candle[]): void {
    for (const o of this.overlays) for (const s of Object.values(o.series)) this.chart.removeSeries(s);
    this.overlays = [];
    this.paneMarkers.clear(); // their series are gone
    this.paneSets.clear();
    while (this.chart.panes().length > 1) this.chart.removePane(this.chart.panes().length - 1);

    let nextPane = 1;
    let rank = 0; // trades are rank 0
    const zoneKeys = new Set<string>();
    // The same signal of the same indicator settings (e.g. a strategy's and a picked toggle's) is marked once.
    for (const def of dedupeOverlaySignals(defs)) {
      // A sub-pane overlay without lines (a signal-only Pine script) gets no pane: its markers go on the candles.
      const paneIndex = def.pane === 'price' || def.lines.length === 0 ? 0 : nextPane++;
      const index = this.overlays.length;
      const signals: ActiveSignal[] = (def.signals ?? []).map((signal) => ({ signal, hits: [], group: `sig${index}:${signal.key}`, rank: ++rank }));
      const create = def.create();
      // Zones identical to an earlier overlay's (a strategy's and a picked toggle) are drawn once.
      const key = def.zoneKey ?? def.id;
      const zones = def.zones && !zoneKeys.has(key) ? new ZoneStore(def.zones) : null;
      if (def.zones) zoneKeys.add(key);
      // Records signal hits and zone events while the lines are computed (one pass; live bars use the same step).
      const step = (candle: Candle) => {
        const values = create(candle);
        for (const s of signals) {
          if (values[s.signal.key] === 1) s.hits.push({ time: candle.time, price: values[signalPriceKey(s.signal.key)] ?? NaN });
        }
        if (zones && create.zones) zones.apply(create.zones());
        return values;
      };
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
            title: lineTitle(def, line),
          },
          paneIndex,
        );
        series[line.key].setData(points[line.key]);
      }
      const first = def.lines[0] ? series[def.lines[0].key] : undefined;
      this.overlays.push({ def, step, series, signals, markerSeries: paneIndex > 0 && first ? first : null, zones });
    }
    this.zoneLayer.setStores(this.overlays.flatMap((o) => (o.zones ? [o.zones] : [])));
    const panes = this.chart.panes();
    if (panes.length > 1) panes[0].setStretchFactor(3);
    this.refreshMarkers();
  }

  /** Replaces the trade markers on the candle series (empty array clears them). Markers must be sorted by time. */
  setMarkers(markers: SeriesMarker<UTCTimestamp>[]): void {
    this.tradeMarkers = [...markers];
    this.candleSet.setGroup('trades', 0, this.tradeMarkers);
    this.pushCandleMarkers();
  }

  /** Adds trade markers (new fills of a live session) without rebuilding the others. */
  appendMarkers(markers: readonly SeriesMarker<UTCTimestamp>[]): void {
    if (markers.length === 0) return;
    this.tradeMarkers.push(...markers);
    this.candleSet.append('trades', 0, markers);
    this.pushCandleMarkers();
  }

  /**
   * Feeds one newly CLOSED candle to every overlay (O(1) per overlay). A signal that fired adds its new markers to
   * its target's marker set (nothing else is rebuilt); only crossing the text limit redraws that one signal.
   */
  updateOverlays(candle: Candle): void {
    let candleDirty = false;
    const paneDirty = new Set<ISeriesApi<'Line'>>();
    for (const o of this.overlays) {
      const before = o.signals.map((s) => s.hits.length);
      const values = o.step(candle);
      for (const line of o.def.lines) o.series[line.key].update(overlayPoint(candle.time, values[line.key]));
      o.signals.forEach((s, i) => {
        const after = s.hits.length;
        if (after === before[i]) return;
        const set = o.markerSeries === null ? this.candleSet : this.paneSet(o.markerSeries);
        const style = s.signal.marker;
        if (before[i] <= MAX_TEXT_MARKERS && after > MAX_TEXT_MARKERS && style.text) {
          set.setGroup(s.group, s.rank, signalMarkers(style, s.hits, s.group));
        } else {
          set.append(s.group, s.rank, signalMarkers(style, s.hits.slice(before[i]), s.group, after), MAX_MARKERS_PER_SIGNAL);
        }
        if (o.markerSeries === null) candleDirty = true;
        else paneDirty.add(o.markerSeries);
      });
    }
    if (candleDirty) this.pushCandleMarkers(false);
    for (const series of paneDirty) this.pushPaneMarkers(series);
    if (candleDirty || paneDirty.size > 0) this.renderLegend();
    // Active zones grow to the new bar and events may have arrived: redraw the layer (no series are recreated).
    if (this.overlays.some((o) => o.zones)) this.zoneLayer.update();
  }

  /** Zone boxes of the last draw, in CSS pixels (inspection / browser checks). */
  zoneRects(): readonly ZoneRect[] {
    return this.zoneLayer.drawnRects();
  }

  /** Zones kept per zone overlay label (active + recently ended). */
  zoneCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.overlays) if (o.zones) out[o.def.label] = o.zones.size;
    return out;
  }

  /** Logical index of the bar opening at `time` (binary search), or null when it is not on the chart. */
  private timeIndex(time: number): number | null {
    let lo = 0;
    let hi = this.times.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this.times[mid];
      if (t === time) return mid;
      if (t < time) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  }

  /** Number of signal markers drawn per signal label (inspection / tests in the browser). */
  signalCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const o of this.overlays) for (const s of o.signals) out[s.signal.label] = s.hits.length;
    return out;
  }

  destroy(): void {
    this.chart.remove();
  }

  /** Rebuilds every marker set (trades + all signals) from scratch, then the legend. */
  private refreshMarkers(): void {
    this.candleSet.clear();
    this.candleSet.setGroup('trades', 0, this.tradeMarkers);
    for (const o of this.overlays) {
      for (const s of o.signals) {
        const set = o.markerSeries === null ? this.candleSet : this.paneSet(o.markerSeries);
        set.setGroup(s.group, s.rank, signalMarkers(s.signal.marker, s.hits, s.group));
      }
    }
    this.pushCandleMarkers(false);
    for (const series of this.paneSets.keys()) this.pushPaneMarkers(series);
    this.renderLegend();
  }

  private paneSet(series: ISeriesApi<'Line'>): MarkerSet {
    let set = this.paneSets.get(series);
    if (!set) {
      set = new MarkerSet();
      this.paneSets.set(series, set);
    }
    return set;
  }

  private pushCandleMarkers(legend = true): void {
    const list = this.candleSet.list();
    if (this.markers === null) this.markers = createSeriesMarkers(this.candles, list);
    else this.markers.setMarkers(list);
    if (legend) this.renderLegend();
  }

  private pushPaneMarkers(series: ISeriesApi<'Line'>): void {
    const list = this.paneSet(series).list();
    const plugin = this.paneMarkers.get(series);
    if (plugin) plugin.setMarkers(list);
    else this.paneMarkers.set(series, createSeriesMarkers(series, list));
  }

  /** Each drawn signal (shape, colour, name, count) and, under the crosshair, the signals that fired on that bar. */
  private renderLegend(): void {
    const rows: HTMLElement[] = [];
    const firing: string[] = [];
    for (const o of this.overlays) {
      for (const s of o.signals) {
        const row = document.createElement('div');
        row.className = 'sig-row';
        const glyph = document.createElement('span');
        glyph.className = 'sig-glyph';
        glyph.style.color = s.signal.marker.color ?? '#2962ff';
        glyph.textContent = GLYPH.get(s.signal.marker.shape) ?? '●';
        const count = document.createElement('span');
        count.className = 'sig-count';
        const capped = s.hits.length > MAX_MARKERS_PER_SIGNAL ? `, last ${MAX_MARKERS_PER_SIGNAL} shown` : '';
        count.textContent = ` (${s.hits.length}${capped})`;
        row.append(glyph, document.createTextNode(s.signal.label), count);
        row.title = s.signal.label;
        rows.push(row);
        if (this.hoverTime !== null && s.hits.some((h) => h.time === this.hoverTime)) firing.push(s.signal.label);
      }
    }
    if (firing.length > 0) {
      const hover = document.createElement('div');
      hover.className = 'sig-hover';
      hover.textContent = `This bar: ${firing.join(' · ')}`;
      rows.push(hover);
    }
    this.legend.replaceChildren(...rows);
    this.legend.hidden = rows.length === 0;
  }
}
