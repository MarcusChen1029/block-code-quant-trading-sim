import type { ZoneEvent, ZoneStyle } from '../blocks/registry';

/**
 * Pure zone bookkeeping and box geometry for the chart's zone layer (src/ui/zonePrimitive.ts), kept free of the
 * chart library so it can be unit-tested.
 */

/** Ended zones kept per store for drawing (older ended ones are forgotten; active ones are bounded by maxActive). */
export const MAX_KEPT_ZONES = 600;
/** At most this many boxes are drawn (the most recently formed visible ones). */
export const MAX_DRAWN_ZONES = 200;

/** The zones of one overlay: lifecycle events upserted by id, memory bounded. */
export class ZoneStore {
  private readonly byId = new Map<number, ZoneEvent>();

  constructor(readonly style: ZoneStyle, private readonly maxKept = MAX_KEPT_ZONES) {}

  /** Applies lifecycle events; returns whether anything changed. */
  apply(events: readonly ZoneEvent[]): boolean {
    if (events.length === 0) return false;
    for (const e of events) this.byId.set(e.id, { ...e });
    // Forget the oldest ENDED zones beyond the cap (Map order = creation order; active ones are always kept).
    if (this.byId.size > this.maxKept) {
      for (const [id, z] of this.byId) {
        if (this.byId.size <= this.maxKept) break;
        if (z.endTime !== null) this.byId.delete(id);
      }
    }
    return true;
  }

  zones(): IterableIterator<ZoneEvent> {
    return this.byId.values();
  }

  get size(): number {
    return this.byId.size;
  }

  clear(): void {
    this.byId.clear();
  }
}

/** One box to draw, in media (CSS pixel) coordinates; y1 <= y2. A swing level has y1 === y2. */
export interface ZoneRect {
  x1: number;
  x2: number;
  y1: number;
  y2: number;
  style: ZoneStyle;
  kind: ZoneEvent['kind'];
  /** Mitigated / expired / broken: drawn faded up to its end. */
  ended: boolean;
  label: string;
  id: number;
  knownTime: number;
}

export interface ZoneViewport {
  /** Bar open time (ms) -> x of the bar's centre, or null when unknown. */
  timeToX(time: number): number | null;
  priceToY(price: number): number | null;
  /** Time of the last bar on the chart: active zones extend to it. */
  lastTime: number;
  /** Half a bar's width: boxes span whole candles. */
  halfBar: number;
  width: number;
  height: number;
}

/**
 * Boxes for the given zone stores: off-screen ones skipped, at most `cap` drawn (the most recently formed win),
 * returned oldest first so newer boxes paint on top.
 */
export function zoneRects(stores: readonly ZoneStore[], view: ZoneViewport, cap = MAX_DRAWN_ZONES): ZoneRect[] {
  const out: ZoneRect[] = [];
  for (const store of stores) {
    for (const z of store.zones()) {
      const end = z.endTime ?? Math.max(view.lastTime, z.knownTime);
      const xs = view.timeToX(z.startTime);
      const xe = view.timeToX(end);
      if (xs === null || xe === null) continue;
      const x1 = Math.min(xs, xe) - view.halfBar;
      const x2 = Math.max(xs, xe) + view.halfBar;
      if (x2 < 0 || x1 > view.width) continue;
      const yt = view.priceToY(z.top);
      const yb = view.priceToY(z.bottom);
      if (yt === null || yb === null || !Number.isFinite(yt) || !Number.isFinite(yb)) continue;
      const y1 = Math.min(yt, yb);
      const y2 = Math.max(yt, yb);
      if (y2 < 0 || y1 > view.height) continue;
      out.push({ x1, x2, y1, y2, style: store.style, kind: z.kind, ended: z.endTime !== null, label: z.label, id: z.id, knownTime: z.knownTime });
    }
  }
  out.sort((a, b) => b.knownTime - a.knownTime || b.id - a.id);
  return out.slice(0, cap).reverse();
}

/** Fill / stroke colours: order blocks green / red, FVGs lime / orange, swing levels as lines. */
export function zoneColors(style: ZoneStyle, kind: ZoneEvent['kind'], ended: boolean): { fill: string; stroke: string; text: string } {
  const rgb = style === 'fvg'
    ? kind === 'bullish' ? '139, 195, 74' : '255, 152, 0'
    : kind === 'bullish' ? '38, 166, 154' : '239, 83, 80';
  const [fa, sa] = ended ? [0.06, 0.3] : [style === 'fvg' ? 0.16 : 0.2, 0.85];
  return { fill: `rgba(${rgb}, ${fa})`, stroke: `rgba(${rgb}, ${sa})`, text: `rgba(${rgb}, ${ended ? 0.45 : 0.95})` };
}
