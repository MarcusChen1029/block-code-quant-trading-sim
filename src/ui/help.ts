import { h } from './dom';
import { FAQ, GETTING_STARTED, GLOSSARY, type GlossaryEntry } from './helpContent';
import { icon, type IconName } from './icons';
import { SHORTCUT_DOCS } from './shortcuts';

export type HelpTab = 'start' | 'glossary' | 'faq' | 'keys' | 'about';

export interface HelpWindow {
  open(tab?: HelpTab, search?: string): void;
  close(): void;
}

/** Glossary entries matching `query` (term, other names or text; case-insensitive), best matches first. */
export function searchGlossary(entries: readonly GlossaryEntry[], query: string): GlossaryEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...entries];
  const score = (e: GlossaryEntry) => {
    const names = [e.term, ...(e.aka ?? [])].map((n) => n.toLowerCase());
    if (names.some((n) => n === q)) return 3;
    if (names.some((n) => n.startsWith(q))) return 2;
    if (names.some((n) => n.includes(q))) return 1.5;
    return e.text.toLowerCase().includes(q) ? 1 : 0;
  };
  return entries.map((e) => ({ e, s: score(e) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.e);
}

/** A <dialog> with tabs: getting started, glossary (searchable), FAQ, keyboard shortcuts, about & safety. */
export function createHelpWindow(onTour: () => void): HelpWindow {
  const dialog = h('dialog', { class: 'dialog help-dialog', 'aria-labelledby': 'help-title' });
  const close = h('button', { type: 'button', class: 'icon-btn dialog-close', 'aria-label': 'Close help' }, icon('close', 18));
  close.addEventListener('click', () => dialog.close());

  const tabs: Array<[HelpTab, string, IconName]> = [
    ['start', 'Start here', 'rocket'],
    ['glossary', 'Word list', 'book'],
    ['faq', 'Questions', 'help'],
    ['keys', 'Keyboard', 'keyboard'],
    ['about', 'Safety & about', 'shield'],
  ];
  const tabButtons = new Map<HelpTab, HTMLButtonElement>();
  const sections = new Map<HelpTab, HTMLElement>();
  const tablist = h('div', { class: 'help-tabs', role: 'tablist', 'aria-label': 'Help topics' });
  for (const [id, label, ic] of tabs) {
    const b = h('button', { type: 'button', role: 'tab', id: `help-tab-${id}`, 'aria-controls': `help-sec-${id}` }, icon(ic), h('span', {}, label));
    b.addEventListener('click', () => show(id));
    tabButtons.set(id, b);
    tablist.append(b);
  }
  // Arrow keys move between tabs (the usual tablist keyboard pattern).
  tablist.addEventListener('keydown', (ev) => {
    const ids = tabs.map(([id]) => id);
    const at = ids.findIndex((id) => tabButtons.get(id) === document.activeElement);
    if (at < 0) return;
    const next = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? at + 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? at - 1 : null;
    if (next === null) return;
    ev.preventDefault();
    const id = ids[(next + ids.length) % ids.length];
    show(id);
    tabButtons.get(id)!.focus();
  });

  const section = (id: HelpTab, ...children: Array<Node | string>) => {
    const el = h('section', { class: 'help-section', role: 'tabpanel', id: `help-sec-${id}`, 'aria-labelledby': `help-tab-${id}`, tabindex: '0' }, ...children);
    sections.set(id, el);
    return el;
  };

  // Start here
  const tourButton = h('button', { type: 'button', class: 'btn btn-primary' }, icon('sparkles'), h('span', {}, 'Take the 1-minute tour'));
  tourButton.addEventListener('click', () => {
    dialog.close();
    onTour();
  });
  const start = section(
    'start',
    h('p', { class: 'help-lead' }, 'Quant Sim lets you build a trading robot from blocks and see how it would have done, using real prices and pretend money. Here is how:'),
    h('ol', { class: 'steps' }, ...GETTING_STARTED.map((s, i) => h('li', { class: 'step' }, h('span', { class: 'step-num', 'aria-hidden': 'true' }, String(i + 1)), h('div', {}, h('strong', {}, s.title), h('p', {}, s.text))))),
    h('div', { class: 'help-cta' }, tourButton, h('span', { class: 'muted' }, 'Tip: every “?” button and anything you hover over explains itself.')),
  );

  // Glossary
  const search = h('input', { type: 'search', class: 'help-search', placeholder: 'Search a word, like “leverage” or “candle”…', 'aria-label': 'Search the word list' });
  const list = h('dl', { class: 'glossary' });
  const empty = h('p', { class: 'muted', hidden: '' }, 'No word matches that. Try a shorter search.');
  const renderList = () => {
    const found = searchGlossary(GLOSSARY, search.value);
    list.replaceChildren(...found.flatMap((e) => [
      h('dt', {}, e.term, ...(e.aka?.length ? [h('span', { class: 'aka' }, ` also called ${e.aka.join(', ')}`)] : [])),
      h('dd', {}, e.text, ...(e.example ? [h('span', { class: 'example' }, e.example)] : [])),
    ]));
    empty.hidden = found.length > 0;
  };
  search.addEventListener('input', renderList);
  renderList();
  const glossary = section('glossary', search, empty, list);

  const faq = section('faq', ...FAQ.map((f) => h('details', { class: 'faq' }, h('summary', {}, f.q), h('p', {}, f.a))));

  const keys = section(
    'keys',
    h('table', { class: 'keys-table' }, h('tbody', {}, ...SHORTCUT_DOCS.map((s) =>
      h('tr', {}, h('td', {}, ...s.keys.flatMap((k, i) => [...(i > 0 ? [' + '] : []), h('kbd', {}, k)])), h('td', {}, s.what))))),
    h('p', { class: 'muted' }, 'Single-key shortcuts do nothing while you are typing in a box or working in the blocks.'),
  );

  const about = section(
    'about',
    h('div', { class: 'safety' }, icon('shield', 22), h('div', {},
      h('strong', {}, 'Pretend money only.'),
      h('p', {}, 'Quant Sim never places real orders, never asks for an exchange account and never handles real money. It only reads public prices from the Binance exchange.'))),
    h('h3', {}, 'Your privacy'),
    h('p', {}, 'There is no sign-up. Your blocks, settings and live sessions are stored in this browser only. Clearing your browser data, or “Reset everything” in Settings, removes them.'),
    h('h3', {}, 'Not financial advice'),
    h('p', {}, 'This is a learning tool. Results on past prices do not predict the future, and real trading has risks that a simulator cannot show. Never trade real money you cannot afford to lose, and talk to a trusted adult first.'),
    h('h3', {}, 'Made with'),
    h('p', {}, 'Charts: ', h('a', { href: 'https://www.tradingview.com/', target: '_blank', rel: 'noopener' }, 'TradingView Lightweight Charts™'),
      ', © TradingView, Inc. Blocks: ', h('a', { href: 'https://developers.google.com/blockly', target: '_blank', rel: 'noopener' }, 'Blockly'),
      ' (Apache 2.0). Prices: Binance public market data.'),
        h('h3', {}, 'How accurate is it?'),
    h('p', {}, 'Orders fill at the next candle’s open price, with the fees and slippage from Account settings. Indicator values in the first few candles can differ slightly from TradingView while they warm up.'),
  );

  const title = h('h2', { id: 'help-title' }, 'Help');
  dialog.append(
    h('div', { class: 'dialog-head' }, h('span', { class: 'dialog-icon' }, icon('help', 20)), title, close),
    tablist,
    h('div', { class: 'dialog-body' }, start, glossary, faq, keys, about),
  );
  // A click on the dimmed backdrop (outside the box) closes it.
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  function show(tab: HelpTab) {
    for (const [id, b] of tabButtons) {
      b.setAttribute('aria-selected', String(id === tab));
      b.tabIndex = id === tab ? 0 : -1;
      sections.get(id)!.hidden = id !== tab;
    }
  }

  return {
    open(tab = 'start', query) {
      show(tab);
      if (query !== undefined) {
        search.value = query;
        renderList();
      }
      if (!dialog.open) dialog.showModal();
      (tab === 'glossary' ? search : tabButtons.get(tab)!).focus();
    },
    close: () => dialog.close(),
  };
}
