import { TIMEFRAMES } from '../data/types';
import { h } from './dom';
import type { RawSettings } from './settings';

export interface TopBar {
  read(): RawSettings;
  setRunning(running: boolean): void;
  /** Element where extra controls (the overlay picker) can be appended. */
  readonly extras: HTMLElement;
}

/** Builds the run form: product, timeframe, start date, balance, leverage, fees, slippage, Run. */
export function createTopBar(container: HTMLElement, initial: RawSettings, onRun: () => void): TopBar {
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
  const run = h('button', { type: 'submit', class: 'run' }, 'Run');

  const field = (label: string, el: HTMLElement) => h('label', {}, h('span', {}, label), el);
  const form = h(
    'form', { class: 'run-form' },
    field('Product', symbol), symbols,
    field('TF', timeframe),
    field('Start', startDate),
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
