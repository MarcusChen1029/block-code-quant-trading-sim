import type {
  IChartApiBase, IPrimitivePaneRenderer, IPrimitivePaneView, ISeriesApi, ISeriesPrimitive, Logical, PrimitivePaneViewZOrder,
  SeriesAttachedParameter, SeriesType, Time,
} from 'lightweight-charts';
import { zoneColors, zoneRects, type ZoneRect, type ZoneStore } from './zoneGeometry';

type DrawTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

/**
 * lightweight-charts v5 series primitive (attached to the candle series) that draws zone boxes: order blocks,
 * fair value gaps (translucent boxes with a fixed label) and swing levels (dashed lines). Geometry is recomputed
 * on every draw from the chart's own converters, so zoom / scroll / resize / DPR changes are always right; new zone
 * events only call requestUpdate (no series are recreated, so live updates do not flicker).
 */
export class ZoneLayer implements ISeriesPrimitive<Time> {
  private chart: IChartApiBase<Time> | null = null;
  private series: ISeriesApi<SeriesType, Time> | null = null;
  private requestUpdate: (() => void) | null = null;
  private stores: ZoneStore[] = [];
  private lastRects: ZoneRect[] = [];
  private readonly views: readonly IPrimitivePaneView[];

  /**
   * @param timeIndex - bar open time (ms) -> logical index of that bar on the chart (null when unknown)
   * @param lastTime - open time (ms) of the last bar on the chart
   */
  constructor(private readonly timeIndex: (time: number) => number | null, private readonly lastTime: () => number) {
    const renderer: IPrimitivePaneRenderer = { draw: (target) => this.draw(target) };
    this.views = [{ zOrder: (): PrimitivePaneViewZOrder => 'bottom', renderer: () => (this.stores.length > 0 ? renderer : null) }];
  }

  attached(param: SeriesAttachedParameter<Time>): void {
    this.chart = param.chart;
    this.series = param.series;
    this.requestUpdate = param.requestUpdate;
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.requestUpdate = null;
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /** Replaces the zone stores to draw. */
  setStores(stores: ZoneStore[]): void {
    this.stores = stores;
    if (stores.length === 0) this.lastRects = [];
    this.update();
  }

  /** Zones changed (or a bar was added): redraw on the next frame. */
  update(): void {
    this.requestUpdate?.();
  }

  /** The boxes of the last draw (media coordinates), for inspection / browser checks. */
  drawnRects(): readonly ZoneRect[] {
    return this.lastRects;
  }

  private draw(target: DrawTarget): void {
    const { chart, series } = this;
    if (!chart || !series) return;
    const timeScale = chart.timeScale();
    target.useBitmapCoordinateSpace((scope) => {
      const { context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr } = scope;
      const rects = zoneRects(this.stores, {
        timeToX: (time) => {
          const i = this.timeIndex(time);
          return i === null ? null : timeScale.logicalToCoordinate(i as Logical);
        },
        priceToY: (price) => series.priceToCoordinate(price),
        lastTime: this.lastTime(),
        halfBar: timeScale.options().barSpacing / 2,
        width: scope.mediaSize.width,
        height: scope.mediaSize.height,
      });
      this.lastRects = rects;
      ctx.save();
      ctx.font = `${Math.round(10 * vr)}px sans-serif`;
      ctx.textBaseline = 'top';
      for (const r of rects) {
        const c = zoneColors(r.style, r.kind, r.ended);
        const x1 = Math.round(r.x1 * hr);
        const x2 = Math.round(r.x2 * hr);
        const y1 = Math.round(r.y1 * vr);
        const y2 = Math.round(r.y2 * vr);
        if (r.style === 'swing') {
          ctx.strokeStyle = c.stroke;
          ctx.lineWidth = Math.max(1, Math.round(hr));
          ctx.setLineDash([4 * hr, 3 * hr]);
          ctx.beginPath();
          ctx.moveTo(x1, y1 + 0.5);
          ctx.lineTo(x2, y1 + 0.5);
          ctx.stroke();
          ctx.setLineDash([]);
        } else {
          const h = Math.max(1, y2 - y1);
          ctx.fillStyle = c.fill;
          ctx.fillRect(x1, y1, x2 - x1, h);
          ctx.strokeStyle = c.stroke;
          ctx.lineWidth = Math.max(1, Math.round(hr));
          ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, h - 1);
        }
        // Fixed label strings only ('OB+', 'FVG-', 'SH', ...); drawn when the box is wide enough.
        if (r.x2 - r.x1 > 26) {
          ctx.fillStyle = c.text;
          ctx.fillText(r.label, x1 + 3 * hr, r.style === 'swing' ? y1 - 12 * vr : y1 + 2 * vr);
        }
      }
      ctx.restore();
    });
  }
}
