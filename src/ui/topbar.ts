import { TIMEFRAMES } from '../data/types';
import { accountSummary } from './accountSummary';
import { ACCOUNT_TEXT, FIELD_TEXT, MODE_TEXT } from './descriptions';
import { h } from './dom';
import { setExplain } from './explain';
import { icon } from './icons';
import { isAccountField, type RawSettings } from './settings';
import { loadText, saveText } from './storage';

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
  /** Marks `field` invalid and focuses it, opening Account settings first when the field lives there. */
  showInvalid(field: keyof RawSettings): void;
}

/** Backtest: run over history. Live: paper-trade sessions on the live stream (start date and Run do not apply). */
export type AppMode = 'backtest' | 'live';

export const ACCOUNT_OPEN_STORAGE_KEY = 'quant-sim.account-open';

/**
 * The run form. Primary row: mode, product, timeframe, start date, balance, Run (+ tools). Leverage, fees and
 * slippage live in a collapsible "Account settings" section (closed by default, state remembered) whose button
 * shows a one-line summary, highlighted when a value differs from the defaults.
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
  const symbol = input('symbol', 'text', '90px', { list: 'symbols' });
  const symbols = h('datalist', { id: 'symbols' }, ...['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT'].map((s) => h('option', { value: s })));
  const timeframe = h('select', { name: 'timeframe' }, ...TIMEFRAMES.map((tf) => h('option', { value: tf }, tf)));
  timeframe.value = initial.timeframe;
  const startDate = input('startDate', 'date', '130px');
  const balance = input('balance', 'number', '90px', { min: '0', step: '100' });
  const leverage = input('leverage', 'number', '55px', { min: '1', max: '125', step: '1' });
  const takerFeePct = input('takerFeePct', 'number', '60px', { min: '0', step: '0.01' });
  const makerFeePct = input('makerFeePct', 'number', '60px', { min: '0', step: '0.01' });
  const slippageBps = input('slippageBps', 'number', '55px', { min: '0', step: '1' });
  const runLabel = (text: string) => run.replaceChildren(icon('play', 14), text);
  const run = h('button', { type: 'submit', class: 'run backtest-only', 'data-tour': 'run', 'data-tip': FIELD_TEXT.run }, 'Run');
  run.style.display = 'inline-flex';
  run.style.alignItems = 'center';
  run.style.gap = '7px';
  runLabel('Run');

  const modeButtons: Array<[AppMode, HTMLButtonElement]> = [
    ['backtest', h('button', { type: 'button', 'data-tip': MODE_TEXT.backtest.on }, 'Backtest')],
    ['live', h('button', { type: 'button', 'data-tip': MODE_TEXT.live.on }, 'Live')],
  ];
  for (const [id, b] of modeButtons) setExplain(b, MODE_TEXT[id].title, MODE_TEXT[id].on);
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
  const modeToggle = h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Mode', 'data-tour': 'mode' }, ...modeButtons.map(([, b]) => b));
  showMode(initialMode);

  const field = (label: string, el: HTMLElement, cls?: string, tip?: string) =>
    h('label', { class: cls, 'data-tip': tip }, h('span', { class: tip ? 'field-label' : undefined }, label), el);

  // Account settings: closed by default; the toggle carries the summary of the hidden values.
  const summary = h('span', { class: 'account-summary' });
  const accountToggle = h(
    'button', { type: 'button', class: 'account-toggle', 'aria-expanded': 'false', 'aria-controls': 'account-panel', 'data-tip': 'Leverage, fees and slippage used by backtests and new live sessions. Click to open or close.' },
    h('span', { class: 'account-caret', 'aria-hidden': 'true' }, '▸'), h('span', { class: 'account-title' }, 'Money settings'), summary,
  );
  setExplain(accountToggle, ACCOUNT_TEXT.title, ACCOUNT_TEXT.on, ACCOUNT_TEXT.off);
  const extras = h('div', { class: 'extras' });
  const accountPanel = h(
    'div', { class: 'account-panel', id: 'account-panel', role: 'group', 'aria-label': 'Money settings' },
    field('Leverage (x)', leverage, undefined, FIELD_TEXT.leverage),
    field('Market fee %', takerFeePct, undefined, FIELD_TEXT.takerFee),
    field('Limit fee %', makerFeePct, undefined, FIELD_TEXT.makerFee),
    field('Slippage (bps)', slippageBps, undefined, FIELD_TEXT.slippage),
    extras,
    h('p', { class: 'account-note' }, 'These change how the pretend broker charges you. The defaults are close to a real exchange, so you can leave them alone.'),
  );
  const refreshSummary = () => {
    const s = accountSummary({ leverage: leverage.value, takerFeePct: takerFeePct.value, makerFeePct: makerFeePct.value, slippageBps: slippageBps.value }, usesBuiltInStrategy());
    summary.textContent = s.text;
    accountToggle.setAttribute('data-tip', `Leverage, fees and slippage used by backtests and new live sessions. Click to open or close. Now: ${s.text}.`);
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

  const coinField = field('Coin', symbol, undefined, FIELD_TEXT.symbol);
  coinField.setAttribute('data-tour', 'market');
  const tools = h('div', { class: 'tools' });
  const form = h(
    'form', { class: 'run-form' },
    h('div', { class: 'field' }, h('span', {}, 'Mode'), modeToggle),
    coinField, symbols,
    field('Candle size', timeframe, undefined, FIELD_TEXT.timeframe),
    field('Start date', startDate, 'backtest-only', FIELD_TEXT.startDate),
    field('Starting money', balance, undefined, FIELD_TEXT.balance),
    run,
    tools,
    accountToggle,
    accountPanel,
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
  for (const el of Object.values(fields)) el.addEventListener('input', () => el.removeAttribute('aria-invalid'));
  const showInvalid = (field: keyof RawSettings) => {
    const el = fields[field];
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
      runLabel(running ? 'Running…' : 'Run');
    },
  };
}
