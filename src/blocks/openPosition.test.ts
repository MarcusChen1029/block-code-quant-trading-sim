import { describe, it, expect } from 'vitest';
import { runBacktest, type BacktestResult, type EngineConfig } from '../engine/engine';
import { walkCandles } from '../engine/fixtures';
import { StrategyError } from '../engine/strategy';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { BT } from './blockTypes';
import { createBlockStrategy } from './compiler';
import { generateProgram } from './generator';
import { ifThen, compare, num, price, slot, value, workspace } from './testing';
import type { BlockState } from './workspaceState';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: { ...DEFAULT_BROKER_CONFIG, leverage: 10 } };
const CANDLES = walkCandles(30, 1, 0, 0.0005);
const run = (block: BlockState, candles = CANDLES): BacktestResult => runBacktest(candles, createBlockStrategy(workspace({ onBar: [block] })), CONFIG);

const open = (id: string, side: 'buy' | 'sell', eq: BlockState, lev: BlockState, sl: BlockState, tp: BlockState): BlockState => ({
  type: BT.openPosition, id, fields: { SIDE: side },
  inputs: { EQUITY: slot(eq), LEVERAGE: slot(lev), STOP: slot(sl), TAKE: slot(tp) },
});
const onFirstBar = (b: BlockState) => ifThen(compare('EQ', value(BT.barIndex), num(0)), b);

describe('open position block', () => {
  it('sizes notional = equity x % x leverage and sets stop / take-profit around the close', () => {
    const r = run(onFirstBar(open('op', 'buy', num(10), num(5), num(2), num(4))), CANDLES.slice(0, 3));
    expect(r.fills).toHaveLength(1);
    const f = r.fills[0];
    expect((f.qty * f.price) / (DEFAULT_BROKER_CONFIG.initialBalance * 0.1 * 5)).toBeCloseTo(1, 1);
    expect(r.finalPosition.stopLoss).toBeCloseTo(CANDLES[0].close * 0.98, 6);
    expect(r.finalPosition.takeProfit).toBeCloseTo(CANDLES[0].close * 1.04, 6);
  });

  it('a short puts the stop above and the target below; 0 means none', () => {
    const r = run(onFirstBar(open('op', 'sell', num(10), num(1), num(2), num(0))), CANDLES.slice(0, 3));
    expect(r.finalPosition.stopLoss).toBeCloseTo(CANDLES[0].close * 1.02, 6);
    expect(r.finalPosition.takeProfit).toBeNull();
  });

  it('an na input skips the block with a warning; an invalid one halts naming the block', () => {
    const na = price('close', 1000);
    const skipped = run(open('op', 'buy', num(10), num(1), na, num(0)), CANDLES.slice(0, 3));
    expect(skipped.fills).toEqual([]);
    expect(skipped.log.filter((l) => l.level === 'warn').map((l) => l.message)).toEqual([
      "open position skipped: its stop-loss % is na (no value) — block 'open position' (id op). Further skips by this block are only counted.",
    ]);
    let err: unknown;
    try { run(open('op', 'buy', num(10), num(0.5), num(2), num(4)), CANDLES.slice(0, 3)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(StrategyError);
    expect((err as StrategyError).blockId).toBe('op');
  });

  it('an empty slot is a compile error naming the slot', () => {
    const block: BlockState = { type: BT.openPosition, id: 'op', fields: { SIDE: 'buy' }, inputs: {} };
    const res = generateProgram(workspace({ onBar: [block] }));
    expect(res.ok).toBe(false);
  });
});
