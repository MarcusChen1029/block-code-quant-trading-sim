import { h } from './dom';

export type PaneId = 'left' | 'right';

/**
 * Two-pane layout: strategy editor on the left (tabs Blocks | Pine), chart + stats on the right. Below 900px
 * wide only one pane shows at a time and a switcher picks which (CSS does the hiding via body[data-pane]).
 * `onPaneShown` lets the caller resize canvases that were hidden.
 */
export function setupLayout(switcher: HTMLElement, leftTabs: HTMLElement, onPaneShown: (pane: PaneId) => void): void {
  const show = (pane: PaneId) => {
    document.body.dataset.pane = pane;
    for (const b of switcher.querySelectorAll('button')) b.classList.toggle('active', b.dataset.pane === pane);
    requestAnimationFrame(() => onPaneShown(pane));
  };
  const paneButton = (pane: PaneId, label: string) => {
    const b = h('button', { type: 'button', 'data-pane': pane }, label);
    b.addEventListener('click', () => show(pane));
    return b;
  };
  switcher.append(paneButton('left', 'Strategy'), paneButton('right', 'Chart & stats'));

  leftTabs.append(
    h('button', { type: 'button', class: 'active', 'aria-selected': 'true' }, 'Blocks'),
    h('button', { type: 'button', disabled: '', title: 'Pine Script editor: coming soon' }, 'Pine (coming soon)'),
  );
  show('left');
}

export interface ProblemsView {
  show(errors: ReadonlyArray<{ message: string; blockId?: string }>, warnings: ReadonlyArray<{ message: string; blockId?: string }>): void;
}

/** Compile errors and warnings under the workspace; clicking one with a block focuses that block. */
export function createProblemsView(container: HTMLElement, onPick: (blockId: string, message: string) => void): ProblemsView {
  return {
    show(errors, warnings) {
      const row = (level: 'error' | 'warn', issue: { message: string; blockId?: string }) => {
        const el = h('li', { class: `problem problem-${level}`, title: issue.blockId ? 'Show the block' : undefined }, `${level === 'error' ? '✖' : '⚠'} ${issue.message}`);
        if (issue.blockId) {
          const id = issue.blockId;
          el.classList.add('clickable');
          el.addEventListener('click', () => onPick(id, issue.message));
        }
        return el;
      };
      container.replaceChildren(...errors.map((e) => row('error', e)), ...warnings.map((w) => row('warn', w)));
      container.hidden = errors.length + warnings.length === 0;
    },
  };
}

/** "Strategy: [Blocks | Example: SMA cross]" select for the top bar. */
export function createStrategyPicker(container: HTMLElement, initial: string, onChange: (id: string) => void): void {
  const select = h(
    'select', { name: 'strategy' },
    h('option', { value: 'blocks' }, 'Blocks (left pane)'),
    h('option', { value: 'smaCross' }, 'Example: SMA cross (built-in)'),
  );
  select.value = initial;
  select.addEventListener('change', () => onChange(select.value));
  container.append(h('label', { class: 'strategy-picker' }, 'Strategy ', select));
}
