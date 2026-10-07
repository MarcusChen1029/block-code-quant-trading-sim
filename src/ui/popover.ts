import { h } from './dom';

export interface Popover {
  readonly root: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
  setBadge(text: string): void;
  open(): void;
  /** Closes it; `returnFocus` puts focus back on the trigger button (after choosing an item, like Escape does). */
  close(returnFocus?: boolean): void;
  readonly isOpen: boolean;
}

let openPopover: Popover | null = null;

/**
 * A button that opens a small panel below it (the top bar's "Start from…" and "Chart overlays"). The panel is
 * positioned fixed inside the viewport, so it never causes horizontal scrolling on a phone. Escape or a click
 * outside closes it; only one popover is open at a time.
 */
export function createPopover(label: string, title: string, panelLabel: string, cls: string): Popover {
  const badge = h('span', { class: 'pop-badge' });
  badge.hidden = true;
  const button = h('button', { type: 'button', class: 'pop-button', title, 'aria-haspopup': 'true', 'aria-expanded': 'false' }, h('span', {}, label), badge, h('span', { class: 'pop-caret', 'aria-hidden': 'true' }, '▾'));
  const panel = h('div', { class: `pop-panel ${cls}`, role: 'group', 'aria-label': panelLabel });
  panel.hidden = true;
  const root = h('div', { class: 'pop' }, button, panel);

  const place = () => {
    const r = button.getBoundingClientRect();
    const margin = 8;
    panel.style.top = `${Math.round(r.bottom + 4)}px`;
    const width = Math.min(panel.offsetWidth || 320, window.innerWidth - 2 * margin);
    panel.style.maxWidth = `${window.innerWidth - 2 * margin}px`;
    panel.style.left = `${Math.round(Math.max(margin, Math.min(r.left, window.innerWidth - width - margin)))}px`;
    panel.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 16)}px`;
  };
  const onDocPointer = (ev: Event) => {
    if (!root.contains(ev.target as Node)) pop.close();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      pop.close();
      button.focus();
    }
  };
  const pop: Popover = {
    root, button, panel,
    get isOpen() { return !panel.hidden; },
    setBadge(text) {
      badge.textContent = text;
      badge.hidden = text === '';
    },
    open() {
      if (openPopover && openPopover !== pop) openPopover.close();
      openPopover = pop;
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      place();
      document.addEventListener('pointerdown', onDocPointer, true);
      document.addEventListener('keydown', onKey);
      window.addEventListener('resize', place);
    },
    close(returnFocus = false) {
      if (returnFocus) button.focus();
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      if (openPopover === pop) openPopover = null;
      document.removeEventListener('pointerdown', onDocPointer, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', place);
    },
  };
  button.addEventListener('click', () => (pop.isOpen ? pop.close() : pop.open()));
  return pop;
}
