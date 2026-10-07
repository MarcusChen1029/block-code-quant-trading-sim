import { TIMEFRAMES } from '../data/types';
import { accountSummary } from './accountSummary';
import { h } from './dom';
import type { RawSettings } from './settings';
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
  const run = h('button', { type: 'submit', class: 'run backtest-only' }, 'Run');

  const modeButtons: Array<[AppMode, HTMLButtonElement]> = [
    ['backtest', h('button', { type: 'button', title: 'Simulate the strategy over historical bars' }, 'Backtest')],
    ['live', h('button', { type: 'button', title: 'Paper-trade on the live Binance stream (fake money)' }, 'Live')],
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
  const modeToggle = h('div', { class: 'mode-toggle', role: 'group', 'aria-label': 'Mode' }, ...modeButtons.map(([, b]) => b));
  showMode(initialMode);

  const field = (label: string, el: HTMLElement, cls?: string, title?: string) => h('label', { class: cls, title }, h('span', {}, label), el);

  // Account settings: closed by default; the toggle carries the summary of the hidden values.
  const summary = h('span', { class: 'account-summary' });
  const accountToggle = h(
    'button', { type: 'button', class: 'account-toggle', 'aria-expanded': 'false', 'aria-controls': 'account-panel', title: 'Leverage, fees and slippage used by backtests and new live sessions' },
    h('span', { class: 'account-caret', 'aria-hidden': 'true' }, '▸'), h('span', { class: 'account-title' }, 'Account settings'), summary,
  );
  const extras = h('div', { class: 'extras' });
  const accountPanel = h(
    'div', { class: 'account-panel', id: 'account-panel', role: 'group', 'aria-label': 'Account settings' },
    field('Leverage', leverage, undefined, 'Notional cap = equity x leverage (1-125)'),
    field('Taker %', takerFeePct, undefined, 'Fee on market and stop fills, in percent'),
    field('Maker %', makerFeePct, undefined, 'Fee on limit and take-profit fills, in percent'),
    field('Slip bps', slippageBps, undefined, 'Slippage against you on market / stop fills, in basis points (1 bps = 0.01%)'),
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
  const form = h(
    'form', { class: 'run-form' },
    h('div', { class: 'field' }, h('span', {}, 'Mode'), modeToggle),
    field('Product', symbol), symbols,
    field('TF', timeframe),
    field('Start', startDate, 'backtest-only'),
    field('Balance', balance),
    run,
    tools,
    accountToggle,
    accountPanel,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    onRun();
  });
  container.append(form);
  setOpen(loadText(ACCOUNT_OPEN_STORAGE_KEY) === '1');
  refreshSummary();

  return {
    tools,
    extras,
    setMode: showMode,
    refreshSummary,
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
      run.textContent = running ? 'Running…' : 'Run';
    },
  };
}
