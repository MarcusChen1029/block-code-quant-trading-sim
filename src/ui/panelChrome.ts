import { h } from './dom';
import { PANEL_BUTTON_TEXT, PANEL_TEXT } from './descriptions';
import { icon } from './icons';
import {
  canHide, exitFull, isFull, isHidden, parsePanelState, PANEL_IDS, showAll, storablePanels, toggleFull, toggleHidden,
  type PanelId, type PanelState,
} from './panels';
import { loadJson, saveJson } from './storage';
import { explain, toast } from './toast';

export const PANELS_STORAGE_KEY = 'quant-sim.panels.v1';

const ICONS: Record<PanelId, string> = { strategy: 'puzzle', chart: 'chart', results: 'list', live: 'radio' };
const SHORTCUT: Record<PanelId, string> = { strategy: '1', chart: '2', results: '3', live: '4' };

export interface PanelDef {
  id: PanelId;
  el: HTMLElement;
  /** Extra buttons placed in the header, left of Hide / Full page. */
  actions?: HTMLElement[];
}

export interface PanelChrome {
  readonly state: PanelState;
  hide(id: PanelId): void;
  full(id: PanelId): void;
  exitFull(): void;
  showAll(): void;
  /** Re-reads what the dock lists (the Live panel only counts while Live mode is on). */
  refresh(): void;
  /** Called after every change (resize canvases, refresh the View menu). */
  onChange(listener: (state: PanelState) => void): void;
}

/**
 * Gives each panel a header (icon, name, one-line purpose, its own buttons, Hide and Full page), keeps the state in
 * `data-*` attributes (CSS does the hiding and the full-page layout), remembers what is hidden, and lists hidden
 * panels as chips in `dock` so they are one click away.
 */
export function createPanelChrome(defs: readonly PanelDef[], dock: HTMLElement): PanelChrome {
  let state = parsePanelState(loadJson(PANELS_STORAGE_KEY));
  const listeners: Array<(s: PanelState) => void> = [];
  const hideButtons = new Map<PanelId, HTMLButtonElement>();
  const fullButtons = new Map<PanelId, HTMLButtonElement>();
  let focusBefore: Element | null = null;

  const apply = (next: PanelState, announce?: () => void) => {
    const wasFull = state.full;
    state = next;
    saveJson(PANELS_STORAGE_KEY, storablePanels(state));
    render();
    if (wasFull === null && state.full !== null) {
      focusBefore = document.activeElement;
      fullButtons.get(state.full)?.focus();
    } else if (wasFull !== null && state.full === null && focusBefore instanceof HTMLElement && document.contains(focusBefore)) {
      focusBefore.focus();
    }
    announce?.();
    for (const l of listeners) l(state);
  };

  const name = (id: PanelId) => PANEL_TEXT[id].title;

  const doHide = (id: PanelId) => {
    if (!isHidden(state, id) && !canHide(state, id)) {
      toast('Keep one open', 'At least one of Strategy, Chart or Results has to stay on the page, so there is always something to look at.', 'warn');
      return;
    }
    const hiding = !isHidden(state, id);
    apply(toggleHidden(state, id), () => explain(hiding ? PANEL_BUTTON_TEXT.hide(name(id)) : PANEL_BUTTON_TEXT.show(name(id))));
  };
  const doFull = (id: PanelId) => {
    const entering = !isFull(state, id);
    apply(toggleFull(state, id), () => explain(entering ? PANEL_BUTTON_TEXT.full(name(id)) : PANEL_BUTTON_TEXT.exitFull(name(id))));
  };

  for (const def of defs) {
    const { id, el } = def;
    const text = PANEL_TEXT[id];
    const hideBtn = h('button', { type: 'button', class: 'panel-btn', 'data-act': 'hide' }, icon('hide', 16), h('span', { class: 'panel-btn-label' }, 'Hide'));
    const fullBtn = h('button', { type: 'button', class: 'panel-btn', 'data-act': 'full' });
    hideBtn.setAttribute('aria-label', `Hide ${text.title}`);
    hideBtn.setAttribute('data-tip', `Hide the ${text.title} panel to make room (shortcut: ${SHORTCUT[id]}). Bring it back from the strip that appears, or the View menu.`);
    hideBtn.addEventListener('click', () => doHide(id));
    fullBtn.addEventListener('click', () => doFull(id));
    hideButtons.set(id, hideBtn);
    fullButtons.set(id, fullBtn);
    const heading = h('h2', { class: 'panel-title', id: `panel-title-${id}` }, text.title);
    const head = h(
      'div', { class: 'panel-head' },
      h('span', { class: 'panel-icon' }, icon(ICONS[id], 16)),
      heading,
      h('span', { class: 'panel-sub' }, text.subtitle),
      h('span', { class: 'panel-help', tabindex: '0', role: 'img', 'aria-label': `About ${text.title}: ${text.help}`, 'data-tip': text.help }, icon('info', 14)),
      h('span', { class: 'panel-spacer' }),
      h('div', { class: 'panel-actions' }, ...(def.actions ?? []), hideBtn, fullBtn),
    );
    el.classList.add('panel');
    el.dataset.panel = id;
    el.setAttribute('aria-labelledby', heading.id);
    el.prepend(head);
  }

  const dockLabel = h('span', { class: 'dock-label' }, 'Hidden panels:');
  dock.append(dockLabel);
  dock.classList.add('dock');
  dock.hidden = true;
  const chips = new Map<PanelId, HTMLButtonElement>();
  for (const id of PANEL_IDS) {
    const chip = h('button', { type: 'button', class: 'dock-chip', 'data-panel': id }, icon('show', 14), h('span', {}, name(id)));
    chip.setAttribute('data-tip', `Show the ${name(id)} panel again`);
    chip.addEventListener('click', () => doHide(id));
    chips.set(id, chip);
    dock.append(chip);
  }
  const dockAll = h('button', { type: 'button', class: 'dock-chip dock-all' }, 'Show all');
  dockAll.addEventListener('click', () => apply(showAll(), () => explain({ title: 'Everything is back', on: 'All panels are shown again.' })));
  dock.append(dockAll);

  function render(): void {
    const hiddenIds = PANEL_IDS.filter((id) => isHidden(state, id));
    document.body.dataset.hidden = hiddenIds.join(' ');
    if (state.full) document.body.dataset.full = state.full;
    else delete document.body.dataset.full;
    for (const def of defs) {
      const id = def.id;
      const hidden = isHidden(state, id);
      const full = isFull(state, id);
      def.el.toggleAttribute('data-hidden', hidden);
      def.el.toggleAttribute('data-full', full);
      const fullBtn = fullButtons.get(id)!;
      fullBtn.replaceChildren(icon(full ? 'minimize' : 'maximize', 16), h('span', { class: 'panel-btn-label' }, full ? 'Exit full page' : 'Full page'));
      fullBtn.setAttribute('aria-label', full ? `Exit full page for ${name(id)}` : `Show ${name(id)} on the whole page`);
      fullBtn.setAttribute('data-tip', full ? `Go back to the normal layout (shortcut: Esc)` : `Make the ${name(id)} panel fill the whole page (shortcut: Shift+${SHORTCUT[id]})`);
      fullBtn.setAttribute('aria-pressed', String(full));
      hideButtons.get(id)!.hidden = full;
    }
    const liveHiddenByMode = document.body.dataset.mode !== 'live';
    const listed = hiddenIds.filter((id) => id !== 'live' || !liveHiddenByMode);
    for (const [id, chip] of chips) chip.hidden = !listed.includes(id);
    dock.hidden = listed.length === 0;
  }

  render();
  return {
    get state() { return state; },
    hide: doHide,
    full: doFull,
    exitFull() {
      const leaving = state.full;
      if (leaving === null) return;
      apply(exitFull(state), () => explain(PANEL_BUTTON_TEXT.exitFull(name(leaving))));
    },
    refresh: render,
    showAll() { apply(showAll()); },
    onChange(listener) { listeners.push(listener); },
  };
}
