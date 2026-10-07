import * as Blockly from 'blockly';
import { afterEach, beforeAll, describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { BollingerBands } from '../indicators/bands';
import { Macd, Rsi, Stochastic } from '../indicators/oscillators';
import { Supertrend } from '../indicators/supertrend';
import { blocksSnapshot, snapshotToSpec } from '../live/session';
import { SessionEngine } from '../live/sessionEngine';
import { runPine } from '../pine/compile';
import { syncPineIndicators } from '../pine/library';
import { EMA_CROSS_SIGNALS_SOURCE, SUPERTREND_SOURCE } from '../pine/templates';
import { compileOk } from '../pine/testing';
import { buildStrategy, handleRequest } from '../worker/protocol';
import { BT } from './blockTypes';
import { compileBlocks, createBlockStrategy } from './compiler';
import { defineBlocks, defineMissingIndicatorBlocks, indicatorBlockJson, signalBlockJson } from './definitions';
import { getIndicator, signalBlockType } from './registry';
import { compare, ifThen, indicator, log, num, price, signal, slot, value, workspace } from './testing';
import { buildToolbox } from './toolbox';
import { fixupIndicatorBlocks } from './workspaceFixup';
import type { BlockState } from './workspaceState';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = syntheticCandles(600).map((c, i) => ({ ...c, close: c.close + (i % 11) * 0.4 - 2 }));
const EMA_SIG = { id: 'pine_ema_cross_signals', source: EMA_CROSS_SIGNALS_SOURCE };

beforeAll(() => defineBlocks());
afterEach(() => {
  syncPineIndicators([]);
});

const crosses = (op: 'over' | 'under', a: BlockState, b: BlockState): BlockState => ({
  type: BT.crosses, id: `x-${op}-${Math.random()}`, fields: { OP: op }, inputs: { A: slot(a), B: slot(b) },
});
const order = (side: 'buy' | 'sell'): BlockState => ({
  type: BT.marketOrder, id: `order-${side}-${Math.random()}`, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: slot(num(100)) },
});
const and = (a: BlockState, b: BlockState): BlockState => ({ type: 'logic_operation', id: `and-${Math.random()}`, fields: { OP: 'AND' }, inputs: { A: slot(a), B: slot(b) } });
const or = (a: BlockState, b: BlockState): BlockState => ({ type: 'logic_operation', id: `or-${Math.random()}`, fields: { OP: 'OR' }, inputs: { A: slot(a), B: slot(b) } });
const not = (a: BlockState): BlockState => ({ type: 'logic_negate', id: `not-${Math.random()}`, inputs: { BOOL: slot(a) } });
const st = (key: 'buy' | 'sell') => signal('supertrend', key, { LENGTH: 10, FACTOR: 3 }, price('hl2'));

function logs(ws: unknown, candles = CANDLES): string[] {
  return runBacktest(candles, createBlockStrategy(ws), CONFIG).log.filter((l) => l.level === 'info').map((l) => l.message);
}

/** Native Supertrend reference: buy / sell flips per bar. */
function supertrendFlips(candles: Candle[]) {
  const s = new Supertrend(10, 3);
  return candles.map((c) => s.update((c.high + c.low) / 2, c));
}

describe('sig_ blocks: definition', () => {
  it('a Boolean block with a dropdown of the signals, the same SOURCE input and params (plus signal-only ones)', () => {
    const json = signalBlockJson(getIndicator('supertrend')!);
    expect(json.type).toBe('sig_supertrend');
    expect(json.output).toBe('Boolean');
    const args = json.args0 as Array<Record<string, unknown>>;
    expect(args.find((a) => a.name === 'SIGOUT')?.options).toEqual([['Buy (trend flips up)', 'buy'], ['Sell (trend flips down)', 'sell']]);
    expect(args.filter((a) => a.type === 'input_value').map((a) => a.name)).toEqual(['SOURCE']);
    expect(args.filter((a) => a.type === 'field_number').map((a) => a.name)).toEqual(['LENGTH', 'FACTOR']);
    // RSI: overbought / oversold only on the signal block; the numeric block is unchanged.
    const rsi = getIndicator('rsi')!;
    const fields = (j: Record<string, unknown>) => (j.args0 as Array<Record<string, unknown>>).filter((a) => a.type === 'field_number').map((a) => a.name);
    expect(fields(indicatorBlockJson(rsi))).toEqual(['LENGTH']);
    expect(fields(signalBlockJson(rsi))).toEqual(['LENGTH', 'OVERBOUGHT', 'OVERSOLD']);
  });

  it('headless Blockly creates it with a Boolean output; the toolbox lists numeric and signal blocks', () => {
    const ws = new Blockly.Workspace();
    const block = ws.newBlock('sig_supertrend');
    expect(block.outputConnection?.getCheck()).toEqual(['Boolean']);
    expect(block.getFieldValue('SIGOUT')).toBe('buy');
    ws.dispose();
    const indicators = buildToolbox().contents.find((c) => c.name === 'Indicators')!.contents!.map((b) => (b.kind === 'block' ? b.type : ''));
    for (const t of ['ind_supertrend', 'sig_supertrend', 'sig_macd', 'sig_rsi', 'sig_bb', 'sig_stoch', 'ind_rsi']) expect(indicators).toContain(t);
    expect(indicators).not.toContain('sig_sma');
  });

  it('a Pine script with signals gets ind_ and sig_ blocks in the Pine category; one with only signals gets only sig_', () => {
    syncPineIndicators([EMA_SIG, { id: 'pine_only', source: '//@version=5\nindicator("Only")\nplotshape(close > open, "Up")\n' }]);
    defineBlocks();
    const pine = buildToolbox().contents.find((c) => c.name === 'Pine')!.contents!.map((b) => (b.kind === 'block' ? b.type : ''));
    expect(pine).toEqual(['ind_pine_ema_cross_signals', 'sig_pine_ema_cross_signals', 'sig_pine_only']);
    expect(Blockly.Blocks.sig_pine_only).toBeDefined();
    // A saved ind_ block of the signal-only script becomes a missing placeholder instead of breaking the load.
    const saved = workspace({ onBar: [log(indicator('pine_only', {})), log(signal('pine_only', 'up', {}))] });
    const { missingTypes } = fixupIndicatorBlocks(saved);
    expect(missingTypes).toEqual(['ind_pine_only']);
    const result = compileBlocks(saved);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0].message).toMatch(/has no numeric outputs any more/);
  });

  it('a deleted script leaves a Boolean placeholder for its sig_ block and a clear compile error', () => {
    syncPineIndicators([], [{ id: 'pine_gone', title: 'Gone' }]);
    defineMissingIndicatorBlocks(['sig_pine_gone']);
    const ws = new Blockly.Workspace();
    expect(ws.newBlock('sig_pine_gone').outputConnection?.getCheck()).toEqual(['Boolean']);
    ws.dispose();
    const result = compileBlocks(workspace({ onBar: [log(signal('pine_gone', 'x'))] }));
    expect(!result.ok && result.errors[0].message).toMatch(/^Pine script "Gone" is missing/);
  });

  it('an unknown signal value is a compile error naming the block', () => {
    const result = compileBlocks(workspace({ onBar: [log(signal('supertrend', 'constructor'))] }));
    expect(!result.ok && result.errors[0].message).toBe('Supertrend: unknown signal "constructor"');
  });
});

describe('sig_ blocks: compile and run', () => {
  it('a strategy trading Supertrend Buy/Sell signals equals one trading crosses of its direction output', () => {
    const viaSignals = workspace({ onBar: [ifThen(st('buy'), order('buy')), ifThen(st('sell'), order('sell'))] });
    const direction = () => indicator('supertrend', { OUT: 'direction', LENGTH: 10, FACTOR: 3 }, price('hl2'));
    const viaNumbers = workspace({
      onBar: [ifThen(crosses('over', direction(), num(0)), order('buy')), ifThen(crosses('under', direction(), num(0)), order('sell'))],
    });
    const a = runBacktest(CANDLES, createBlockStrategy(viaSignals), CONFIG);
    const b = runBacktest(CANDLES, createBlockStrategy(viaNumbers), CONFIG);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(a.trades).toEqual(b.trades);
    expect(a.fills).toEqual(b.fills);
  });

  it('hoisting: a signal block inside an if that is not taken still updates every bar', () => {
    const flips = supertrendFlips(CANDLES);
    const firstBuy = flips.findIndex((f) => f.flippedUp);
    const firstSell = flips.findIndex((f) => f.flippedDown);
    expect(firstBuy).toBeGreaterThan(20);
    for (const n of [firstBuy, firstSell, firstBuy + 1]) {
      const ws = workspace({ onBar: [ifThen(compare('EQ', value(BT.barIndex), num(n)), log(st('buy')), log(st('sell')))] });
      expect(logs(ws), `bar ${n}`).toEqual([String(flips[n].flippedUp), String(flips[n].flippedDown)]);
    }
  });

  it('signal blocks compose with and / or / not and with crosses of numeric blocks', () => {
    const flips = supertrendFlips(CANDLES);
    const macd = new Macd(12, 26, 9);
    const m = CANDLES.map((c) => macd.update(c.close));
    const ws = workspace({
      onBar: [
        ifThen(or(st('buy'), st('sell')), log({ type: 'text', id: 't1', fields: { TEXT: 'flip' } })),
        ifThen(and(not(st('buy')), signal('macd', 'bull_cross', { FAST: 12, SLOW: 26, SIGNAL: 9 })), log({ type: 'text', id: 't2', fields: { TEXT: 'macd' } })),
        ifThen(and(st('buy'), crosses('over', price(), num(-1))), log({ type: 'text', id: 't3', fields: { TEXT: 'never' } })),
      ],
    });
    const expected: string[] = [];
    flips.forEach((f, i) => {
      if (f.flippedUp || f.flippedDown) expected.push('flip');
      const bull = i > 0 && m[i - 1].macd <= m[i - 1].signal && m[i].macd > m[i].signal;
      if (!f.flippedUp && bull) expected.push('macd');
    });
    expect(expected.filter((e) => e === 'macd').length).toBeGreaterThan(2);
    expect(logs(ws)).toEqual(expected);
  });

  it('a Pine plotshape signal (EMA cross template) trades like the same strategy built from built-in EMA crosses', () => {
    syncPineIndicators([EMA_SIG]);
    const sig = (key: string) => signal('pine_ema_cross_signals', key, { FASTLENGTH: 9, SLOWLENGTH: 21 }, null);
    const viaPine = workspace({ onBar: [ifThen(sig('buy'), order('buy')), ifThen(sig('sell'), order('sell'))] });
    const ema = (n: number) => indicator('ema', { LENGTH: n });
    const viaEma = workspace({ onBar: [ifThen(crosses('over', ema(9), ema(21)), order('buy')), ifThen(crosses('under', ema(9), ema(21)), order('sell'))] });
    const a = runBacktest(CANDLES, createBlockStrategy(viaPine), CONFIG);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(a.trades).toEqual(runBacktest(CANDLES, createBlockStrategy(viaEma), CONFIG).trades);
  });

  it('reports signal uses (indicator + signal key) so the chart can mark them', () => {
    const result = compileBlocks(workspace({ onBar: [ifThen(st('buy'), order('buy'))] }));
    if (!result.ok) throw new Error(result.errors[0].message);
    expect(result.program.indicators).toEqual([
      { indicatorId: 'supertrend', params: { length: 10, factor: 3 }, source: 'hl2', drawable: true, blockId: expect.any(String), signals: ['buy'] },
    ]);
  });
});

describe('built-in signals vs hand-written references', () => {
  const stepAll = (id: string, params: Record<string, number>, src: (c: Candle) => number = (c) => c.close) => {
    const inst = getIndicator(id)!.create(params);
    return CANDLES.map((c) => inst.step(src(c), c));
  };
  const crossUp = (a: number[], b: number[]) => a.map((v, i) => (i > 0 && a[i - 1] <= b[i - 1] && v > b[i] ? 1 : 0));
  const crossDown = (a: number[], b: number[]) => a.map((v, i) => (i > 0 && a[i - 1] >= b[i - 1] && v < b[i] ? 1 : 0));
  const count = (xs: number[]) => xs.filter(Boolean).length;

  it('native Supertrend equals the Pine Supertrend template numerically; Buy/Sell are its trend flips', () => {
    const native = stepAll('supertrend', { length: 10, factor: 3 }, (c) => (c.high + c.low) / 2);
    const pine = runPine(compileOk(SUPERTREND_SOURCE), CANDLES);
    expect(native.map((v) => v.line)).toEqual(pine.supertrend);
    // The template plots the upper band only in a down trend (bands are na during the ATR warm-up, trend 1).
    expect(native.map((v) => v.direction)).toEqual(pine.down_trend.map((d) => (Number.isNaN(d) ? 1 : -1)));
    const dir = native.map((v) => v.direction);
    expect(native.map((v) => v.buy)).toEqual(dir.map((d, i) => (i > 0 && dir[i - 1] === -1 && d === 1 ? 1 : 0)));
    expect(native.map((v) => v.sell)).toEqual(dir.map((d, i) => (i > 0 && dir[i - 1] === 1 && d === -1 ? 1 : 0)));
    expect(count(native.map((v) => v.buy))).toBeGreaterThan(3);
  });

  it('MACD bullish / bearish crosses of the line over / under the signal line', () => {
    const macd = new Macd(12, 26, 9);
    const ref = CANDLES.map((c) => macd.update(c.close));
    const out = stepAll('macd', { fast: 12, slow: 26, signal: 9 });
    const line = ref.map((r) => r.macd);
    const sig = ref.map((r) => r.signal);
    expect(out.map((o) => o.bull_cross)).toEqual(crossUp(line, sig));
    expect(out.map((o) => o.bear_cross)).toEqual(crossDown(line, sig));
    expect(count(crossUp(line, sig))).toBeGreaterThan(3);
  });

  it('RSI crossed above oversold / below overbought (levels are signal-only params; defaults 30 / 70)', () => {
    const rsi = new Rsi(14);
    const r = CANDLES.map((c) => rsi.update(c.close));
    for (const [ob, os] of [[70, 30], [60, 40]]) {
      const out = stepAll('rsi', { length: 14, overbought: ob, oversold: os });
      expect(out.map((o) => o.up_oversold)).toEqual(crossUp(r, r.map(() => os)));
      expect(out.map((o) => o.down_overbought)).toEqual(crossDown(r, r.map(() => ob)));
      expect(count(crossUp(r, r.map(() => os))) + count(crossDown(r, r.map(() => ob)))).toBeGreaterThan(1);
    }
    // The numeric block passes no levels: the defaults apply and the value is unchanged.
    expect(stepAll('rsi', { length: 14 }).map((o) => o.value)).toEqual(r);
    expect(stepAll('rsi', { length: 14 }).map((o) => o.up_oversold)).toEqual(crossUp(r, r.map(() => 30)));
  });

  it('Bollinger: close crosses above the upper / below the lower band', () => {
    const bb = new BollingerBands(20, 2);
    const ref = CANDLES.map((c) => bb.update(c.close));
    const closes = CANDLES.map((c) => c.close);
    const out = stepAll('bb', { length: 20, mult: 2 });
    expect(out.map((o) => o.above_upper)).toEqual(crossUp(closes, ref.map((r) => r.upper)));
    expect(out.map((o) => o.below_lower)).toEqual(crossDown(closes, ref.map((r) => r.lower)));
    expect(count(out.map((o) => o.above_upper)) + count(out.map((o) => o.below_lower))).toBeGreaterThan(1);
  });

  it('Stochastic: %K crosses above / below %D', () => {
    const s = new Stochastic(14, 1, 3);
    const ref = CANDLES.map((c) => s.update(c));
    const k = ref.map((r) => r.k);
    const d = ref.map((r) => r.d);
    const out = stepAll('stoch', { k: 14, smooth: 1, d: 3 });
    expect(out.map((o) => o.k_over_d)).toEqual(crossUp(k, d));
    expect(out.map((o) => o.k_under_d)).toEqual(crossDown(k, d));
    expect(count(crossUp(k, d))).toBeGreaterThan(3);
  });
});

describe('worker and live paths', () => {
  const sigWs = () => {
    const sig = (key: string) => signal('pine_ema_cross_signals', key, { FASTLENGTH: 9, SLOWLENGTH: 21 }, null);
    return workspace({ onBar: [ifThen(sig('buy'), order('buy')), ifThen(sig('sell'), order('sell'))] });
  };

  it('the backtest worker registers the Pine signal script from the sources it is sent', () => {
    syncPineIndicators([]); // the worker realm starts empty
    const response = handleRequest({ type: 'run', candles: CANDLES, config: CONFIG, strategy: { id: 'blocks', workspace: sigWs(), pineScripts: [EMA_SIG] } });
    expect(response.type).toBe('result');
    if (response.type === 'result') expect(response.result.trades.length).toBeGreaterThan(3);
  });

  it('a live session (session engine fed bar by bar, built from its snapshot) trades exactly like the backtest', () => {
    syncPineIndicators([]);
    const snapshot = blocksSnapshot(sigWs(), [EMA_SIG], []);
    const def = { symbol: 'BTCUSDT', timeframe: '1h' as const, brokerConfig: DEFAULT_BROKER_CONFIG, startTime: CANDLES[0].time, warmupBars: 0 };
    const engine = new SessionEngine(def, buildStrategy(snapshotToSpec(snapshot)), undefined);
    for (const c of CANDLES) expect(engine.push(c)).toBe('processed');
    const live = engine.result();
    const backtest = runBacktest(CANDLES, buildStrategy(snapshotToSpec(snapshot)), CONFIG);
    expect(live.trades.length).toBeGreaterThan(3);
    expect(live.trades).toEqual(backtest.trades);
  });
});

it('signalBlockType names the Boolean block', () => {
  expect(signalBlockType('rsi')).toBe('sig_rsi');
});
