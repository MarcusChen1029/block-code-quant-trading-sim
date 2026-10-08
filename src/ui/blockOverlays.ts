import type { IndicatorUse } from '../blocks/generator';
import { priceOf } from '../blocks/priceSource';
import type { Candle } from '../data/types';
import { getIndicator, PINE_ID_PREFIX, type IndicatorBlockDef } from '../blocks/registry';
import { signalPriceKey, type OverlayDef, type OverlaySignal } from './overlays';

const COLORS = ['#f5c542', '#42a5f5', '#ef5350', '#26a69a', '#ab47bc', '#ff9800', '#8d6e63', '#ec407a'];

interface Group {
  def: IndicatorBlockDef;
  key: string;
  /** Params the instance is created with (numeric params + any signal-only ones of a signal use). */
  params: Record<string, number>;
  /** Signal-only params were fixed by a signal use (another signal use with other levels gets its own group). */
  signalParams: string | null;
  source: IndicatorUse['source'];
  signals: string[];
}

/**
 * Chart overlays for the indicators a block strategy uses: drawn automatically (no picker), one per distinct
 * indicator + parameters + source. Numeric and signal blocks of the same settings share one overlay, which marks
 * the signals used. Indicators fed by a computed series (e.g. SMA of RSI) are not drawn.
 */
export function blockIndicatorOverlays(
  uses: readonly IndicatorUse[],
  /** Where definitions come from: the page registry by default; live sessions pass their own snapshot's. */
  resolve: (id: string) => IndicatorBlockDef | undefined = getIndicator,
): OverlayDef[] {
  const groups: Group[] = [];
  for (const use of uses) {
    const def = resolve(use.indicatorId);
    if (!def || !use.drawable) continue;
    const numeric = def.params.filter((p) => !p.signalOnly);
    const key = `${def.id}(${numeric.map((p) => use.params[p.name]).join(',')})${use.source ? `@${use.source}` : ''}`;
    const so = def.params.filter((p) => p.signalOnly && use.params[p.name] !== undefined);
    const signalParams = use.signals && so.length > 0 ? so.map((p) => use.params[p.name]).join(',') : null;
    let group = groups.find((g) => g.key === key && (signalParams === null || g.signalParams === null || g.signalParams === signalParams));
    if (group && signalParams !== null && group.signalParams === null) {
      group.signalParams = signalParams;
      group.params = { ...group.params, ...use.params };
    }
    if (!group) {
      group = { def, key, params: { ...use.params }, signalParams, source: use.source, signals: [] };
      groups.push(group);
    }
    for (const s of use.signals ?? []) if (!group.signals.includes(s)) group.signals.push(s);
  }

  const out: OverlayDef[] = [];
  let colorCursor = 0;
  const seenIds = new Set<string>();
  for (const g of groups) {
    const { def, source } = g;
    const values = def.params.filter((p) => !p.signalOnly).map((p) => g.params[p.name]);
    const label = [def.label, ...values, ...(source && source !== def.source ? [source] : [])].join(' ');
    let id = `block-${g.key}`;
    for (let n = 2; seenIds.has(id); n++) id = `block-${g.key}#${n}`;
    seenIds.add(id);
    const signals: OverlaySignal[] = (def.signals ?? [])
      // A signal without a marker is hidden in its script (display.none / transparent): usable, never drawn.
      .filter((s) => g.signals.includes(s.key) && s.marker !== undefined)
      .map((s) => ({
        key: s.key,
        label: `${label}: ${s.label}`,
        marker: { shape: 'circle', location: 'aboveBar', ...s.marker, text: s.marker?.text ?? s.label },
      }));
    const params = g.params;
    out.push({
      id,
      label,
      indicatorId: def.id,
      pane: def.pane,
      // Zone indicators are drawn as boxes / levels; their numeric outputs (nearest zone edges) are not drawn as lines.
      // Pine plots are named by their plot titles ("Up trend"); built-ins keep their short keys ("macd", "hist").
      lines: def.zones ? [] : def.outputs.map((o) => ({
        key: o.key,
        color: COLORS[colorCursor++ % COLORS.length],
        ...(def.id.startsWith(PINE_ID_PREFIX) ? { title: o.label } : {}),
      })),
      ...(signals.length > 0 ? { signals } : {}),
      ...(def.zones ? { zones: def.zones.style, zoneKey: g.key } : {}),
      signalKey: `${g.key}|${g.signalParams ?? ''}`,
      create() {
        // A Pine script can throw (bad parameter, loop budget): the chart then shows gaps instead of breaking.
        const gap = () => Object.fromEntries([...def.outputs.map((o) => [o.key, NaN]), ...signals.map((s) => [s.key, 0])]);
        let instance: ReturnType<typeof def.create> | null = null;
        try {
          instance = def.create(params);
        } catch {
          return gap;
        }
        const step = (candle: Candle) => {
          if (!instance) return gap();
          try {
            const result = instance.step(source ? priceOf(candle, source) : NaN, candle);
            for (const s of signals) {
              if (s.marker.location === 'price' && result[s.key] === 1) result[signalPriceKey(s.key)] = instance.markerPrice?.(s.key) ?? NaN;
            }
            return result;
          } catch {
            instance = null;
            return gap();
          }
        };
        return def.zones ? Object.assign(step, { zones: () => instance?.zones?.() ?? [] }) : step;
      },
    });
  }
  return out;
}

/**
 * Overlays of a live session's chart: its own (from its snapshot) plus the extra ones (picked, "Show on chart").
 * A signal (indicator id + signal key) the session already marks is dropped from the extras, so no marker is drawn
 * twice; an extra overlay identical to a session one with nothing left to mark is dropped entirely.
 */
export function liveSessionOverlays(session: readonly OverlayDef[], extra: readonly OverlayDef[]): OverlayDef[] {
  const marked = new Set(session.flatMap((d) => (d.signals ?? []).map((s) => `${d.indicatorId}|${s.key}`)));
  const ids = new Set(session.map((d) => d.id));
  const out: OverlayDef[] = [...session];
  for (const d of extra) {
    if (d.indicatorId === undefined || !d.signals) {
      out.push(d);
      continue;
    }
    const signals = d.signals.filter((s) => !marked.has(`${d.indicatorId}|${s.key}`));
    if (signals.length === d.signals.length) out.push(d);
    else if (signals.length > 0) out.push({ ...d, signals });
    else if (!ids.has(d.id)) {
      const { signals: _drop, ...lines } = d;
      out.push(lines);
    }
  }
  return out;
}

/** The zone indicators offered as top-bar "show on chart" toggles, in this order, with these labels. */
export const ZONE_TOGGLES: ReadonlyArray<readonly [id: string, label: string]> = [
  ['orderblock', 'Order blocks'],
  ['fvg', 'FVG'],
  ['swing', 'Swing structure'],
];

/**
 * Picker overlays for the zone indicators with default settings (ids `zones-<id>`): their zones, plus the signals
 * that have markers (swing structure: break of structure arrows). Zones identical to a strategy's are drawn once.
 */
export function zoneToggleOverlays(resolve: (id: string) => IndicatorBlockDef | undefined = getIndicator): OverlayDef[] {
  return ZONE_TOGGLES.flatMap(([id, label]) => {
    const def = resolve(id);
    if (!def) return [];
    const [overlay] = blockIndicatorOverlays([defaultIndicatorUse(def)], resolve);
    return overlay ? [{ ...overlay, id: `zones-${id}`, label }] : [];
  });
}

/**
 * An indicator drawn with its default settings and ALL its signals (the Pine tab's "Show on chart"): fed with
 * the closes / its default source like a block whose SOURCE is a plain bar value.
 */
export function defaultIndicatorUse(def: IndicatorBlockDef): IndicatorUse {
  return {
    indicatorId: def.id,
    params: Object.fromEntries(def.params.map((p) => [p.name, p.default])),
    source: def.source ?? null,
    drawable: true,
    blockId: `show:${def.id}`,
    signals: (def.signals ?? []).map((s) => s.key),
  };
}
