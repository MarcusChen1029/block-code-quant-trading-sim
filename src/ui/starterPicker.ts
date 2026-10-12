import type { StarterDef } from '../blocks/starters';
import { h } from './dom';
import { icon } from './icons';
import { fmtTime } from './format';
import { createPopover } from './popover';
import { previousTitle } from './starterFlow';
import { MAX_PREVIOUS, type PreviousWorkspace } from './starterMemory';

/**
 * "Start from…" menu: every starter with its one-line description, then "Previous workspaces" (the last
 * MAX_PREVIOUS workspaces a starter replaced, most recent first), each with its own Restore.
 */
export function createStarterPicker(
  container: HTMLElement,
  starters: readonly StarterDef[],
  handlers: { onPick(id: StarterDef['id']): void; onRestore(id: string): void; previousList(): PreviousWorkspace[]; onSaveFile(): void; onOpenFile(): void },
): void {
  const pop = createPopover('Start from…', 'Load a ready-made strategy into the Blocks pane (your current blocks are kept under "Previous workspaces")', 'Starter strategies', 'starter-picker');
  pop.button.setAttribute('data-tour', 'starter');
  pop.button.prepend(icon('puzzle', 16));
  const item = (label: string, description: string, onClick: () => void, cls = '') => {
    const b = h('button', { type: 'button', class: `starter-item ${cls}` }, h('span', { class: 'starter-label' }, label), h('span', { class: 'starter-desc' }, description));
    b.addEventListener('click', () => {
      pop.close(true); // focus back on "Start from…", not <body>
      onClick();
    });
    return b;
  };
  pop.panel.append(h('div', { class: 'starter-heading' }, 'Ready-made robots'));
  for (const s of starters) pop.panel.append(item(s.label, s.description, () => handlers.onPick(s.id)));
  const fileButton = (label: string, iconName: string, tip: string, onClick: () => void) => {
    const b = h('button', { type: 'button', 'data-tip': tip }, icon(iconName, 14), label);
    b.addEventListener('click', () => { pop.close(true); onClick(); });
    return b;
  };
  pop.panel.append(
    h('div', { class: 'starter-sep', role: 'separator' }),
    h('div', { class: 'starter-heading' }, 'Your files'),
    h('div', { class: 'starter-files' },
      fileButton('Save blocks to a file', 'download', 'Saves your current blocks as a small file you can keep or send to a friend', handlers.onSaveFile),
      fileButton('Open a file', 'upload', 'Loads blocks from a file you saved before', handlers.onOpenFile)),
  );
  const previous = h('div', { class: 'starter-previous', role: 'group', 'aria-label': 'Previous workspaces' });
  pop.panel.append(h('div', { class: 'starter-sep', role: 'separator' }), h('div', { class: 'starter-heading' }, `Previous workspaces (last ${MAX_PREVIOUS})`), previous);

  const refresh = () => {
    const list = handlers.previousList();
    if (list.length === 0) {
      previous.replaceChildren(h('div', { class: 'starter-desc starter-empty' }, 'None yet: loading a starter keeps the blocks it replaces here.'));
      return;
    }
    previous.replaceChildren(...list.map((p) =>
      item(`↶ Restore: ${previousTitle(p)}`, `Saved ${fmtTime(p.savedAt)} UTC. The blocks showing now take its place in this list.`, () => handlers.onRestore(p.id), 'starter-restore')));
  };
  pop.button.addEventListener('click', refresh);
  refresh();
  container.append(pop.root);
}
