import { BUTTON_GUIDE, DISCLAIMER, GLOSSARY, QUICK_START } from './helpContent';
import { createModal } from './dialog';
import { h } from './dom';
import { SHORTCUT_HELP } from './shortcuts';

export type HelpPage = 'start' | 'buttons' | 'words' | 'keys' | 'about';

export interface HelpDialog {
  open(page?: HelpPage): void;
}

/** True when a glossary entry matches what was typed (term or meaning, ignoring case). */
export function matchesGlossary(entry: { term: string; meaning: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === '' || entry.term.toLowerCase().includes(q) || entry.meaning.toLowerCase().includes(q);
}

/** The Help window: five short pages, written for someone new to trading. */
export function createHelpDialog(handlers: { onTour(): void; onReset(): void }): HelpDialog {
  const pages = new Map<HelpPage, HTMLElement>();
  const tabs = new Map<HelpPage, HTMLButtonElement>();
  const tabList = h('div', { class: 'help-tabs', role: 'tablist', 'aria-label': 'Help pages' });
  const content = h('div', { class: 'help-content' });

  const startPage = h(
    'div', { class: 'help-page' },
    h('p', { class: 'help-lead' }, 'Quant Sim lets you build a trading robot out of puzzle blocks, then test it on real price history using pretend money. Nobody can lose a penny.'),
    h('ol', { class: 'steps' }, ...QUICK_START.map((s, i) => h('li', {}, h('span', { class: 'step-num' }, String(i + 1)), h('div', {}, h('strong', {}, s.title), h('p', {}, s.text))))),
  );
  const tourButton = h('button', { type: 'button', class: 'run' }, 'Take the guided tour');
  tourButton.addEventListener('click', () => { modal.close(); handlers.onTour(); });
  startPage.append(h('div', { class: 'help-actions' }, tourButton));

  const buttonsPage = h('div', { class: 'help-page' }, h('p', { class: 'help-lead' }, 'Everything you can click, and what it does. You can also hover over almost anything to see a short note.'),
    h('dl', { class: 'guide' }, ...BUTTON_GUIDE.flatMap((b) => [h('dt', {}, b.name), h('dd', {}, b.text)])));

  const search = h('input', { type: 'search', class: 'help-search', placeholder: 'Search words, like "drawdown"…', 'aria-label': 'Search the word list' });
  const wordList = h('dl', { class: 'guide' });
  const empty = h('p', { class: 'hint' }, 'No words match. Try a shorter search.');
  const renderWords = () => {
    const found = GLOSSARY.filter((g) => matchesGlossary(g, search.value));
    wordList.replaceChildren(...found.flatMap((g) => [h('dt', {}, g.term), h('dd', {}, g.meaning)]));
    empty.hidden = found.length > 0;
  };
  search.addEventListener('input', renderWords);
  renderWords();
  const wordsPage = h('div', { class: 'help-page' }, search, wordList, empty);

  const keysPage = h('div', { class: 'help-page' }, h('p', { class: 'help-lead' }, 'Handy keys. They do nothing while you are typing in a box.'),
    h('dl', { class: 'guide keys' }, ...SHORTCUT_HELP.flatMap((s) => [h('dt', {}, ...s.keys.split(/(\s{2,})/).map((part) => (/^\s+$/.test(part) ? ' or ' : h('kbd', {}, part.trim())))), h('dd', {}, s.text)])));

  const resetButton = h('button', { type: 'button', class: 'danger-button' }, 'Forget everything saved in this browser');
  resetButton.addEventListener('click', () => handlers.onReset());
  const aboutPage = h('div', { class: 'help-page' },
    h('p', { class: 'help-lead' }, DISCLAIMER),
    h('p', {}, 'Prices come from Binance (market data only; no account, no login, no orders). Your blocks, settings and layout are saved in this browser, and nowhere else.'),
    h('p', {}, 'Indicators are calculated as TradingView does, but the first few candles can differ slightly while an indicator "warms up".'),
    h('h3', { class: 'help-subhead' }, 'Start fresh'),
    h('p', {}, 'Want a clean slate? This forgets the blocks, settings and layout saved in this browser. Live practice sessions are not touched.'),
    resetButton);

  const defs: Array<[HelpPage, string, HTMLElement]> = [
    ['start', 'Start here', startPage], ['buttons', 'Buttons & switches', buttonsPage], ['words', 'Words to know', wordsPage],
    ['keys', 'Shortcuts', keysPage], ['about', 'About', aboutPage],
  ];
  const show = (page: HelpPage) => {
    for (const [id, tab] of tabs) {
      tab.setAttribute('aria-selected', String(id === page));
      tab.tabIndex = id === page ? 0 : -1;
    }
    content.replaceChildren(pages.get(page)!);
    content.scrollTop = 0;
    if (page === 'words') search.focus();
  };
  for (const [id, label, el] of defs) {
    pages.set(id, el);
    const tab = h('button', { type: 'button', role: 'tab', class: 'help-tab' }, label);
    tab.addEventListener('click', () => show(id));
    tab.addEventListener('keydown', (ev) => {
      const i = defs.findIndex(([d]) => d === id);
      const next = ev.key === 'ArrowRight' ? defs[(i + 1) % defs.length] : ev.key === 'ArrowLeft' ? defs[(i + defs.length - 1) % defs.length] : null;
      if (!next) return;
      ev.preventDefault();
      show(next[0]);
      tabs.get(next[0])?.focus();
    });
    tabs.set(id, tab);
    tabList.append(tab);
  }
  const modal = createModal('Help', h('div', { class: 'help' }, tabList, content), 'help-modal');
  show('start');
  return {
    open(page = 'start') {
      show(page);
      modal.open();
    },
  };
}
