import { TIMEFRAMES } from '../data/types';
import { h } from './dom';
import type { RawSettings } from './settings';

export interface TopBar {
  read(): RawSettings;
  setRunning(running: boolean): void;
  /** Element where extra controls (the overlay picker) can be appended. */
  readonly extras: HTMLElement;
  setMode(mode: AppMode): void;
}

/** Backtest: run over history. Live: paper-trade sessions on the live stream (start date and Run do not apply). */
export type AppMode = 'backtest' | 'live';

/** Builds the run form: product, timeframe, start date, balance, leverage, fees, slippage, Run. */
export function createTopBar(
  container: HTMLElement,
  initial: RawSettings,
  onRun: () => void,
  initialMode: AppMode = 'backtest',
  onMode: (mode: AppMode) => void = () => {},
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

  const field = (label: string, el: HTMLElement, cls?: string) => h('label', { class: cls }, h('span', {}, label), el);
  const form = h(
    'form', { class: 'run-form' },
    h('div', { class: 'field' }, h('span', {}, 'Mode'), modeToggle),
    field('Product', symbol), symbols,
    field('TF', timeframe),
    field('Start', startDate, 'backtest-only'),
    field('Balance', balance),
    field('Leverage', leverage),
    field('Taker %', takerFeePct),
    field('Maker %', makerFeePct),
    field('Slip bps', slippageBps),
    run,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    onRun();
  });
  const extras = h('div', { class: 'extras' });
  container.append(form, extras);

  return {
    extras,
    setMode: showMode,
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
