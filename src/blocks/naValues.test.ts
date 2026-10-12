import { describe, it, expect } from 'vitest';
import { runBacktest, type BacktestResult, type EngineConfig } from '../engine/engine';
import { Engine } from '../engine/engine';
import { walkCandles } from '../engine/fixtures';
import { StrategyError } from '../engine/strategy';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { BT } from './blockTypes';
import { createBlockStrategy } from './compiler';
import { indicatorBlockType } from './registry';
import { compare, ifThen, num, price, slot, value, workspace } from './testing';
import type { BlockState, WorkspaceState } from './workspaceState';
import { zoneExampleWorkspace } from './zoneExample';

/**
 * `na` (NaN) reaching a stop-loss / take-profit price, a limit price or an order size skips THAT action with a warning
 * (once per block, then counts at 10, 100, ...) and the run goes on. Finite invalid values (<= 0, Infinity) still halt
 * the run with the block id. The broker contract is untouched (src/engine/baseline.test.ts).
 */
const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = syntheticCandles(60);
/** A price 1000 bars ago: na on every bar of a 60-bar run. */
const NA = () => price('close', 1000);
const run = (ws: WorkspaceState, candles = CANDLES): BacktestResult => runBacktest(candles, createBlockStrategy(ws), CONFIG);
const warnings = (r: BacktestResult) => r.log.filter((l) => l.level === 'warn').map((l) => l.message);

/** 1 / 0 = Infinity. */
const INF = (id: string): BlockState => ({ type: 'math_arithmetic', id, fields: { OP: 'DIVIDE' }, inputs: { A: slot(num(1)), B: slot(num(0)) } });
const setExit = (id: string, kind: 'stopLoss' | 'takeProfit', priceBlock: BlockState): BlockState =>
  ({ type: BT.setExit, id, fields: { KIND: kind }, inputs: { PRICE: slot(priceBlock) } });
const market = (id: string, size: BlockState): BlockState =>
  ({ type: BT.marketOrder, id, fields: { SIDE: 'buy', UNIT: 'qty' }, inputs: { SIZE: slot(size) } });
const limit = (id: string, size: BlockState, at: BlockState): BlockState =>
  ({ type: BT.limitOrder, id, fields: { SIDE: 'buy', UNIT: 'qty' }, inputs: { SIZE: slot(size), PRICE: slot(at) } });

describe('na into stop / limit / size', () => {
  it('a stop-loss at na is skipped with ONE warning naming the block, then counted; the run completes', () => {
    const r = run(workspace({ onBar: [setExit('sl', 'stopLoss', NA())] }));
    expect(r.barsProcessed).toBe(60);
    expect(warnings(r)).toEqual([
      "set stop-loss skipped: its price is na (no value), so no stop-loss is set — block 'set stop-loss / take-profit' (id sl). Further skips by this block are only counted.",
      "set stop-loss skipped 10 times so far: its price is na (any previous stop-loss stays in place) — block 'set stop-loss / take-profit' (id sl).",
    ]);
    expect(r.log.filter((l) => l.level === 'warn')[0].bar).toBe(0);
  });

  it('a take-profit, a limit price and an order size at na: each skipped with its own warning, nothing reaches the broker', () => {
    const r = run(workspace({
      onBar: [setExit('tp', 'takeProfit', NA()), limit('lim', num(1), NA()), market('mkt', NA())],
    }), CANDLES.slice(0, 5));
    expect(warnings(r)).toEqual([
      "set take-profit skipped: its price is na (no value), so no take-profit is set — block 'set stop-loss / take-profit' (id tp). Further skips by this block are only counted.",
      "limit order skipped: its limit price is na (no value) — block 'limit order' (id lim). Further skips by this block are only counted.",
      "market order skipped: its size is na (no value) — block 'market order' (id mkt). Further skips by this block are only counted.",
    ]);
    expect(r.activity.orderRequests).toBe(0);
    expect(r.fills).toEqual([]);
  });

  it('only the na action is skipped: the next valid order of the same block fills', () => {
    // Size = close 3 bars ago: na on bars 0-2, a number from bar 3 on.
    const sized = { ...market('m', price('close', 3)), fields: { SIDE: 'buy', UNIT: 'usdt' } };
    const r = run(workspace({ onBar: [ifThen(compare('LT', value(BT.barIndex), num(5)), sized)] }), CANDLES.slice(0, 8));
    expect(warnings(r)).toHaveLength(1);
    expect(r.activity.orderRequests).toBe(2); // bars 3 and 4
    expect(r.fills.map((f) => f.bar)).toEqual([4, 5]);
  });

  it('a skipped stop-loss keeps the PREVIOUS one (safer than removing it) and says so', () => {
    // The na block runs before any stop exists (first warning: none set); then a stop at 50 is set and later na skips keep it.
    const r = run(workspace({ onBar: [setExit('slna', 'stopLoss', NA()), setExit('sl50', 'stopLoss', num(50))] }), CANDLES.slice(0, 5));
    expect(r.finalPosition.stopLoss).toBe(50);
    expect(warnings(r)[0]).toBe("set stop-loss skipped: its price is na (no value), so no stop-loss is set — block 'set stop-loss / take-profit' (id slna). Further skips by this block are only counted.");
    const r2 = run(workspace({ onBar: [setExit('sl50', 'stopLoss', num(50)), setExit('slna', 'stopLoss', NA())] }), CANDLES.slice(0, 5));
    expect(warnings(r2)[0]).toBe("set stop-loss skipped: its price is na (no value), so the previous stop-loss (50) stays in place — block 'set stop-loss / take-profit' (id slna). Further skips by this block are only counted.");
    expect(r2.finalPosition.stopLoss).toBe(50);
  });

  const halts: Array<[string, BlockState, string, string]> = [
    ['stop-loss at 0', setExit('sl0', 'stopLoss', num(0)), 'sl0', 'stop-loss price must be a positive number, got 0'],
    ['take-profit at -1', setExit('tp1', 'takeProfit', num(-1)), 'tp1', 'take-profit price must be a positive number, got -1'],
    ['stop-loss at Infinity', setExit('slInf', 'stopLoss', INF('inf')), 'slInf', 'stop-loss price must be a positive number, got Infinity'],
    ['limit at -5', limit('lim5', num(1), num(-5)), 'lim5', 'limit order needs a positive price'],
    ['size 0', market('size0', num(0)), 'size0', 'order size must be a positive number, got 0'],
    ['size Infinity', market('sizeInf', INF('inf2')), 'sizeInf', 'order size must be a positive number, got Infinity'],
  ];
  for (const [name, block, id, message] of halts) {
    it(`a finite invalid value still halts the run with the block id: ${name}`, () => {
      try {
        run(workspace({ onBar: [block] }));
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(StrategyError);
        expect((err as StrategyError).message).toBe(`strategy error on bar 0: ${message}`);
        expect((err as StrategyError).blockId).toBe(id);
      }
    });
  }

  it('live warm-up bars log nothing, and the first warning comes on the first trading bar', () => {
    const engine = new Engine(createBlockStrategy(workspace({ onBar: [setExit('sl', 'stopLoss', NA())] })), CONFIG);
    for (const c of CANDLES.slice(0, 5)) engine.pushWarmupCandle(c);
    expect(engine.log.filter((l) => l.level === 'warn')).toEqual([]);
    engine.pushCandle(CANDLES[5]);
    expect(engine.log.filter((l) => l.level === 'warn').map((l) => l.bar)).toEqual([5]);
  });

  it('the zone example with its na guard removed and a stop-loss at the FVG bottom runs to the end', () => {
    // Guard removed: buy whenever the bar is inside a bullish order block (no "FVG bottom > 0"), and set the stop-loss
    // at the nearest bullish FVG bottom, which is na whenever no gap is active.
    const ws = zoneExampleWorkspace();
    const entry = ws.blocks!.blocks![1].next!.block!;
    const and1 = entry.inputs!.IF0.block!;
    and1.inputs!.A = { block: and1.inputs!.A.block!.inputs!.A.block! }; // in bullish OB (the FVG guard is gone)
    const stop: BlockState = setExit('zx-stop', 'stopLoss', {
      type: indicatorBlockType('fvg'), id: 'zx-stop-fvg', fields: { OUT: 'bull_bottom', MIN_GAP_PCT: 0.05, MAX_AGE: 300, MAX_ACTIVE: 5 },
    });
    entry.inputs!.DO0.block!.next = { block: stop };
    const candles = walkCandles(1500, 7, 0.0002, 0.012);
    const r = runBacktest(candles, createBlockStrategy(ws), CONFIG);
    expect(r.barsProcessed).toBe(candles.length);
    expect(r.fills.length).toBeGreaterThan(0);
    const w = warnings(r);
    expect(w[0]).toMatch(/^set stop-loss skipped: its price is na \(no value\), so (no stop-loss is set|the previous stop-loss \([0-9.]+\) stays in place) — block 'set stop-loss \/ take-profit' \(id zx-stop\)\. Further skips by this block are only counted\.$/);
    expect(w.every((m) => m.includes('(id zx-stop)'))).toBe(true);
  });
});
