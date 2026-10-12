import { h } from './dom';

export interface ChartOverlay {
  /** Shows a spinner and `text` over the chart (prices are loading). */
  busy(text: string): void;
  /** Shows `text` as a problem, with a "Try again" button. */
  error(text: string): void;
  /** True while the problem is on screen (the footer and pop-up notes then stay quiet about it). */
  readonly showingError: boolean;
  hide(): void;
}

/** The "Loading prices…" / "Could not load prices" cover for the chart, so an empty chart always says why. */
export function createChartOverlay(container: HTMLElement, onRetry: () => void): ChartOverlay {
  const spinner = h('span', { class: 'spinner', 'aria-hidden': 'true' });
  const text = h('span', { class: 'chart-overlay-text' });
  const retry = h('button', { type: 'button', class: 'run' }, 'Try again');
  retry.addEventListener('click', onRetry);
  const box = h('div', { class: 'chart-overlay', role: 'status', hidden: '' }, h('div', { class: 'chart-overlay-card' }, spinner, text, retry));
  container.append(box);
  const show = (message: string, failed: boolean) => {
    text.textContent = message;
    spinner.hidden = failed;
    retry.hidden = !failed;
    box.dataset.state = failed ? 'error' : 'busy';
    box.hidden = false;
  };
  return {
    get showingError() { return !box.hidden && box.dataset.state === 'error'; },
    busy: (message) => show(message, false),
    error: (message) => show(message, true),
    hide: () => { box.hidden = true; },
  };
}
