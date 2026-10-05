import { describe, it, expect } from 'vitest';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { createSmaCross, DEFAULT_SMA_CROSS } from '../engine/strategies/smaCross';
import { StrategyError } from '../engine/strategy';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { Sma } from '../indicators/averages';
import { BT } from './blockTypes';
import { CompileError, compileBlocks, createBlockStrategy, strategyFromProgram } from './compiler';
import { defaultWorkspace } from './defaultWorkspace';
import { DEFAULT_LIMITS } from './runtime';
import {
  changeVar, compare, getVar, ifThen, indicator, log, num, price, repeat, setVar, slot, text, value, workspace,
} from './testing';
import type { WorkspaceState } from './workspaceState';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = syntheticCandles(600);

/** Runs a block workspace and returns the strategy's log messages (one per ctx.log call). */
function logs(ws: WorkspaceState, candles = CANDLES.slice(0, 40)): string[] {
  return runBacktest(candles, createBlockStrategy(ws), CONFIG).log.filter((l) => l.level === 'info').map((l) => l.message);
}

function compileErrors(ws: WorkspaceState) {
  const result = compileBlocks(ws);
  if (result.ok) throw new Error('expected compile errors');
  return result.errors;
}

describe('block compiler: equivalence with the hard-coded SMA cross', () => {
  it('the default workspace yields an identical trade list, fills and final position', () => {
    const blocks = runBacktest(CANDLES, createBlockStrategy(defaultWorkspace()), CONFIG);
    const builtIn = runBacktest(CANDLES, createSmaCross(DEFAULT_SMA_CROSS), CONFIG);
    expect(builtIn.trades.length).toBeGreaterThan(5);
    expect(blocks.trades).toEqual(builtIn.trades);
    expect(blocks.fills).toEqual(builtIn.fills);
    expect(blocks.finalPosition).toEqual(builtIn.finalPosition);
    expect(blocks.equityCurve).toEqual(builtIn.equityCurve);
  });

  it('also matches with leverage, other fees and a different candle fixture', () => {
    const candles = syntheticCandles(900, 1_700_000_000_000, 900_000).map((c, i) => ({ ...c, close: c.close + (i % 7) * 0.3 }));
    const config: EngineConfig = { ...CONFIG, broker: { ...DEFAULT_BROKER_CONFIG, leverage: 3, takerFee: 0.001, slippageBps: 5 } };
    const blocks = runBacktest(candles, createBlockStrategy(defaultWorkspace()), config);
    const builtIn = runBacktest(candles, createSmaCross(DEFAULT_SMA_CROSS), config);
    expect(blocks.trades).toEqual(builtIn.trades);
  });

  it('is deterministic: same workspace and candles give identical results twice', () => {
    const a = runBacktest(CANDLES, createBlockStrategy(defaultWorkspace()), CONFIG);
    const b = runBacktest(CANDLES, createBlockStrategy(defaultWorkspace()), CONFIG);
    expect(a).toEqual(b);
    expect(compileBlocks(defaultWorkspace())).toEqual(compileBlocks(defaultWorkspace()));
  });

  it('reports the indicators it uses so the chart can draw them', () => {
    const result = compileBlocks(defaultWorkspace());
    if (!result.ok) throw new Error('default workspace must compile');
    expect(result.program.indicators.map((u) => [u.indicatorId, u.params.length, u.source, u.drawable])).toEqual([
      ['sma', 10, 'close', true], ['sma', 30, 'close', true], ['sma', 10, 'close', true], ['sma', 30, 'close', true],
    ]);
  });
});

describe('block compiler: indicator state (hoisting rule)', () => {
  it('an indicator inside an if that is not taken still updates on every bar', () => {
    const ws = workspace({
      onBar: [ifThen(compare('EQ', value(BT.barIndex), num(10)), log(indicator('sma', { LENGTH: 3 })))],
    });
    const sma = new Sma(3);
    const expected = CANDLES.slice(0, 11).map((c) => sma.update(c.close))[10];
    expect(Number.isNaN(expected)).toBe(false);
    expect(logs(ws)).toEqual([String(expected)]);
  });

  it('nested indicators are evaluated in dependency order (SMA of RSI)', () => {
    const ws = workspace({
      onBar: [ifThen(compare('EQ', value(BT.barIndex), num(30)), log(indicator('sma', { LENGTH: 2 }, indicator('rsi', { LENGTH: 5 }))))],
    });
    const out = logs(ws);
    expect(out).toHaveLength(1);
    expect(Number(out[0])).toBeGreaterThan(0);
    expect(Number(out[0])).toBeLessThan(100);
  });

  it('multi-output indicators read the selected output', () => {
    const at = (out: string) => ifThen(compare('EQ', value(BT.barIndex), num(39)), log({ ...indicator('bb', { LENGTH: 20, MULT: 2 }), fields: { LENGTH: 20, MULT: 2, OUT: out } }));
    const [upper, middle, lower] = logs(workspace({ onBar: [at('upper'), at('middle'), at('lower')] })).map(Number);
    expect(upper).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(lower);
    expect(upper - middle).toBeCloseTo(middle - lower, 9);
  });
});

describe('block compiler: crosses, history, variables', () => {
  it('crosses over / under use the previous bar of both sides', () => {
    const cross = (op: string) => ({ type: BT.crosses, id: `x-${op}`, fields: { OP: op }, inputs: { A: slot(price()), B: slot(num(100)) } });
    const ws = workspace({
      onBar: [ifThen(cross('over'), log(text('over'))), ifThen(cross('under'), log(text('under')))],
    });
    const candles = CANDLES.slice(0, 120);
    const expected: string[] = [];
    for (let i = 1; i < candles.length; i++) {
      const [prev, cur] = [candles[i - 1].close, candles[i].close];
      if (prev <= 100 && cur > 100) expected.push('over');
      if (prev >= 100 && cur < 100) expected.push('under');
    }
    expect(expected.length).toBeGreaterThan(4);
    expect(logs(ws, candles)).toEqual(expected);
  });

  it('`n bars ago` reads a ring buffer sized from the largest offset', () => {
    const ws = workspace({ onBar: [log(price('close', 3)), log(price('hl2', 1))] });
    const result = compileBlocks(ws);
    expect(result.ok && result.program.maxOffset).toBe(3);
    const candles = CANDLES.slice(0, 12);
    const expected = candles.flatMap((_, i) => [
      i >= 3 ? String(candles[i - 3].close) : 'na',
      i >= 1 ? String((candles[i - 1].high + candles[i - 1].low) / 2) : 'na',
    ]);
    expect(logs(ws, candles)).toEqual(expected);
  });

  it('variables persist across bars and are initialised once in "when strategy starts"', () => {
    const ws = workspace({
      init: [setVar('v1', num(100))],
      onBar: [changeVar('v1', num(1)), log(getVar('v1'))],
      variables: [{ name: 'counter', id: 'v1' }],
    });
    expect(logs(ws, CANDLES.slice(0, 5))).toEqual(['101', '102', '103', '104', '105']);
  });

  it('functions take inputs and return values', () => {
    const def = {
      type: 'procedures_defreturn', id: 'def-double',
      extraState: { params: [{ name: 'x', id: 'px' }] },
      fields: { NAME: 'double it' },
      inputs: { RETURN: slot({ type: 'math_arithmetic', id: 'mul', fields: { OP: 'MULTIPLY' }, inputs: { A: slot(getVar('px')), B: slot(num(2)) } }) },
    };
    const call = { type: 'procedures_callreturn', id: 'call', extraState: { name: 'double it', params: ['x'] }, inputs: { ARG0: slot(value(BT.barIndex)) } };
    expect(logs(workspace({ onBar: [log(call)], extra: [def], variables: [{ name: 'x', id: 'px' }] }), CANDLES.slice(0, 3))).toEqual(['0', '2', '4']);
  });
});

describe('block compiler: safety', () => {
  it('a repeat may run 10,000 iterations per bar but not more; the error names the block', () => {
    const ok = workspace({ onBar: [repeat(10_000, [changeVar('v', num(1))])], variables: [{ name: 'n', id: 'v' }] });
    expect(() => logs(ok, CANDLES.slice(0, 2))).not.toThrow();
    const tooMany = workspace({ onBar: [repeat(10_001, [changeVar('v', num(1))], 'big-loop')], variables: [{ name: 'n', id: 'v' }] });
    let caught: unknown;
    try {
      logs(tooMany, CANDLES.slice(0, 2));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StrategyError);
    expect((caught as StrategyError).blockId).toBe('big-loop');
    expect((caught as StrategyError).message).toBe('strategy error on bar 0: more than 10,000 loop iterations in one bar');
  });

  it('the iteration budget is shared by all loops in a bar and resets every bar', () => {
    const ws = workspace({ onBar: [repeat(6000, []), repeat(6000, [], 'second')] });
    expect(() => logs(ws, CANDLES.slice(0, 1))).toThrow(/more than 10,000/);
    const fine = workspace({ onBar: [repeat(9000, [])] });
    expect(() => logs(fine, CANDLES.slice(0, 5))).not.toThrow();
  });

  it('a bar that runs too long is stopped (time limit)', () => {
    let clock = 0;
    const limits = { ...DEFAULT_LIMITS, maxBarMs: 50, now: () => (clock += 10) };
    const result = compileBlocks(workspace({ onBar: [repeat(5000, [], 'slow')] }));
    if (!result.ok) throw new Error('should compile');
    const strategy = strategyFromProgram(result.program, limits);
    expect(() => runBacktest(CANDLES.slice(0, 2), strategy, CONFIG)).toThrow(/took longer than 50 ms/);
  });

  it('log text is escaped: quotes, backslashes, template syntax and line separators come out verbatim', () => {
    const nasty = '"); throw new Error("pwned"); //\\ `${1+1}` </script>\u2028\u2029\n\'';
    expect(logs(workspace({ onBar: [log(text(nasty))] }), CANDLES.slice(0, 1))).toEqual([nasty]);
  });

  it('variable and function names never reach the generated code', () => {
    const evil = 'x"]; globalThis.hacked = 1; //';
    const def = { type: 'procedures_defnoreturn', id: 'def-evil', fields: { NAME: evil }, inputs: {} };
    const call = { type: 'procedures_callnoreturn', id: 'call-evil', extraState: { name: evil, params: [] } };
    const ws = workspace({ onBar: [setVar('ve', num(1)), call], extra: [def], variables: [{ name: evil, id: 've' }] });
    const result = compileBlocks(ws);
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(result.program.source).not.toContain('hacked');
    expect(() => logs(ws, CANDLES.slice(0, 2))).not.toThrow();
    expect((globalThis as Record<string, unknown>).hacked).toBeUndefined();
  });

  it('a runtime error halts the run and carries the offending block id', () => {
    const badOrder = { type: BT.limitOrder, id: 'bad-limit', fields: { SIDE: 'buy', UNIT: 'qty' }, inputs: { SIZE: slot(num(1)), PRICE: slot(num(-5)) } };
    const ws = workspace({ onBar: [ifThen(compare('EQ', value(BT.barIndex), num(3)), badOrder)] });
    expect(() => logs(ws)).toThrow('strategy error on bar 3: limit order needs a positive price');
    try {
      logs(ws);
    } catch (err) {
      expect(err).toBeInstanceOf(StrategyError);
      expect((err as StrategyError).blockId).toBe('bad-limit');
      expect((err as StrategyError).bar).toBe(3);
    }
  });

  it('stop-loss needs a positive price (NaN halts with the block id instead of silently doing nothing)', () => {
    const sl = { type: BT.setExit, id: 'sl', fields: { KIND: 'stopLoss' }, inputs: { PRICE: slot(indicator('sma', { LENGTH: 50 })) } };
    try {
      logs(workspace({ onBar: [sl] }));
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as StrategyError).message).toBe('strategy error on bar 0: stop-loss price must be a positive number, got NaN');
      expect((err as StrategyError).blockId).toBe('sl');
    }
  });
});

describe('block compiler: compile errors', () => {
  it('requires a "when a bar closes" block', () => {
    expect(compileErrors(workspace({ init: [log(text('hi'))] }))).toEqual([
      { message: "Add a 'when a bar closes' block: it is where the strategy logic goes" },
    ]);
  });

  it('reports empty inputs against the block that has them', () => {
    const empty = { type: 'logic_compare', id: 'half-compare', fields: { OP: 'GT' }, inputs: { A: slot(price()) } };
    const errors = compileErrors(workspace({ onBar: [ifThen(empty, log(text('x')))] }));
    expect(errors).toEqual([{ message: "'logic compare': the right slot is empty", blockId: 'half-compare' }]);
    expect(() => createBlockStrategy(workspace({ onBar: [ifThen(empty)] }))).toThrow(CompileError);
  });

  it('reports a missing indicator source, bad lengths, duplicate hats and unknown blocks', () => {
    const noSource = indicator('ema', { LENGTH: 5 }, null);
    const zero = indicator('sma', { LENGTH: 0 });
    const ws = workspace({ onBar: [log(noSource), log(zero), log(value('mystery_block'))] });
    ws.blocks!.blocks!.push({ type: BT.bar, id: 'second-hat' });
    const messages = compileErrors(ws).map((e) => [e.message, e.blockId]);
    expect(messages).toEqual([
      ['Only one \'when a bar closes\' block is allowed', 'second-hat'],
      ["'EMA': the source slot is empty", noSource.id],
      ['SMA length must be a whole number from 1 to 5000', zero.id],
      ['Unknown or unsupported block "mystery_block"', expect.any(String)],
    ]);
  });

  it('function inputs and calls are refused inside indicator inputs', () => {
    const def = {
      type: 'procedures_defnoreturn', id: 'def-p', extraState: { params: [{ name: 'p', id: 'vp' }] }, fields: { NAME: 'f' },
      inputs: { STACK: { block: log(indicator('sma', { LENGTH: 3 }, getVar('vp'))) } },
    };
    const errors = compileErrors(workspace({ onBar: [], extra: [def], variables: [{ name: 'p', id: 'vp' }] }));
    expect(errors[0].message).toMatch(/function input can't be used inside indicator/);
  });

  it('warns about stray blocks and about variables read by hoisted inputs', () => {
    const result = compileBlocks(workspace({
      onBar: [log(indicator('sma', { LENGTH: 3 }, getVar('v')))],
      extra: [log(text('stray'), 'stray')],
      variables: [{ name: 'v', id: 'v' }],
    }));
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.blockId ?? '')).toContain('stray');
    expect(result.warnings.some((w) => /previous bar/.test(w.message))).toBe(true);
  });

  it('skips disabled blocks', () => {
    const disabled = { ...log(text('off')), disabledReasons: ['MANUALLY_DISABLED'] };
    expect(logs(workspace({ onBar: [disabled, log(text('on'))] }), CANDLES.slice(0, 1))).toEqual(['on']);
  });

  it('survives garbage input without throwing', () => {
    for (const junk of [null, 42, 'x', { blocks: 'nope' }, { blocks: { blocks: [null, 7, { type: 5 }] } }]) {
      expect(compileBlocks(junk).ok).toBe(false);
    }
  });
});
