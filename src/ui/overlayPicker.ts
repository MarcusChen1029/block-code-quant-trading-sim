import { h } from './dom';
import type { OverlayDef } from './overlays';

/** Renders one checkbox per overlay into `container`; calls onChange with the checked ids. */
export function renderOverlayPicker(
  container: HTMLElement,
  defs: readonly OverlayDef[],
  initial: readonly string[],
  onChange: (ids: string[]) => void,
): void {
  const boxes: HTMLInputElement[] = [];
  const wrap = h('span', { class: 'overlay-picker' });
  for (const def of defs) {
    const box = h('input', { type: 'checkbox', value: def.id });
    box.checked = initial.includes(def.id);
    box.addEventListener('change', () => onChange(boxes.filter((b) => b.checked).map((b) => b.value)));
    boxes.push(box);
    wrap.append(h('label', {}, box, def.label));
  }
  container.append(wrap);
}
