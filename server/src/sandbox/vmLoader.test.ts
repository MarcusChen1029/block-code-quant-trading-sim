import { afterEach, describe, expect, it } from 'vitest';
import { createBlockStrategy, strategyFromProgram } from '../../../src/blocks/compiler';
import { STARTERS } from '../../../src/blocks/starters';
import { indicator, ifThen, num, slot, workspace } from '../../../src/blocks/testing';
import { BT } from '../../../src/blocks/blockTypes';
import type { BlockState } from '../../../src/blocks/workspaceState';
import { runBacktest, type EngineConfig } from '../../../src/engine/engine';
import { StrategyError } from '../../../src/engine/strategy';
import { syntheticCandles } from '../../../src/engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../../../src/engine/types';
import { compilePine, runPine } from '../../../src/pine/compile';
import { syncPineIndicators } from '../../../src/pine/library';
import { DOUBLE_EMA_SOURCE, PINE_TEMPLATES } from '../../../src/pine/templates';
import { setFactoryLoader } from '../../../src/sandbox/codeLoader';
import { createVmLoader } from './vmLoader';

afterEach(() => {
  setFactoryLoader(null);
  syncPineIndicators([]);
});

const load = createVmLoader();
const run = (body: string, ...args: unknown[]) => load(['h'], body)(...args);

class HostFailure extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = 'HostFailure';
  }
}

function hostObject() {
  return {
    n: 3,
    list: [1, 2, { deep: true }],
    nested: { value: 7 },
    fn: (x: number) => x * 2,
    boom: () => { throw new HostFailure('host says no', 42); },
    callWith: (cb: (o: unknown) => unknown) => cb({ secret: 'host object' }),
  };
}

describe('vm sandbox: direct escape attempts', () => {
  it('the realm has no process, require, fetch, timers or module loader', async () => {
    expect(run('return typeof process')).toBe('undefined');
    expect(run('return typeof require')).toBe('undefined');
    expect(run('return typeof module + typeof exports + typeof __dirname')).toBe('undefinedundefinedundefined');
    expect(run('return typeof globalThis.fetch')).toBe('undefined');
    expect(run('return typeof setTimeout + typeof console + typeof Buffer')).toBe('undefinedundefinedundefined');
    expect(run('return typeof globalThis.process')).toBe('undefined');
    const imported = run('return import("node:fs")') as Promise<unknown>;
    await expect(imported).rejects.toThrow();
  });

  it('this.constructor.constructor (and eval / Function) cannot compile code', () => {
    expect(() => run('return this.constructor.constructor("return process")()')).toThrow(/Code generation from strings disallowed/);
    expect(() => run('return Function("return process")()')).toThrow(/Code generation from strings disallowed/);
    expect(() => run('return eval("1 + 1")')).toThrow(/Code generation from strings disallowed/);
    expect(() => run('return (function(){}).constructor("return 1")()')).toThrow(/Code generation from strings disallowed/);
    expect(() => run('return (async function(){}).constructor("return 1")')).toThrow(/Code generation from strings disallowed/);
  });

  it('host objects never expose their constructor, prototype or realm', () => {
    const h = hostObject();
    expect(run('return h.constructor', h)).toBeUndefined();
    expect(run('return h.__proto__', h)).toBeUndefined();
    expect(run('return Object.getPrototypeOf(h)', h)).toBeNull();
    expect(run('return h.fn.constructor', h)).toBeUndefined();
    expect(run('return h.fn.call.constructor', h)).toBeUndefined();
    expect(run('return Reflect.getPrototypeOf(h.fn)', h)).toBeNull();
    expect(run('return h.list.constructor', h)).toBeUndefined();
    expect(run('return h.nested.constructor === undefined && h.list[2].constructor === undefined', h)).toBe(true);
    // Everything the sandbox gets is a vm-realm value: its constructors are the vm's, which cannot compile code.
    expect(() => run('return h.list.map.call.bind.constructor', h)).not.toThrow();
    expect(() => run('return h.list.map(function(x){return x}).constructor.constructor("return process")()', h)).toThrow(TypeError);
    expect(() => run('const f = h.fn.bind(null); return Object.getPrototypeOf(f)', h)).not.toThrow();
  });

  it('host callbacks hand the sandbox proxies, never raw host objects', () => {
    const h = hostObject();
    expect(run('return h.callWith(function (o) { return [o.secret, o.constructor, Object.getPrototypeOf(o)] })', h)).toEqual(['host object', undefined, null]);
    expect(() => run('return h.callWith(function (o) { return o.constructor.constructor("return process")() })', h)).toThrow(TypeError);
  });

  it('errors: host errors keep their identity, caught ones are vm errors, vm errors become host Errors', () => {
    const h = hostObject();
    let thrown: unknown;
    try {
      run('h.boom()', h);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HostFailure);
    expect((thrown as HostFailure).code).toBe(42);
    expect(() => run('try { h.boom() } catch (e) { return e.constructor.constructor("return process")() }', h)).toThrow(/Code generation/);
    expect(run('try { h.boom() } catch (e) { return [e.message, e.name, e.code] }', h)).toEqual(['host says no', 'HostFailure', undefined]);
    let vmErr: unknown;
    try {
      run('null.x');
    } catch (err) {
      vmErr = err;
    }
    expect(vmErr).toBeInstanceOf(Error);
    expect((vmErr as Error).name).toBe('TypeError');
    expect((vmErr as Error).message).toMatch(/Cannot read properties of null/);
  });

  it('built-ins are frozen: the membrane cannot be patched, prepareStackTrace cannot be hooked', () => {
    expect(() => run('"use strict"; WeakMap.prototype.get = function () {}')).toThrow(TypeError);
    expect(() => run('"use strict"; Reflect.apply = function () {}')).toThrow(TypeError);
    expect(() => run('"use strict"; Error.prepareStackTrace = function (e, s) { return s }')).toThrow(TypeError);
    expect(() => run('"use strict"; Object.prototype.get = function () {}')).toThrow(TypeError);
    expect(() => run('"use strict"; globalThis.leak = 1')).toThrow(TypeError);
    const h = hostObject();
    expect(run('return h.fn(21)', h)).toBe(42); // still works after the attempts
  });

  it('the sandbox can read and write data through proxies (arrays, nested objects, setters)', () => {
    const out = [0, 0];
    const h = { out, obj: { a: 1 } };
    run('h.out[0] = 5; h.out[1] = h.out.length; h.obj.a = h.obj.a + 1', h);
    expect(out).toEqual([5, 2]);
    expect(h.obj.a).toBe(2);
    expect(run('return Array.isArray(h.out) && Object.keys(h.obj).join()', h)).toBe('a');
    expect(run('h.obj.__proto__ = null; h.obj.constructor = 1; return Object.keys(h.obj)', h)).toEqual(['a']);
    expect(Object.getPrototypeOf(h.obj)).toBe(Object.prototype);
  });
});

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = syntheticCandles(500);

describe('vm sandbox: generated code paths', () => {
  it('a block program cannot reach process/require/the host realm through rt, ctx or this', () => {
    setFactoryLoader(createVmLoader());
    const probes = [
      'typeof process', 'typeof require', 'typeof fetch', 'String(this && this.process)',
      'typeof rt.constructor', 'typeof rt.indicator.constructor', 'typeof ctx.candle.constructor', 'typeof ctx.buy.constructor',
      'String(Object.getPrototypeOf(rt))',
    ];
    const seen: unknown[] = [];
    const program = {
      source: `return { init: function (ctx) {}, onBar: function (ctx) { ctx.log([${probes.join(', ')}].join('|')); } };`,
      blockIds: ['b0'], maxOffset: 0, indicators: [], warnings: [],
    };
    const strategy = strategyFromProgram(program as never);
    const result = runBacktest(CANDLES.slice(0, 2), { onBar: (ctx) => { strategy.onBar({ ...ctx, log: (m: string) => seen.push(m) } as never); } }, CONFIG);
    expect(result.trades).toEqual([]);
    expect(seen[0]).toBe('undefined|undefined|undefined|undefined|undefined|undefined|undefined|undefined|null');
  });

  it('an escape attempt through generated code fails as a strategy error naming the block', () => {
    setFactoryLoader(createVmLoader());
    const program = {
      source: 'return { init: function () {}, onBar: function (ctx) { rt.at(0); return this.constructor.constructor("return process")(); } };',
      blockIds: ['evil-block'], maxOffset: 0, indicators: [], warnings: [],
    };
    const strategy = strategyFromProgram(program as never);
    let err: unknown;
    try {
      runBacktest(CANDLES.slice(0, 3), strategy, CONFIG);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StrategyError);
    expect((err as StrategyError).blockId).toBe('evil-block');
    expect((err as StrategyError).message).toMatch(/Code generation from strings disallowed/);
  });

  it('per-bar iteration limits still stop runaway loops inside the sandbox', () => {
    setFactoryLoader(createVmLoader());
    const program = {
      source: 'return { init: function () {}, onBar: function (ctx) { rt.beginBar(ctx); while (true) { rt.loop(0); } } };',
      blockIds: ['loop-block'], maxOffset: 0, indicators: [], warnings: [],
    };
    expect(() => runBacktest(CANDLES.slice(0, 2), strategyFromProgram(program as never), CONFIG)).toThrow(/more than 10,000 loop iterations/);
  });
});

const order = (side: 'buy' | 'sell'): BlockState => ({
  type: BT.marketOrder, id: `order-${side}`, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: slot(num(100)) },
});
const crosses = (op: 'over' | 'under', a: BlockState, b: BlockState): BlockState => ({
  type: BT.crosses, id: `x-${op}`, fields: { OP: op }, inputs: { A: slot(a), B: slot(b) },
});

describe('vm sandbox: results identical to the browser loader', () => {
  it('every starter strategy backtests identically', () => {
    for (const starter of STARTERS) {
      const plain = runBacktest(CANDLES, createBlockStrategy(starter.build()), CONFIG);
      setFactoryLoader(createVmLoader());
      const sandboxed = runBacktest(CANDLES, createBlockStrategy(starter.build()), CONFIG);
      setFactoryLoader(null);
      expect(JSON.stringify(sandboxed), starter.id).toBe(JSON.stringify(plain));
    }
  });

  it('a Pine indicator block strategy and every Pine template give identical outputs', () => {
    const dema = (which: 'fast' | 'slow') => indicator('pine_double_ema', { OUT: `${which}_ema`, FASTLENGTH: 9, SLOWLENGTH: 21 });
    const ws = workspace({ onBar: [ifThen(crosses('over', dema('fast'), dema('slow')), order('buy')), ifThen(crosses('under', dema('fast'), dema('slow')), order('sell'))] });
    const records = [{ id: 'pine_double_ema', source: DOUBLE_EMA_SOURCE }];
    syncPineIndicators(records);
    const plain = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const plainPine = PINE_TEMPLATES.map((t) => { const c = compilePine(t.source); return c.ok ? runPine(c.script, CANDLES) : c.errors; });
    setFactoryLoader(createVmLoader());
    syncPineIndicators(records);
    const sandboxed = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const sandboxedPine = PINE_TEMPLATES.map((t) => { const c = compilePine(t.source); return c.ok ? runPine(c.script, CANDLES) : c.errors; });
    expect(plain.trades.length).toBeGreaterThan(0);
    expect(JSON.stringify(sandboxed)).toBe(JSON.stringify(plain));
    expect(JSON.stringify(sandboxedPine)).toBe(JSON.stringify(plainPine));
  });
});
