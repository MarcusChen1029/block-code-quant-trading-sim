import { overlayBlurb } from './descriptions';
import { h } from './dom';
import { icon } from './icons';
import { setExplain } from './explain';
import type { OverlayDef } from './overlays';
import { createPopover } from './popover';

/** Badge on the "Chart overlays" button: "3 on", or nothing when none is on. */
export function overlayBadge(count: number): string {
  return count > 0 ? `${count} on` : '';
}

/** Where an overlay is drawn, in words a beginner understands. */
export function overlayGroupTitle(pane: OverlayDef['pane']): string {
  return pane === 'price' ? 'Drawn on the price' : 'In a box under the chart';
}

/**
 * "Chart overlays" button with a count badge; its popover holds one checkbox per overlay, each with a one-line
 * explanation. Calls onChange with the checked ids (same contract as the old row of checkboxes, so persistence is
 * unchanged).
 */
export function renderOverlayPicker(
  container: HTMLElement,
  defs: readonly OverlayDef[],
  initial: readonly string[],
  onChange: (ids: string[]) => void,
): void {
  const pop = createPopover('Chart overlays', 'Extra helper lines on the chart. They only decorate the chart: they never change what your robot does.', 'Chart overlays', 'overlay-picker');
  pop.button.prepend(icon('chart', 16));
  const boxes: HTMLInputElement[] = [];
  const update = () => pop.setBadge(overlayBadge(boxes.filter((b) => b.checked).length));
  let lastPane: OverlayDef['pane'] | null = null;
  // Lines on the price first, then the ones that get their own box (the picker's input order is not the display order).
  for (const def of [...defs.filter((d) => d.pane === 'price'), ...defs.filter((d) => d.pane !== 'price')]) {
    if (def.pane !== lastPane) {
      pop.panel.append(h('div', { class: 'overlay-group' }, overlayGroupTitle(def.pane)));
      lastPane = def.pane;
    }
    const box = h('input', { type: 'checkbox', value: def.id });
    box.checked = initial.includes(def.id);
    const blurb = overlayBlurb(def.id, def.label);
    setExplain(box, def.label, `${def.label} is now drawn on the chart. ${blurb}`, `${def.label} is hidden again.`);
    box.addEventListener('change', () => {
      update();
      onChange(boxes.filter((b) => b.checked).map((b) => b.value));
    });
    boxes.push(box);
    pop.panel.append(h('label', {}, box, h('span', {}, h('span', { class: 'overlay-name' }, def.label), h('span', { class: 'overlay-desc' }, blurb))));
  }
  update();
  container.append(pop.root);
}
