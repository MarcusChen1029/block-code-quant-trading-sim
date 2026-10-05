import { describe, it, expect } from 'vitest';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { DEFAULT_SMA_CROSS } from '../engine/strategies/smaCross';
import { syntheticCandles } from '../engine/syntheticCandles';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { handleRequest, type RunRequest } from './protocol';

const request: RunRequest = {
  type: 'run',
  candles: syntheticCandles(300),
  config: { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG },
  strategy: { id: 'smaCross', params: DEFAULT_SMA_CROSS },
};

describe('handleRequest', () => {
  it('runs the SMA-cross backtest and returns a structured-clone-safe result', () => {
    const response = handleRequest(request);
    expect(response.type).toBe('result');
    if (response.type !== 'result') return;
    expect(response.result.barsProcessed).toBe(300);
    expect(response.result.trades.length).toBeGreaterThan(0);
    expect(structuredClone(response)).toEqual(response); // what postMessage will do
  });

  it('runs a block workspace and matches the built-in SMA cross trades', () => {
    const blocks = handleRequest({ ...request, strategy: { id: 'blocks', workspace: defaultWorkspace() } });
    const builtIn = handleRequest(request);
    if (blocks.type !== 'result' || builtIn.type !== 'result') throw new Error('both runs must succeed');
    expect(blocks.result.trades).toEqual(builtIn.result.trades);
    expect(structuredClone(blocks)).toEqual(blocks);
  });

  it('reports compile and runtime errors with the block id to highlight', () => {
    const noHat = handleRequest({ ...request, strategy: { id: 'blocks', workspace: { blocks: { blocks: [] } } } });
    expect(noHat).toEqual({ type: 'error', message: "Add a 'when a bar closes' block: it is where the strategy logic goes" });

    const ws = defaultWorkspace();
    ws.blocks!.blocks![1].next = {
      block: { type: 'action_set_exit', id: 'bad-sl', fields: { KIND: 'stopLoss' }, inputs: { PRICE: { block: { type: 'math_number', fields: { NUM: 0 } } } } },
    };
    expect(handleRequest({ ...request, strategy: { id: 'blocks', workspace: ws } })).toEqual({
      type: 'error', message: 'strategy error on bar 0: stop-loss price must be a positive number, got 0', blockId: 'bad-sl',
    });
  });

  it('returns errors instead of throwing', () => {
    const response = handleRequest({ ...request, strategy: { id: 'smaCross', params: { fast: 30, slow: 10, sizePct: 100 } } });
    expect(response).toEqual({ type: 'error', message: 'fast length must be less than slow length' });
  });
});
