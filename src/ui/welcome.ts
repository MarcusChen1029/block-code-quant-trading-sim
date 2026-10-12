import { DISCLAIMER } from './helpContent';
import { createModal } from './dialog';
import { h } from './dom';
import { saveText } from './storage';
import { WELCOMED_STORAGE_KEY } from './keys';

/** The first-visit window: what this is, in three lines, and where to go next. Shown once; Help brings it all back. */
export function showWelcome(handlers: { onTour(): void; onRun(): void }): void {
  saveText(WELCOMED_STORAGE_KEY, '1');
  const tour = h('button', { type: 'button', class: 'run' }, 'Show me around (1 minute)');
  const run = h('button', { type: 'button' }, 'Run the example now');
  const skip = h('button', { type: 'button', class: 'link-button' }, 'I’ll explore on my own');
  const body = h(
    'div', { class: 'welcome' },
    h('p', { class: 'help-lead' }, 'Build a trading robot out of puzzle blocks, then see how it would have done on real price history.'),
    h('ul', { class: 'welcome-points' },
      h('li', {}, h('strong', {}, '1. Build'), ' snap blocks together (or start from an example)'),
      h('li', {}, h('strong', {}, '2. Run'), ' replay the past in a few seconds'),
      h('li', {}, h('strong', {}, '3. Learn'), ' read the score card and improve your robot')),
    h('div', { class: 'help-actions' }, tour, run, skip),
    h('p', { class: 'fine-print' }, DISCLAIMER),
  );
  const modal = createModal('Welcome to Quant Sim', body, 'welcome-modal');
  tour.addEventListener('click', () => { modal.close(); handlers.onTour(); });
  run.addEventListener('click', () => { modal.close(); handlers.onRun(); });
  skip.addEventListener('click', () => modal.close());
  modal.open();
}
