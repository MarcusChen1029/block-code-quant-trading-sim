import { toast, tipsEnabled } from './toast';

/**
 * Switches that explain themselves. Put `data-explain-title`, `data-explain-on` and (optionally) `data-explain-off`
 * on a checkbox, a button with aria-pressed / aria-expanded, or any button: when it is clicked, a short note says
 * what it just did. The state is read AFTER the element's own handler ran, so the note matches what the user sees.
 */
export function installExplainers(): void {
  const onActivate = (ev: Event) => {
    if (!(ev.target instanceof Element)) return;
    const el = ev.target.closest<HTMLElement>('[data-explain-on]');
    if (!el || !tipsEnabled()) return;
    // Checkboxes report through `change` (their click fires before the state flips in some browsers); skip the click.
    if (ev.type === 'click' && el instanceof HTMLInputElement) return;
    setTimeout(() => {
      const state = explainStateOf(el);
      const text = state ? el.dataset.explainOn : (el.dataset.explainOff ?? el.dataset.explainOn);
      if (text) toast(el.dataset.explainTitle ?? 'Tip', text);
    }, 0);
  };
  document.addEventListener('click', onActivate);
  document.addEventListener('change', onActivate);
}

/** Sets the three attributes for a toggle. */
export function setExplain(el: HTMLElement, title: string, on: string, off?: string): void {
  el.dataset.explainTitle = title;
  el.dataset.explainOn = on;
  if (off !== undefined) el.dataset.explainOff = off;
}

/** Whether a switch is "on": a checkbox's checked state, aria-pressed / aria-expanded, else true (a one-way button). */
function explainStateOf(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return el.checked;
  const pressed = el.getAttribute('aria-pressed');
  if (pressed !== null) return pressed === 'true';
  const expanded = el.getAttribute('aria-expanded');
  if (expanded !== null) return expanded === 'true';
  return true;
}
