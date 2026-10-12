import { h } from './dom';
import { icon } from './icons';
import { infoButton, tip } from './tooltip';
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
  const paneButton = (pane: PaneId, label: string, ic: 'blocks' | 'chart') => {
    const b = h('button', { type: 'button', 'data-pane': pane }, icon(ic), h('span', {}, label));
    b.addEventListener('click', () => show(pane));
    return b;
  };
  switcher.append(paneButton('left', 'Strategy', 'blocks'), paneButton('right', 'Chart & results', 'chart'));

  const tabs: Array<[LeftTab, HTMLButtonElement]> = [
    ['blocks', tip(h('button', { type: 'button', role: 'tab' }, icon('blocks', 14), h('span', {}, 'Blocks')),
      'Build your strategy by snapping blocks together. Pick a category on the left, then drag a block onto the workspace.', 'Blocks')],
    ['pine', tip(h('button', { type: 'button', role: 'tab' }, icon('file', 14), h('span', {}, 'Pine code')),
      'For coders: write or paste a TradingView Pine Script indicator. Once it compiles it becomes a new block in the “Pine” category.', 'Pine code')],
  ];
  const showTab = (tab: LeftTab) => {
    document.body.dataset.leftTab = tab;
    for (const [id, b] of tabs) {
      b.classList.toggle('active', id === tab);
      b.setAttribute('aria-selected', String(id === tab));
      b.tabIndex = id === tab ? 0 : -1; // one tab stop; arrow keys move between tabs
    }
    requestAnimationFrame(() => onTabShown(tab));
  };
  for (const [id, b] of tabs) b.addEventListener('click', () => showTab(id));
  for (const [id, b] of tabs) {
    b.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const at = tabs.findIndex(([t]) => t === id);
      const [next, nb] = tabs[(at + (ev.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      showTab(next);
      nb.focus();
    });
  }
  // The tab list holds only the tabs (the Fit button sits next to it, in leftTabs).
  leftTabs.append(h('div', { class: 'tablist', role: 'tablist', 'aria-label': 'Strategy editor' }, ...tabs.map(([, b]) => b)));
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
): { readonly fraction: number } {
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
  return { get fraction() { return fraction; } };
}

export interface ProblemsView {
  show(errors: ReadonlyArray<{ message: string; blockId?: string }>, warnings: ReadonlyArray<{ message: string; blockId?: string }>): void;
}

/** Compile errors and warnings under the workspace; clicking one with a block focuses that block. */
export function createProblemsView(container: HTMLElement, onPick: (blockId: string, message: string) => void): ProblemsView {
  return {
    show(errors, warnings) {
      const row = (level: 'error' | 'warn', issue: { message: string; blockId?: string }) => {
        const el = h('li', { class: `problem problem-${level}`, title: issue.blockId ? 'Click to show the block with this problem' : undefined }, `${level === 'error' ? '✖' : '⚠'} ${issue.message}`);
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
    h('option', { value: 'blocks' }, 'My blocks (left panel)'),
    h('option', { value: 'smaCross' }, 'Built-in example: SMA cross'),
  );
  select.value = initial;
  select.addEventListener('change', () => onChange(select.value));
  container.append(h('label', { class: 'field strategy-picker' },
    h('span', { class: 'field-label' }, 'Strategy to test', infoButton('What Run test uses: the blocks in the left panel (normal), or a fixed built-in example that buys when the 10-candle average crosses above the 30-candle average.', 'What is “Strategy to test”?')),
    select));
  return { set: (id) => { select.value = id; } };
}

/** Height limits for the results panel: at least `min`, and the chart keeps at least `chartMin`. */
export function clampResultsHeight(px: number, available: number, min = 150, chartMin = 200): number {
  const max = Math.max(min, available - chartMin);
  return Math.round(Math.min(max, Math.max(min, px)));
}

/**
 * Drag handle between the chart and the results panel (wide layouts; CSS hides it on phones). Sets
 * --results-height on `main`. Keyboard: up / down arrows (Shift = bigger steps); double-click or Enter resets.
 */
export function setupRowSplitter(
  main: HTMLElement,
  handle: HTMLElement,
  initial: number | null,
  save: (px: number | null) => void,
): void {
  let height: number | null = initial;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'horizontal');
  handle.setAttribute('aria-controls', 'results-panel');
  handle.setAttribute('aria-label', 'Resize the results panel (up and down arrow keys; Enter resets)');
  handle.dataset.tip = 'Drag up or down to give the chart or the results more room. Double-click to reset.';
  handle.tabIndex = 0;
  const apply = () => {
    if (height === null) main.style.removeProperty('--results-height');
    else main.style.setProperty('--results-height', `${clampResultsHeight(height, main.clientHeight)}px`);
    // A focusable separator reports its position: the results height in pixels.
    handle.setAttribute('aria-valuemin', '150');
    handle.setAttribute('aria-valuemax', String(Math.max(150, main.clientHeight - 200)));
    handle.setAttribute('aria-valuenow', String(Math.round(document.getElementById('results-panel')?.getBoundingClientRect().height ?? 0)));
  };
  let dragging = false;
  let startY = 0;
  let startH = 0;
  const results = () => document.getElementById('results-panel')!;
  handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    startY = ev.clientY;
    startH = results().getBoundingClientRect().height;
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add('dragging');
    document.body.classList.add('resizing-rows');
    ev.preventDefault();
  });
  handle.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    height = clampResultsHeight(startH + (startY - ev.clientY), main.clientHeight);
    apply();
  });
  const end = (ev: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (handle.hasPointerCapture(ev.pointerId)) handle.releasePointerCapture(ev.pointerId);
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-rows');
    save(height);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  const reset = () => {
    height = null;
    apply();
    save(null);
  };
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      reset();
      return;
    }
    const step = ev.shiftKey ? 80 : 20;
    const delta = ev.key === 'ArrowUp' ? step : ev.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    ev.preventDefault();
    height = clampResultsHeight((height ?? results().getBoundingClientRect().height) + delta, main.clientHeight);
    apply();
    save(height);
  });
  window.addEventListener('resize', apply);
  apply();
}
