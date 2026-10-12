import { describe, it, expect } from 'vitest';
import { BT } from '../blocks/blockTypes';
import { createBlockStrategy } from '../blocks/compiler';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { getStarter } from '../blocks/starters';
import { compare, getVar, ifThen, indicator, num, price, setVar, value, workspace } from '../blocks/testing';
import type { BlockState } from '../blocks/workspaceState';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { walkCandles } from '../engine/fixtures';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { strategyHistoryNeed } from './warmup';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = walkCandles(300, 9, 0, 0.01);
const buyOne = (): BlockState => ({ type: BT.marketOrder, id: `buy-${Math.random()}`, fields: { SIDE: 'buy', UNIT: 'qty' }, inputs: { SIZE: { block: num(0.01) } } });
/** Buys a little on every bar where `cond` holds (it holds as soon as its value exists). */
const whenever = (cond: BlockState) => workspace({ onBar: [ifThen(cond, buyOne())] });
const fills = (ws: unknown, bars: number) => runBacktest(CANDLES.slice(0, bars), createBlockStrategy(ws), CONFIG).fills.length;

/** The claim must never be too low (need-1 bars: no fill) and here, where it is exact, not too high (need bars: a fill). */
function expectTight(ws: unknown, expected: number, label: string) {
  const need = strategyHistoryNeed(ws);
  expect(need).toEqual({ known: true, bars: expected, label });
  expect(fills(ws, expected - 1)).toBe(0);
  expect(fills(ws, expected)).toBeGreaterThan(0);
}

describe('strategyHistoryNeed (bars before the first order can fill)', () => {
  it('plain SMA 30: value from bar 29, order there, fill at bar 30 -> 31 bars', () => {
    expectTight(whenever(compare('GT', indicator('sma', { LENGTH: 30 }), num(0))), 31, 'SMA 30');
  });

  it('SMA 20 of RSI 14 chains the warm-ups: RSI from bar 14, its SMA from bar 33, fill at 34 -> 35 bars', () => {
    const rsi = indicator('rsi', { LENGTH: 14 });
    expectTight(whenever(compare('GT', indicator('sma', { LENGTH: 20 }, rsi), num(0))), 35, 'SMA 20 of RSI 14');
  });

  it('a price 50 bars ago needs 51 bars for the value + 1 to fill -> 52', () => {
    expectTight(whenever(compare('GT', price('close', 50), num(0))), 52, 'close 50 bars ago');
  });

  it('MACD 12 26 9 histogram -> 35 bars', () => {
    expectTight(whenever(compare('GT', { ...indicator('macd', { FAST: 12, SLOW: 26, SIGNAL: 9 }), fields: { OUT: 'hist', FAST: 12, SLOW: 26, SIGNAL: 9 } }, num(-1e9))), 35, 'MACD 12 26 9');
  });

  it('Bollinger 20 2 upper band -> 21 bars', () => {
    expectTight(whenever(compare('GT', { ...indicator('bb', {}), fields: { OUT: 'upper', LENGTH: 20, MULT: 2 } }, num(0))), 21, 'Bollinger 20 2');
  });

  it('the SMA 10/30 cross starter: a cross needs one more bar than SMA 30 -> 32, and never fills earlier', () => {
    const need = strategyHistoryNeed(defaultWorkspace());
    expect(need).toEqual({ known: true, bars: 32, label: 'SMA 30' });
    expect(fills(defaultWorkspace(), 31)).toBe(0);
  });

  // Zone indicators now get an "at least" number: zoneWarmup.test.ts.
  it('is unknown (no number) for Pine scripts, variables used as data and bar index', () => {
    const pine: BlockState = { type: 'ind_pine_abc', id: 'p', fields: { OUT: 'value' } };
    expect(strategyHistoryNeed(whenever(compare('GT', pine, num(0))))).toEqual({ known: false });
    const ws = workspace({
      onBar: [setVar('v', indicator('rsi', { LENGTH: 14 })), ifThen(compare('GT', indicator('sma', { LENGTH: 5 }, getVar('v')), num(0)), buyOne())],
      variables: [{ name: 'v', id: 'v' }],
    });
    expect(strategyHistoryNeed(ws)).toEqual({ known: false });
    expect(strategyHistoryNeed(whenever(compare('GT', value(BT.barIndex), num(100))))).toEqual({ known: false });
  });

  it('every non-zone starter has a known need that is never too low', () => {
    for (const id of ['rsiReversion', 'bbBreakout', 'supertrend', 'macdCross', 'buyHold'] as const) {
      const ws = getStarter(id)!.build();
      const need = strategyHistoryNeed(ws);
      expect(need.known, id).toBe(true);
      if (need.known) expect(fills(ws, need.bars - 1), id).toBe(0);
    }
  });
});
