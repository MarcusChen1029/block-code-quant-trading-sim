import { h } from './dom';
import { icon, type IconName } from './icons';
import { exitFull, parsePanelState, toggleCollapsed, toggleFull, type PanelId, type PanelState } from './panelState';
import { loadJson, saveJson } from './storage';
import { infoButton, tip } from './tooltip';

export const PANELS_STORAGE_KEY = 'quant-sim.panels.v1';

export interface PanelSpec {
  id: PanelId;
  /** The <section> the header goes into (as its first child). */
  el: HTMLElement;
  step: string;
  title: string;
  icon: IconName;
  /** What the panel is for, in plain words (the "?" button next to the title). */
  description: string;
}

export interface Panels {
  readonly state: PanelState;
  toggle(id: PanelId): void;
  full(id: PanelId): void;
  exitFull(): void;
  reset(): void;
  /** Extra buttons in a panel's header, left of hide / full page. */
  actions(id: PanelId): HTMLElement;
}

const NAMES: Record<PanelId, string> = { strategy: 'strategy', chart: 'chart', results: 'results' };

/**
 * Header bar for each work area (step number, title, "?" description, extra actions, full page, hide) and the
 * layout state behind it. CSS does the layout from body[data-collapsed] (space-separated panel ids) and
 * body[data-full]. Hidden panels are remembered; full page is not. Escape leaves full page.
 * `onLayout` runs after every change (canvases that do not resize themselves).
 */
export function setupPanels(specs: readonly PanelSpec[], onLayout: () => void): Panels {
  let state = parsePanelState(loadJson(PANELS_STORAGE_KEY));
  const buttons = new Map<PanelId, { hide: HTMLButtonElement; full: HTMLButtonElement; head: HTMLElement }>();
  const actionSlots = new Map<PanelId, HTMLElement>();

  const render = () => {
    document.body.dataset.collapsed = state.collapsed.join(' ');
    if (state.full) document.body.dataset.full = state.full;
    else delete document.body.dataset.full;
    for (const [id, { hide, full, head }] of buttons) {
      const collapsed = state.collapsed.includes(id);
      const isFull = state.full === id;
      const name = NAMES[id];
      hide.replaceChildren(icon(collapsed ? (id === 'strategy' ? 'chevronRight' : 'chevronDown') : (id === 'strategy' ? 'chevronLeft' : 'chevronUp')));
      hide.setAttribute('aria-expanded', String(!collapsed));
      hide.setAttribute('aria-label', collapsed ? `Show the ${name} panel` : `Hide the ${name} panel`);
      tip(hide, collapsed ? `Show the ${name} panel again.` : `Hide the ${name} panel to make more room for the others. Click again to bring it back.`);
      full.replaceChildren(icon(isFull ? 'shrink' : 'expand'), ...(isFull ? [h('span', { class: 'full-label' }, 'Exit full page')] : []));
      full.setAttribute('aria-pressed', String(isFull));
      full.setAttribute('aria-label', isFull ? 'Leave full page' : `Show the ${name} panel full page`);
      tip(full, isFull ? 'Go back to the normal layout (or press Esc).' : `Make the ${name} panel fill the whole page. Press Esc to come back.`);
      head.classList.toggle('is-collapsed', collapsed);
    }
    saveJson(PANELS_STORAGE_KEY, { collapsed: state.collapsed });
    requestAnimationFrame(onLayout);
    setTimeout(onLayout, 220); // after the CSS transition
  };

  const set = (next: PanelState) => {
    const wasFull = state.full;
    state = next;
    render();
    if (state.full) buttons.get(state.full)?.full.focus();
    else if (wasFull) buttons.get(wasFull)?.full.focus();
  };

  for (const spec of specs) {
    const hide = h('button', { type: 'button', class: 'icon-btn panel-hide' });
    const full = h('button', { type: 'button', class: 'icon-btn panel-full' });
    hide.addEventListener('click', (ev) => {
      ev.stopPropagation();
      set(toggleCollapsed(state, spec.id));
    });
    full.addEventListener('click', () => set(toggleFull(state, spec.id)));
    const actions = h('div', { class: 'panel-actions' });
    actionSlots.set(spec.id, actions);
    const titleId = spec.el.getAttribute('aria-labelledby') ?? `${spec.id}-title`;
    const head = h(
      'div', { class: 'panel-head' },
      h('span', { class: 'panel-step', 'aria-hidden': 'true' }, spec.step),
      h('span', { class: 'panel-icon', 'aria-hidden': 'true' }, icon(spec.icon)),
      h('h2', { class: 'panel-title', id: titleId }, spec.title),
      infoButton(spec.description, `What is the ${NAMES[spec.id]} panel?`, spec.title),
      h('div', { class: 'panel-spacer' }),
      actions,
      full,
      hide,
    );
    // A folded panel opens again from anywhere on its header (the strategy strip is mostly header).
    head.addEventListener('click', (ev) => {
      if (state.collapsed.includes(spec.id) && !(ev.target as Element).closest('button')) set(toggleCollapsed(state, spec.id));
    });
    spec.el.prepend(head);
    buttons.set(spec.id, { hide, full, head });
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !state.full || ev.defaultPrevented) return;
    if (document.querySelector('dialog[open], .pop-panel:not([hidden])')) return; // Escape closes those first
    set(exitFull(state));
  });
  render();

  return {
    get state() { return state; },
    toggle: (id) => set(toggleCollapsed(state, id)),
    full: (id) => set(toggleFull(state, id)),
    exitFull: () => set(exitFull(state)),
    reset: () => set({ collapsed: [], full: null }),
    actions: (id) => actionSlots.get(id)!,
  };
}
