import { h } from './dom';
import { icon } from './icons';

export interface Modal {
  readonly dialog: HTMLDialogElement;
  open(): void;
  close(): void;
}

/**
 * A modal window on the browser's own <dialog>: it traps focus, closes with Esc, and puts focus back where it was.
 * Clicking the dimmed backdrop closes it too. `body` is built by the caller.
 */
export function createModal(title: string, body: HTMLElement, cls = ''): Modal {
  const heading = h('h2', { class: 'modal-title', id: `modal-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }, title);
  const closeButton = h('button', { type: 'button', class: 'modal-close', 'aria-label': `Close ${title}` }, icon('close', 18));
  closeButton.setAttribute('data-tip', 'Close (Esc)');
  const dialog = h('dialog', { class: `modal ${cls}`, 'aria-labelledby': heading.id }, h('div', { class: 'modal-head' }, heading, closeButton), body);
  document.body.append(dialog);
  let opener: Element | null = null;
  const close = () => { if (dialog.open) dialog.close(); };
  closeButton.addEventListener('click', close);
  dialog.addEventListener('click', (ev) => { if (ev.target === dialog) close(); });
  dialog.addEventListener('close', () => {
    if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    opener = null;
  });
  return {
    dialog,
    open() {
      if (dialog.open) return;
      opener = document.activeElement;
      dialog.showModal();
    },
    close,
  };
}

/** True while any modal window is open (global shortcuts stand down then). */
export const modalIsOpen = (): boolean => document.querySelector('dialog[open]') !== null;
