import { h } from './dom';
import { icon } from './icons';
import { saveText } from './storage';
import { TOUR_DONE_STORAGE_KEY } from './tourState';
import { placeTip } from './tooltip';


export interface TourStep {
  /** CSS selector of what to highlight; none (or not visible) = a centred card. */
  target?: string;
  title: string;
  text: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  { title: 'Welcome to Quant Sim! 👋', text: 'Here you build a trading robot out of blocks, then test it on real crypto prices with pretend money. This quick tour shows you around. It takes about a minute.' },
  { target: '#left', title: '1 · Your strategy', text: 'These blocks are your robot’s rules, like a recipe. Drag new blocks from the list on the left and snap them together. Hover over any block to see what it does.' },
  { target: '.starter-pop', title: 'Ready-made strategies', text: 'Not sure where to begin? “Start from…” loads a working example you can study and change. Your old blocks are kept, so you can always go back.' },
  { target: '.market-fields', title: 'What to test on', text: 'Choose a coin, how much time each candle covers, the start date and how much pretend money to start with.' },
  { target: 'button.run', title: 'Run the test', text: 'Press this (or Ctrl + Enter) and the robot replays every candle since the start date, buying and selling by your rules.' },
  { target: '#chart-panel', title: '2 · The price chart', text: 'Each candle is one slice of time: green went up, red went down. After a run, arrows show where your robot bought and sold. Scroll to zoom, drag to move.' },
  { target: '#results-panel', title: '3 · The results', text: 'A one-line summary tells you how it went and whether it beat simply buying and holding. Hover over (or tap) any number to learn what it means.' },
  { target: '.panel-full', title: 'Make room', text: 'Every panel can be hidden or shown full page with these buttons. Press Esc to come back.' },
  { target: '.mode-toggle', title: 'Backtest or Live', text: 'Backtest tests the past in seconds. Live lets your robot trade in real time on today’s prices, still with pretend money.' },
  { target: '#help-btn', title: 'Help is always here', text: 'Open Help (or press ?) for a word list, answers to common questions and keyboard shortcuts. Have fun experimenting!' },
];


/** A step-by-step spotlight tour over the real interface. Escape or "Skip" ends it; it is remembered as done. */
export function startTour(steps: readonly TourStep[] = TOUR_STEPS, onEnd: () => void = () => {}): void {
  if (document.querySelector('.tour')) return;
  const root = h('div', { class: 'tour' });
  const spot = h('div', { class: 'tour-spot', 'aria-hidden': 'true' });
  const title = h('h2', { class: 'tour-title', id: 'tour-title' });
  const text = h('p', { class: 'tour-text', id: 'tour-text' });
  const counter = h('span', { class: 'tour-count' });
  const dots = h('div', { class: 'tour-dots', 'aria-hidden': 'true' }, ...steps.map(() => h('span', {})));
  const back = h('button', { type: 'button', class: 'btn' }, 'Back');
  const next = h('button', { type: 'button', class: 'btn btn-primary' });
  const skip = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Skip tour');
  const card = h(
    'div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'tour-title', 'aria-describedby': 'tour-text', tabindex: '-1' },
    h('div', { class: 'tour-top' }, h('span', { class: 'tour-badge' }, icon('sparkles', 14), 'Tour'), counter),
    title, text, dots,
    h('div', { class: 'tour-buttons' }, skip, h('div', { class: 'panel-spacer' }), back, next),
  );
  root.append(spot, card);
  document.body.append(root);
  const previousFocus = document.activeElement as HTMLElement | null;
  let at = 0;

  const visibleTarget = (step: TourStep): HTMLElement | null => {
    if (!step.target) return null;
    const el = document.querySelector<HTMLElement>(step.target);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? el : null;
  };

  const place = () => {
    const step = steps[at];
    const el = visibleTarget(step);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (!el) {
      spot.hidden = true;
      card.style.left = `${Math.round((vw - card.offsetWidth) / 2)}px`;
      card.style.top = `${Math.round(Math.max(16, (vh - card.offsetHeight) / 2))}px`;
      root.classList.add('tour-dim');
      return;
    }
    root.classList.remove('tour-dim');
    const r = el.getBoundingClientRect();
    const pad = 6;
    const box = { left: Math.max(4, r.left - pad), top: Math.max(4, r.top - pad), right: Math.min(vw - 4, r.right + pad), bottom: Math.min(vh - 4, r.bottom + pad) };
    spot.hidden = false;
    Object.assign(spot.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.right - box.left}px`, height: `${box.bottom - box.top}px` });
    // Big targets (whole panels): put the card inside them, near the top, instead of off-screen below.
    const big = box.bottom - box.top > vh * 0.5;
    const anchor = big ? { left: box.left, top: box.top, bottom: box.top + 56, width: box.right - box.left } : { left: box.left, top: box.top, bottom: box.bottom, width: box.right - box.left };
    const pos = placeTip(anchor, { width: card.offsetWidth, height: card.offsetHeight }, { width: vw, height: vh }, 12, 12);
    card.style.left = `${pos.left}px`;
    card.style.top = `${pos.top}px`;
  };

  const render = () => {
    const step = steps[at];
    title.textContent = step.title;
    text.textContent = step.text;
    counter.textContent = `${at + 1} of ${steps.length}`;
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === at));
    back.hidden = at === 0;
    next.textContent = at === steps.length - 1 ? 'Start building!' : at === 0 ? 'Show me around' : 'Next';
    visibleTarget(step)?.scrollIntoView({ block: 'nearest' });
    place();
    card.focus();
  };

  const end = () => {
    saveText(TOUR_DONE_STORAGE_KEY, '1');
    root.remove();
    window.removeEventListener('resize', place);
    document.removeEventListener('keydown', onKey, true);
    previousFocus?.focus?.();
    onEnd();
  };
  const go = (delta: number) => {
    const n = at + delta;
    if (n >= steps.length) return end();
    if (n < 0) return;
    at = n;
    render();
  };
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      end();
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      go(1);
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      go(-1);
    } else if (ev.key === 'Tab') {
      // Keep focus inside the card.
      const items = [...card.querySelectorAll<HTMLElement>('button:not([hidden])')];
      const i = items.indexOf(document.activeElement as HTMLElement);
      ev.preventDefault();
      items[(i + (ev.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };
  next.addEventListener('click', () => go(1));
  back.addEventListener('click', () => go(-1));
  skip.addEventListener('click', end);
  window.addEventListener('resize', place);
  document.addEventListener('keydown', onKey, true);
  render();
}
