import { h } from './dom';
import type { OverlayDef } from './overlays';
import { createPopover } from './popover';

/** Badge on the "Chart overlays" button: "3 on", or nothing when none is on. */
export function overlayBadge(count: number): string {
  return count > 0 ? `${count} on` : '';
}

/**
 * "Chart overlays" button with a count badge; its popover holds one checkbox per overlay. Calls onChange with the
 * checked ids (same contract as the old row of checkboxes, so persistence is unchanged).
 */
export function renderOverlayPicker(
  container: HTMLElement,
  defs: readonly OverlayDef[],
  initial: readonly string[],
  onChange: (ids: string[]) => void,
): void {
  const pop = createPopover('Chart overlays', 'Extra indicators drawn on the chart (they do not change the strategy)', 'Chart overlays', 'overlay-picker');
  const boxes: HTMLInputElement[] = [];
  const update = () => pop.setBadge(overlayBadge(boxes.filter((b) => b.checked).length));
  for (const def of defs) {
    const box = h('input', { type: 'checkbox', value: def.id });
    box.checked = initial.includes(def.id);
    box.addEventListener('change', () => {
      update();
      onChange(boxes.filter((b) => b.checked).map((b) => b.value));
    });
    boxes.push(box);
    pop.panel.append(h('label', {}, box, def.label));
  }
  update();
  container.append(pop.root);
}
