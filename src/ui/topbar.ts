import { TIMEFRAMES } from '../data/types';
import { accountSummary } from './accountSummary';
import { h } from './dom';
import { icon } from './icons';
import { isAccountField, type RawSettings } from './settings';
import { loadText, saveText } from './storage';
import { infoButton, tip } from './tooltip';

export interface TopBar {
  read(): RawSettings;
  setRunning(running: boolean): void;
  /** Primary-row slot for extra controls ("Start from…", "Chart overlays"). */
  readonly tools: HTMLElement;
  /** Slot inside the collapsible "Account settings" section (the strategy source select). */
  readonly extras: HTMLElement;
  setMode(mode: AppMode): void;
  /** Recomputes the closed section's summary (call when something it mentions changes outside the fields). */
  refreshSummary(): void;
  /**
   * Marks `field` invalid and focuses it, opening Account settings first when the field lives there; `message`
   * is shown under the bar until the value is edited.
   */
  showInvalid(field: keyof RawSettings, message?: string): void;
}

/** Backtest: run over history. Live: paper-trade sessions on the live stream (start date and Run do not apply). */
export type AppMode = 'backtest' | 'live';

export const ACCOUNT_OPEN_STORAGE_KEY = 'quant-sim.account-open';

/** Suggestions for the coin box, with the coin's everyday name. */
const COINS: Array<[string, string]> = [
  ['BTCUSDT', 'Bitcoin'], ['ETHUSDT', 'Ethereum'], ['SOLUSDT', 'Solana'], ['BNBUSDT', 'BNB'], ['XRPUSDT', 'XRP'],
  ['DOGEUSDT', 'Dogecoin'], ['ADAUSDT', 'Cardano'], ['LTCUSDT', 'Litecoin'],
];

/** Everyday words for the candle sizes in the menu. */
const TF_NAMES: Record<string, string> = {
  '1m': '1 minute', '3m': '3 minutes', '5m': '5 minutes', '15m': '15 minutes', '30m': '30 minutes',
  '1h': '1 hour', '2h': '2 hours', '4h': '4 hours', '6h': '6 hours', '8h': '8 hours', '12h': '12 hours',
  '1d': '1 day', '3d': '3 days', '1w': '1 week', '1M': '1 month',
};

/**
 * The run form. Primary row: mode, coin, candle size, start date, starting money, Run (+ tools). Leverage, fees
 * and slippage live in a collapsible "Account settings" section (closed by default, state remembered) whose
 * button shows a one-line summary, highlighted when a value differs from the defaults. Every field has a "?"
 * that explains it in plain words.
 */
export function createTopBar(
  container: HTMLElement,
  initial: RawSettings,
  onRun: () => void,
  initialMode: AppMode = 'backtest',
  onMode: (mode: AppMode) => void = () => {},
  usesBuiltInStrategy: () => boolean = () => false,
): TopBar {
  const input = (name: keyof RawSettings, type: string, width: string, attrs: Record<string, string> = {}) => {
    const el = h('input', { name, type, style: `width:${width}`, ...attrs });
    el.value = initial[name];
    return el;
  };
  const symbol = input('symbol', 'text', '104px', { list: 'symbols', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters' });
  symbol.addEventListener('change', () => { symbol.value = symbol.value.trim().toUpperCase(); });
  const symbols = h('datalist', { id: 'symbols' }, ...COINS.map(([s, name]) => h('option', { value: s, label: name })));
  const timeframe = h('select', { name: 'timeframe' }, ...TIMEFRAMES.map((tf) => h('option', { value: tf }, TF_NAMES[tf] ?? tf)));
  timeframe.value = initial.timeframe;
  const startDate = input('startDate', 'date', '142px');
  const balance = input('balance', 'number', '104px', { min: '0', step: '100', inputmode: 'decimal' });
  const leverage = input('leverage', 'number', '70px', { min: '1', max: '125', step: '1', inputmode: 'numeric' });
  const takerFeePct = input('takerFeePct', 'number', '76px', { min: '0', step: '0.01', inputmode: 'decimal' });
  const makerFeePct = input('makerFeePct', 'number', '76px', { min: '0', step: '0.01', inputmode: 'decimal' });
  const slippageBps = input('slippageBps', 'number', '70px', { min: '0', step: '1', inputmode: 'numeric' });
  const runLabel = h('span', {}, 'Run test');
  const run = h('button', { type: 'submit', class: 'run backtest-only' }, icon('play', 14), runLabel);
  tip(run, 'Test your strategy on every candle from the start date until now. Shortcut: Ctrl + Enter', 'Run the backtest');

  const modeButtons: Array<[AppMode, HTMLButtonElement]> = [
    ['backtest', tip(h('button', { type: 'button' }, icon('history', 15), h('span', {}, 'Backtest')),
      'Test your strategy on past prices. It takes seconds and shows what would have happened.', 'Backtest: test on the past')],
    ['live', tip(h('button', { type: 'button' }, icon('live', 15), h('span', {}, 'Live')),
      'Let your strategy trade on real prices as they happen right now, with pretend money. No real orders are ever sent.', 'Live: practise in real time')],
  ];
  const showMode = (mode: AppMode) => {
    document.body.dataset.mode = mode;
    for (const [id, b] of modeButtons) {
      b.classList.toggle('active', id === mode);
      b.setAttribute('aria-pressed', String(id === mode));
    }
  };
  for (const [id, b] of modeButtons) {
    b.addEventListener('click', () => {
      if (document.body.dataset.mode === id) return;
      showMode(id);
      onMode(id);
    });
  }
  const modeToggle = h('div', { class: 'mode-toggle segmented', role: 'group', 'aria-label': 'Mode' }, ...modeButtons.map(([, b]) => b));
  showMode(initialMode);

  /** A labelled field with a "?" explaining it. */
  const field = (label: string, el: HTMLElement, help: string, cls?: string) => {
    el.setAttribute('aria-label', label); // the label also holds the "?" button, which must not join the name
    return h('label', { class: `field ${cls ?? ''}`.trim() }, h('span', { class: 'field-label' }, label, infoButton(help, `What is “${label}”?`, label)), el);
  };

  // Account settings: closed by default; the toggle carries the summary of the hidden values.
  const summary = h('span', { class: 'account-summary' });
  const accountToggle = h(
    'button', { type: 'button', class: 'account-toggle', 'aria-expanded': 'false', 'aria-controls': 'account-panel' },
    h('span', { class: 'account-caret', 'aria-hidden': 'true' }, icon('chevronRight', 14)), h('span', { class: 'account-title' }, 'Account settings'), summary,
  );
  tip(accountToggle, 'Leverage, fees and slippage: the fine print of how trades are filled. The defaults are fine to start with.', 'Account settings');
  const extras = h('div', { class: 'extras' });
  const accountPanel = h(
    'div', { class: 'account-panel', id: 'account-panel', role: 'group', 'aria-label': 'Account settings' },
    field('Leverage (×)', leverage, 'Trade bigger than your money by borrowing. 1 means no borrowing. 5 makes every win AND every loss 5 times bigger. Allowed: 1 to 125.'),
    field('Instant fee %', takerFeePct, 'The exchange’s fee, in percent, for orders that fill straight away (market and stop orders). Also called the “taker” fee. 0.04 means 4 cents per $100.'),
    field('Waiting fee %', makerFeePct, 'The fee, in percent, for orders that wait for a price (limit and take-profit orders). Also called the “maker” fee. Usually smaller than the instant fee.'),
    field('Slippage (bps)', slippageBps, 'How much worse than expected an instant order fills, because prices move fast. In basis points: 1 bps = 0.01%, so 2 bps on $100 is 2 cents.'),
    extras,
  );
  const refreshSummary = () => {
    const s = accountSummary({ leverage: leverage.value, takerFeePct: takerFeePct.value, makerFeePct: makerFeePct.value, slippageBps: slippageBps.value }, usesBuiltInStrategy());
    summary.textContent = s.text;
    accountToggle.classList.toggle('non-default', s.nonDefault);
  };
  let accountOpen = false;
  const setOpen = (open: boolean) => {
    accountOpen = open;
    accountPanel.hidden = !open;
    accountToggle.setAttribute('aria-expanded', String(open));
    accountToggle.classList.toggle('open', open);
    saveText(ACCOUNT_OPEN_STORAGE_KEY, open ? '1' : '0');
  };
  accountToggle.addEventListener('click', () => setOpen(!accountOpen));
  for (const el of [leverage, takerFeePct, makerFeePct, slippageBps]) el.addEventListener('input', refreshSummary);

  const tools = h('div', { class: 'tools' });
  const formError = h('div', { class: 'form-error', role: 'alert', hidden: '' });
  const form = h(
    'form', { class: 'run-form' },
    h('div', { class: 'field mode-field' }, h('span', { class: 'field-label' }, 'Mode'), modeToggle),
    h('div', { class: 'market-fields' },
      field('Coin', symbol, 'Which coin to trade. BTCUSDT means Bitcoin priced in US dollars (USDT). Type one or pick from the list.'),
      symbols,
      field('Candle size', timeframe, 'How much time each candle on the chart covers. Smaller candles = more detail and more trades; bigger candles = the long-term picture.'),
      field('Start date', startDate, 'The test begins on this day and runs until now. An earlier date means more history (and a longer test).', 'backtest-only'),
      field('Starting money', balance, 'How many pretend dollars your account starts with.'),
    ),
    run,
    tools,
    accountToggle,
    accountPanel,
    formError,
  );
  // The browser's own validation (min/max/step) would silently block submit: parseSettings validates instead,
  // with a specific message; the step attributes only drive the spinner arrows.
  form.noValidate = true;
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    onRun();
  });
  container.append(form);
  setOpen(loadText(ACCOUNT_OPEN_STORAGE_KEY) === '1');
  refreshSummary();

  const fields: Record<keyof RawSettings, HTMLInputElement | HTMLSelectElement> = {
    symbol, timeframe, startDate, balance, leverage, takerFeePct, makerFeePct, slippageBps,
  };
  for (const el of Object.values(fields)) {
    el.addEventListener('input', () => {
      if (el.getAttribute('aria-invalid') === 'true') formError.hidden = true;
      el.removeAttribute('aria-invalid');
      el.removeAttribute('aria-errormessage');
    });
  }
  const showInvalid = (field: keyof RawSettings, message?: string) => {
    const el = fields[field];
    if (message) {
      // "leverage must be ..." -> "Leverage must be ..."
      formError.replaceChildren(h('strong', {}, 'Please fix: '), message.charAt(0).toUpperCase() + message.slice(1) + '.');
      formError.id = 'topbar-error';
      formError.hidden = false;
      el.setAttribute('aria-errormessage', 'topbar-error');
    }
    if (isAccountField(field) && !accountOpen) setOpen(true);
    el.setAttribute('aria-invalid', 'true');
    el.focus();
    if (el instanceof HTMLInputElement && el.type !== 'date') el.select();
  };

  return {
    tools,
    extras,
    setMode: showMode,
    refreshSummary,
    showInvalid,
    read: () => ({
      symbol: symbol.value,
      timeframe: timeframe.value,
      startDate: startDate.value,
      balance: balance.value,
      leverage: leverage.value,
      takerFeePct: takerFeePct.value,
      makerFeePct: makerFeePct.value,
      slippageBps: slippageBps.value,
    }),
    setRunning(running: boolean) {
      run.disabled = running;
      run.classList.toggle('busy', running);
      run.setAttribute('aria-busy', String(running));
      runLabel.textContent = running ? 'Running…' : 'Run test';
    },
  };
}
