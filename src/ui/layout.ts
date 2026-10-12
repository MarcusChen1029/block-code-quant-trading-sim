import { FIELD_TEXT, TAB_TEXT } from './descriptions';
import { h } from './dom';
import { setExplain } from './explain';
import { clampFraction, fractionForKey, fractionFromPointer, fractionRange, SPLIT } from './splitter';

export type PaneId = 'left' | 'right';
export type LeftTab = 'blocks' | 'pine';

/**
 * Two-pane layout: strategy editor on the left (tabs Blocks | Pine), chart + stats on the right. Below 900px
 * wide only one pane shows at a time and a switcher picks which (CSS does the hiding via body[data-pane];
 * the left tab via body[data-left-tab]). `onPaneShown` / `onTabShown` let the caller resize hidden canvases.
 */
export function setupLayout(
  switcher: HTMLElement,
  leftTabs: HTMLElement,
  onPaneShown: (pane: PaneId) => void,
  initialTab: LeftTab = 'blocks',
  onTabShown: (tab: LeftTab) => void = () => {},
): void {
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
  switcher.append(paneButton('left', 'Strategy'), paneButton('right', 'Chart & results'));

  const tabs: Array<[LeftTab, HTMLButtonElement]> = [
    ['blocks', h('button', { type: 'button', role: 'tab', 'data-tip': TAB_TEXT.blocks.on }, 'Blocks')],
    ['pine', h('button', { type: 'button', role: 'tab', 'data-tip': TAB_TEXT.pine.on }, 'Pine (advanced)')],
  ];
  for (const [id, b] of tabs) setExplain(b, TAB_TEXT[id].title, TAB_TEXT[id].on);
  const showTab = (tab: LeftTab) => {
    document.body.dataset.leftTab = tab;
    for (const [id, b] of tabs) {
      b.classList.toggle('active', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
    }
    requestAnimationFrame(() => onTabShown(tab));
  };
  for (const [id, b] of tabs) b.addEventListener('click', () => showTab(id));
  // Only the tabs live inside the tablist; other buttons of the row (Fit) sit beside it.
  leftTabs.append(h('div', { class: 'tab-list', role: 'tablist', 'aria-label': 'Strategy views' }, ...tabs.map(([, b]) => b)));
  showTab(initialTab);
  show('left');
}

/**
 * Draggable splitter between the strategy pane and the chart pane (wide layouts only; CSS hides it below 900px,
 * where the pane switcher applies as before). Keyboard: arrows (Shift = bigger steps), PageUp/PageDown, Home/End,
 * Enter resets; double-click resets. The fraction is applied as --left-width and saved via `save` after a change.
 */
export function setupSplitter(
  layout: HTMLElement,
  splitter: HTMLElement,
  initial: number | null,
  save: (fraction: number) => void,
  onResize: () => void = () => {},
): { readonly fraction: number; reset(): void } {
  let fraction = initial ?? SPLIT.defaultFraction;
  splitter.setAttribute('role', 'separator');
  splitter.setAttribute('aria-orientation', 'vertical');
  splitter.setAttribute('aria-controls', 'left');
  splitter.setAttribute('aria-label', 'Resize the strategy pane (arrow keys; double-click or Enter resets)');
  splitter.setAttribute('title', 'Drag to resize; double-click to reset');
  splitter.tabIndex = 0;

  /** Shows `f` (clamped to the current width); the stored preference stays as chosen. */
  const apply = (f: number) => {
    const width = layout.clientWidth;
    const shown = width > 0 ? clampFraction(f, width) : f;
    const { min, max } = fractionRange(width);
    layout.style.setProperty('--left-width', `${(shown * 100).toFixed(2)}%`);
    splitter.setAttribute('aria-valuenow', String(Math.round(shown * 100)));
    splitter.setAttribute('aria-valuemin', String(Math.round(min * 100)));
    splitter.setAttribute('aria-valuemax', String(Math.round(max * 100)));
    onResize();
  };
  const set = (f: number) => {
    fraction = f;
    apply(f);
    save(f);
  };

  let dragging = false;
  splitter.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    splitter.setPointerCapture(ev.pointerId);
    splitter.classList.add('dragging');
    document.body.classList.add('resizing');
    ev.preventDefault();
  });
  splitter.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const r = layout.getBoundingClientRect();
    fraction = fractionFromPointer(ev.clientX, r.left, r.width);
    apply(fraction);
  });
  const end = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (splitter.hasPointerCapture(ev.pointerId)) splitter.releasePointerCapture(ev.pointerId);
    splitter.classList.remove('dragging');
    document.body.classList.remove('resizing');
    save(fraction);
  };
  splitter.addEventListener('pointerup', end);
  splitter.addEventListener('pointercancel', end);
  splitter.addEventListener('dblclick', () => set(SPLIT.defaultFraction));
  splitter.addEventListener('keydown', (ev) => {
    const next = fractionForKey(clampFraction(fraction, layout.clientWidth), ev.key, ev.shiftKey, layout.clientWidth);
    if (next === null) return;
    ev.preventDefault();
    set(next);
  });
  window.addEventListener('resize', () => apply(fraction));
  apply(fraction);
  return { get fraction() { return fraction; }, reset: () => set(SPLIT.defaultFraction) };
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
export function createStrategyPicker(container: HTMLElement, initial: string, onChange: (id: string) => void): { set(id: string): void } {
  const select = h(
    'select', { name: 'strategy' },
    h('option', { value: 'blocks' }, 'My blocks (the Strategy panel)'),
    h('option', { value: 'smaCross' }, 'Built-in example: SMA cross'),
  );
  select.value = initial;
  const explainChoice = () => setExplain(select, 'Strategy to test',
    select.value === 'smaCross' ? 'Run will now test the built-in example robot (buy when a fast average crosses above a slow one). Your blocks are not touched.' : 'Run will now test the blocks you built in the Strategy panel.');
  explainChoice();
  select.addEventListener('change', () => { explainChoice(); onChange(select.value); });
  container.append(h('label', { class: 'strategy-picker', 'data-tip': FIELD_TEXT.strategy }, h('span', { class: 'field-label' }, 'Strategy to test'), select));
  return { set: (id) => { select.value = id; } };
}
