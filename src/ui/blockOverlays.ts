import type { IndicatorUse } from '../blocks/generator';
import { priceOf } from '../blocks/priceSource';
import { getIndicator } from '../blocks/registry';
import type { OverlayDef } from './overlays';

const COLORS = ['#f5c542', '#42a5f5', '#ef5350', '#26a69a', '#ab47bc', '#ff9800', '#8d6e63', '#ec407a'];

/**
 * Chart overlays for the indicators a block strategy uses: drawn automatically (no picker), one per distinct
 * indicator + parameters + source. Indicators fed by a computed series (e.g. SMA of RSI) are not drawn.
 */
export function blockIndicatorOverlays(uses: readonly IndicatorUse[]): OverlayDef[] {
  const out: OverlayDef[] = [];
  const seen = new Set<string>();
  let colorCursor = 0;
  for (const use of uses) {
    const def = getIndicator(use.indicatorId);
    if (!def || !use.drawable) continue;
    const values = def.params.map((p) => use.params[p.name]);
    const key = `${def.id}(${values.join(',')})${use.source ? `@${use.source}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = use.source;
    const label = [def.label, ...values, ...(source && source !== def.source ? [source] : [])].join(' ');
    out.push({
      id: `block-${key}`,
      label,
      pane: def.pane,
      lines: def.outputs.map((o) => ({ key: o.key, color: COLORS[colorCursor++ % COLORS.length] })),
      create() {
        const instance = def.create(use.params);
        return (candle) => instance.step(source ? priceOf(candle, source) : NaN, candle);
      },
    });
  }
  return out;
}
