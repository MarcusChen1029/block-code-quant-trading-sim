import { describe, it, expect } from 'vitest';
import { BT } from '../blocks/blockTypes';
import { createBlockStrategy } from '../blocks/compiler';
import { getStarter } from '../blocks/starters';
import { compare, ifThen, indicator, num, signal, workspace } from '../blocks/testing';
import type { BlockState } from '../blocks/workspaceState';
import type { Candle } from '../data/types';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { walkCandles } from '../engine/fixtures';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { strategyHistoryNeed } from './warmup';

/**
 * Zone indicators have no fixed warm-up (a zone needs the price to make it), but each has a STRUCTURAL minimum: the
 * first bar on which any of its values could exist. The claim must never be too high for the history check (with
 * need - 1 bars no order can ever fill, on any data) and is tight on data built to form a zone as early as possible.
 */
const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const HOUR = 3_600_000;
const buyOne = (): BlockState => ({ type: BT.marketOrder, id: `buy-${Math.random()}`, fields: { SIDE: 'buy', UNIT: 'qty' }, inputs: { SIZE: { block: num(0.01) } } });
const whenever = (cond: BlockState) => workspace({ onBar: [ifThen(cond, buyOne())] });
const fills = (ws: unknown, candles: Candle[]) => runBacktest(candles, createBlockStrategy(ws), CONFIG).fills.length;
/** Bars from [open, high, low, close] rows. */
const bars = (rows: Array<[number, number, number, number]>): Candle[] =>
  rows.map(([open, high, low, close], i) => ({ time: i * HOUR, open, high, low, close, volume: 1 }));
const RANDOM = Array.from({ length: 25 }, (_, seed) => walkCandles(80, seed + 1, 0, 0.03));

function expectNeverTooHigh(ws: unknown, need: number) {
  for (const candles of RANDOM) expect(fills(ws, candles.slice(0, need - 1))).toBe(0);
}

describe('zone warm-up (structural minimum, "at least")', () => {
  it('swing structure L/R: a pivot is first confirmed on bar L+R, the order fills one bar later -> L+R+2 bars', () => {
    const ws = whenever(signal('swing', 'high_confirmed', { LEFT: 2, RIGHT: 2 }, null));
    expect(strategyHistoryNeed(ws)).toEqual({ known: true, bars: 6, label: 'Swing structure 2/2', atLeast: true });
    expectNeverTooHigh(ws, 6);
    // Highs 1 2 5 2 1: bar 2 is a pivot high, confirmed on bar 4's close; the buy fills on bar 5.
    const peak = bars([[1, 1, 0.5, 1], [1, 2, 0.5, 1.5], [1.5, 5, 1, 2], [2, 2, 1, 1.5], [1.5, 1, 0.5, 0.8], [0.8, 1, 0.5, 0.9]]);
    expect(fills(ws, peak.slice(0, 5))).toBe(0);
    expect(fills(ws, peak)).toBe(1);
  });

  it('swing outputs (last swing high) have the same minimum', () => {
    const ws = whenever(compare('GT', { ...indicator('swing', { LEFT: 3, RIGHT: 1 }, null), fields: { OUT: 'last_high', LEFT: 3, RIGHT: 1 } }, num(0)));
    expect(strategyHistoryNeed(ws)).toEqual({ known: true, bars: 6, label: 'Swing structure 3/1', atLeast: true });
    expectNeverTooHigh(ws, 6);
  });

  it('order block (swing S): swing confirmed on bar 2S, broken at the earliest on bar 2S+1, fill one later -> 2S+3', () => {
    const ws = whenever(signal('orderblock', 'new_bull', { SWING: 2, LOOKBACK: 10, USE_BODY: 0, MAX_AGE: 300, MAX_ACTIVE: 5 }, null));
    expect(strategyHistoryNeed(ws)).toEqual({ known: true, bars: 7, label: 'Order block (swing 2)', atLeast: true });
    expectNeverTooHigh(ws, 7);
    // Pivot high 5 on bar 2 (confirmed on bar 4); bar 3 is bearish; bar 5 closes at 6 > 5: bullish block on bar 5,
    // the buy fills on bar 6. Only 5 earlier bars exist, fewer than the lookback of 10: the search uses what exists.
    const ob = bars([[1, 1, 0.5, 1], [1, 2, 0.5, 1.5], [1.5, 5, 1, 2], [2.5, 2.6, 1.4, 1.5], [1.5, 1, 0.5, 0.8], [0.8, 6.5, 0.7, 6], [6, 6.2, 5.8, 6.1]]);
    expect(fills(ws, ob.slice(0, 6))).toBe(0);
    expect(fills(ws, ob)).toBe(1);
  });

  it('fair value gap: three candles -> known on bar 2, fill on bar 3 -> 4 bars', () => {
    const ws = whenever(signal('fvg', 'new_bull', { MIN_GAP_PCT: 0, MAX_AGE: 300, MAX_ACTIVE: 5 }, null));
    expect(strategyHistoryNeed(ws)).toEqual({ known: true, bars: 4, label: 'Fair value gap', atLeast: true });
    expectNeverTooHigh(ws, 4);
    const gap = bars([[9, 10, 8, 9.5], [9.5, 12, 9.4, 11.8], [11.8, 13, 11, 12.5], [12.5, 13, 12, 12.8]]);
    expect(fills(ws, gap.slice(0, 3))).toBe(0);
    expect(fills(ws, gap)).toBe(1);
  });

  it('a zone next to a slower built-in: the slower one wins, still "at least"', () => {
    const ws = whenever({
      type: 'logic_operation', id: 'and', fields: { OP: 'AND' },
      inputs: {
        A: { block: signal('fvg', 'in_bull', { MIN_GAP_PCT: 0, MAX_AGE: 300, MAX_ACTIVE: 5 }, null) },
        B: { block: compare('GT', indicator('sma', { LENGTH: 30 }), num(0)) },
      },
    });
    expect(strategyHistoryNeed(ws)).toEqual({ known: true, bars: 31, label: 'SMA 30', atLeast: true });
  });

  it('the zone example starter gets an "at least" number from its order block and FVG (never too high)', () => {
    const ws = getStarter('zones')!.build();
    const need = strategyHistoryNeed(ws);
    expect(need).toMatchObject({ known: true, atLeast: true });
    if (need.known) {
      expect(need.bars).toBeGreaterThanOrEqual(4);
      expectNeverTooHigh(ws, need.bars);
    }
  });

  it('Pine scripts stay unknown (arbitrary code: no static warm-up)', () => {
    const pine: BlockState = { type: 'ind_pine_abc', id: 'p', fields: { OUT: 'value' } };
    expect(strategyHistoryNeed(whenever(compare('GT', pine, num(0))))).toEqual({ known: false });
  });
});
