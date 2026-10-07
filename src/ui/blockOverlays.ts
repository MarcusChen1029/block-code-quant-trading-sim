import type { IndicatorUse } from '../blocks/generator';
import { priceOf } from '../blocks/priceSource';
import { getIndicator, type IndicatorBlockDef } from '../blocks/registry';
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
      pane: def.pane,
      lines: def.outputs.map((o) => ({ key: o.key, color: COLORS[colorCursor++ % COLORS.length] })),
      ...(signals.length > 0 ? { signals } : {}),
      create() {
        // A Pine script can throw (bad parameter, loop budget): the chart then shows gaps instead of breaking.
        const gap = () => Object.fromEntries([...def.outputs.map((o) => [o.key, NaN]), ...signals.map((s) => [s.key, 0])]);
        let instance: ReturnType<typeof def.create> | null = null;
        try {
          instance = def.create(params);
        } catch {
          return gap;
        }
        return (candle) => {
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
      },
    });
  }
  return out;
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
