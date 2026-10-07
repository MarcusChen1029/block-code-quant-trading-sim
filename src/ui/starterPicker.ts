import type { StarterDef } from '../blocks/starters';
import { h } from './dom';
import { fmtTime } from './format';
import { createPopover } from './popover';
import type { PreviousWorkspace } from './starterMemory';

/**
 * "Start from…" menu: every starter with its one-line description, then "Restore previous workspace" (the blocks
 * that were showing before the last replacement; disabled when there are none).
 */
export function createStarterPicker(
  container: HTMLElement,
  starters: readonly StarterDef[],
  handlers: { onPick(id: StarterDef['id']): void; onRestore(): void; previous(): PreviousWorkspace | null },
): void {
  const pop = createPopover('Start from…', 'Load a ready-made strategy into the Blocks pane (your current blocks are kept as "previous")', 'Starter strategies', 'starter-picker');
  const item = (label: string, description: string, onClick: () => void) => {
    const b = h('button', { type: 'button', class: 'starter-item' }, h('span', { class: 'starter-label' }, label), h('span', { class: 'starter-desc' }, description));
    b.addEventListener('click', () => {
      pop.close();
      onClick();
    });
    return b;
  };
  for (const s of starters) pop.panel.append(item(s.label, s.description, () => handlers.onPick(s.id)));
  const restoreDesc = h('span', { class: 'starter-desc' });
  const restore = h('button', { type: 'button', class: 'starter-item starter-restore' }, h('span', { class: 'starter-label' }, '↶ Restore previous workspace'), restoreDesc);
  restore.addEventListener('click', () => {
    pop.close();
    handlers.onRestore();
  });
  pop.panel.append(h('div', { class: 'starter-sep', role: 'separator' }), restore);

  const refresh = () => {
    const prev = handlers.previous();
    restore.disabled = prev === null;
    restoreDesc.textContent = prev ? `The blocks you had before the last starter was loaded (saved ${fmtTime(prev.savedAt)} UTC). They swap places with the current blocks.` : 'Nothing saved yet: loading a starter keeps your current blocks here.';
  };
  pop.button.addEventListener('click', refresh);
  refresh();
  container.append(pop.root);
}
