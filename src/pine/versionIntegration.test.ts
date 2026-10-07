import { afterEach, describe, it, expect } from 'vitest';
import { BT } from '../blocks/blockTypes';
import { compileBlocks, createBlockStrategy } from '../blocks/compiler';
import { getIndicator } from '../blocks/registry';
import { indicator, ifThen, num, price, slot, workspace } from '../blocks/testing';
import type { BlockState } from '../blocks/workspaceState';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { blockIndicatorOverlays } from '../ui/blockOverlays';
import { computeOverlaySeries } from '../ui/overlays';
import { handleRequest } from '../worker/protocol';
import { syncPineIndicators } from './library';
import { RSI_MA_V4_SOURCE, SUPERTREND_SOURCE, SUPERTREND_V6_SOURCE } from './templates';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };
const CANDLES = syntheticCandles(600);
const V4 = { id: 'pine_rsi_ma_v4', source: RSI_MA_V4_SOURCE };
const V6 = { id: 'pine_supertrend_v6', source: SUPERTREND_V6_SOURCE };
const V5 = { id: 'pine_supertrend', source: SUPERTREND_SOURCE };

afterEach(() => {
  syncPineIndicators([]);
});

const crosses = (op: 'over' | 'under', a: BlockState, b: BlockState): BlockState => ({
  type: BT.crosses, id: `x-${op}`, fields: { OP: op }, inputs: { A: slot(a), B: slot(b) },
});
const order = (side: 'buy' | 'sell'): BlockState => ({
  type: BT.marketOrder, id: `order-${side}`, fields: { SIDE: side, UNIT: 'percentEquity' }, inputs: { SIZE: slot(num(100)) },
});

/** RSI crossing its MA (v4 block): buy over, sell under. */
const rsiWorkspace = () => {
  const line = (out: 'rsi' | 'rsi_ma') => indicator(V4.id, { OUT: out, RSILENGTH: 14, MALENGTH: 9 });
  return workspace({ onBar: [ifThen(crosses('over', line('rsi'), line('rsi_ma')), order('buy')), ifThen(crosses('under', line('rsi'), line('rsi_ma')), order('sell'))] });
};
/** Price crossing the Supertrend line (any version's block). */
const supertrendWorkspace = (id: string) => {
  const st = () => indicator(id, { OUT: 'supertrend', ATRLENGTH: 10, FACTOR: 3 }, price('hl2'));
  return workspace({ onBar: [ifThen(crosses('over', price(), st()), order('buy')), ifThen(crosses('under', price(), st()), order('sell'))] });
};

describe('END-TO-END: Pine v4 and v6 scripts as indicator blocks', () => {
  it('both register as blocks (params from inputs, outputs from plots)', () => {
    const results = syncPineIndicators([V4, V6]);
    expect(results.map((r) => [r.id, r.ok, r.title])).toEqual([[V4.id, true, 'RSI + MA (v4)'], [V6.id, true, 'Supertrend (v6)']]);
    const v4 = getIndicator(V4.id)!;
    expect([v4.pane, v4.source, v4.params.map((p) => p.name), v4.outputs.map((o) => o.key)]).toEqual(['sub', 'close', ['rsilength', 'malength'], ['rsi', 'rsi_ma']]);
    const v6 = getIndicator(V6.id)!;
    expect([v6.pane, v6.source, v6.outputs.map((o) => o.key)]).toEqual(['price', 'hl2', ['supertrend', 'up_trend', 'down_trend']]);
  });

  it('v4 RSI + MA block: a block strategy backtests deterministically, and its plots are drawn', () => {
    syncPineIndicators([V4]);
    const ws = rsiWorkspace();
    const compiled = compileBlocks(ws);
    if (!compiled.ok) throw new Error(compiled.errors[0].message);
    const a = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const b = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(b.trades).toEqual(a.trades);
    expect(b.fills).toEqual(a.fills);
    const [overlay] = blockIndicatorOverlays(compiled.program.indicators);
    expect(overlay.pane).toBe('sub');
    const drawn = computeOverlaySeries(overlay, CANDLES);
    expect(overlay.lines.map((l) => l.key)).toEqual(['rsi', 'rsi_ma']);
    expect(drawn.rsi.filter((p) => 'value' in p).length).toBeGreaterThan(550);
    expect(drawn.rsi_ma.filter((p) => 'value' in p).length).toBeGreaterThan(550);
  });

  it('v6 Supertrend block: deterministic trades, identical to the v5 Supertrend block; its plot is drawn', () => {
    syncPineIndicators([V6, V5]);
    const ws = supertrendWorkspace(V6.id);
    const compiled = compileBlocks(ws);
    if (!compiled.ok) throw new Error(compiled.errors[0].message);
    const a = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const b = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(b.trades).toEqual(a.trades);
    expect(runBacktest(CANDLES, createBlockStrategy(supertrendWorkspace(V5.id)), CONFIG).trades).toEqual(a.trades);
    const [overlay] = blockIndicatorOverlays(compiled.program.indicators);
    expect(overlay.pane).toBe('price');
    expect(computeOverlaySeries(overlay, CANDLES).supertrend.filter((p) => 'value' in p).length).toBeGreaterThan(500);
  });

  it('the worker compiles v4 and v6 sources it is sent', () => {
    for (const [script, ws] of [[V4, rsiWorkspace()], [V6, supertrendWorkspace(V6.id)]] as const) {
      const response = handleRequest({ type: 'run', candles: CANDLES, config: CONFIG, strategy: { id: 'blocks', workspace: ws, pineScripts: [script] } });
      expect(response.type, script.id).toBe('result');
      if (response.type === 'result') expect(response.result.trades.length).toBeGreaterThan(3);
    }
  });
});
