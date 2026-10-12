import { h } from './dom';
import { availableSteps, stepAfter, TOUR_STEPS, type TourStep } from './tourSteps';

export const WELCOMED_STORAGE_KEY = 'quant-sim.welcomed';

const targetEl = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-tour="${name}"]`);
const isVisible = (el: HTMLElement | null): el is HTMLElement => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};

let running = false;

export const isTourRunning = (): boolean => running;

/** Guided tour: dims the page, lights up one control at a time and explains it. Esc or "Skip" ends it. */
export function startTour(onDone: () => void = () => {}): void {
  if (running) return;
  const steps = availableSteps(TOUR_STEPS, (t) => isVisible(targetEl(t)));
  if (steps.length === 0) return;
  running = true;
  const opener = document.activeElement;
  let index = 0;

  const spot = h('div', { class: 'tour-spot' });
  const card = h('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text' });
  const shield = h('div', { class: 'tour-shield' });
  document.body.append(shield, spot, card);

  const title = h('h3', { id: 'tour-title' });
  const text = h('p', { id: 'tour-text' });
  const count = h('span', { class: 'tour-count' });
  const skip = h('button', { type: 'button', class: 'tour-skip' }, 'Skip tour');
  const back = h('button', { type: 'button' }, 'Back');
  const next = h('button', { type: 'button', class: 'run' });
  card.append(title, text, h('div', { class: 'tour-foot' }, count, skip, back, next));

  const finish = () => {
    running = false;
    shield.remove(); spot.remove(); card.remove();
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    onDone();
  };
  const go = (direction: 1 | -1) => {
    const to = stepAfter(index, direction);
    if (to === null) return;
    if (to >= steps.length) return finish();
    index = to;
    render();
  };
  skip.addEventListener('click', finish);
  back.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));

  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(); }
    else if (ev.key === 'ArrowRight' || ev.key === 'Enter' && document.activeElement === document.body) { ev.preventDefault(); go(1); }
    else if (ev.key === 'ArrowLeft') { ev.preventDefault(); go(-1); }
  }

  function place(): void {
    const step: TourStep = steps[index];
    const el = step.target ? targetEl(step.target) : null;
    const pad = 6;
    if (isVisible(el)) {
      const r = el.getBoundingClientRect();
      spot.hidden = false;
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + 2 * pad}px`, height: `${r.height + 2 * pad}px` });
      const w = card.offsetWidth;
      const ch = card.offsetHeight;
      const below = r.bottom + pad + 12 + ch <= window.innerHeight;
      const top = below ? r.bottom + pad + 12 : Math.max(12, r.top - pad - 12 - ch);
      const left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12));
      // A tall target (a whole panel) leaves no room above or below: sit inside its top-left corner instead.
      const overlaps = !below && r.top - pad - 12 - ch < 12;
      card.style.top = `${Math.round(overlaps ? Math.max(12, r.top + 48) : top)}px`;
      card.style.left = `${Math.round(overlaps ? Math.max(12, Math.min(r.left + 24, window.innerWidth - w - 12)) : left)}px`;
    } else {
      spot.hidden = true;
      card.style.top = `${Math.max(12, Math.round((window.innerHeight - card.offsetHeight) / 3))}px`;
      card.style.left = `${Math.max(12, Math.round((window.innerWidth - card.offsetWidth) / 2))}px`;
    }
  }

  function render(): void {
    const step = steps[index];
    title.textContent = step.title;
    text.textContent = step.text;
    count.textContent = `${index + 1} of ${steps.length}`;
    back.hidden = index === 0;
    next.textContent = index === steps.length - 1 ? 'Done' : 'Next';
    const el = step.target ? targetEl(step.target) : null;
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    place();
    next.focus();
  }

  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  render();
}
