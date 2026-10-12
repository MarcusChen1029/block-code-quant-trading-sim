import { describe, it, expect } from 'vitest';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { walkCandles } from '../engine/fixtures';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { BT } from './blockTypes';
import { createBlockStrategy } from './compiler';
import { num, slot, workspace } from './testing';
import type { BlockState } from './workspaceState';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = walkCandles(5);
const logs = (expr: BlockState): string[] => {
  const log: BlockState = { type: BT.log, id: 'log', inputs: { MSG: slot(expr) } };
  return runBacktest(CANDLES, createBlockStrategy(workspace({ onBar: [log] })), CONFIG).log.filter((l) => l.level === 'info').map((l) => l.message);
};
const blk = (type: string, fields: Record<string, unknown>, inputs: Record<string, BlockState>): BlockState =>
  ({ type, id: type, fields, inputs: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, slot(v)])) });

describe('extra math blocks', () => {
  it('remainder, constrain, trig (degrees)', () => {
    expect(logs(blk('math_modulo', {}, { DIVIDEND: num(10), DIVISOR: num(3) }))[0]).toBe('1');
    expect(logs(blk('math_constrain', {}, { VALUE: num(500), LOW: num(1), HIGH: num(100) }))[0]).toBe('100');
    expect(logs(blk('math_trig', { OP: 'COS' }, { NUM: num(0) }))[0]).toBe('1');
    expect(Number(logs(blk('math_trig', { OP: 'ASIN' }, { NUM: num(1) }))[0])).toBeCloseTo(90, 9);
  });

  it('random fraction is in [0,1), random integer stays in range (either order) and repeats between runs', () => {
    const f = logs(blk('math_random_float', {}, {})).map(Number);
    expect(f).toHaveLength(5);
    for (const v of f) expect(v >= 0 && v < 1).toBe(true);
    const ints = logs(blk('math_random_int', {}, { FROM: num(10), TO: num(1) })).map(Number);
    for (const v of ints) expect(Number.isInteger(v) && v >= 1 && v <= 10).toBe(true);
    expect(new Set(f).size).toBeGreaterThan(1);
    expect(logs(blk('math_random_float', {}, {}))).toEqual(f.map(String));
  });
});
