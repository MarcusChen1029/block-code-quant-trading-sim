import { describe, it, expect } from 'vitest';
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

  it('returns errors instead of throwing', () => {
    const response = handleRequest({ ...request, strategy: { id: 'smaCross', params: { fast: 30, slow: 10, sizePct: 100 } } });
    expect(response).toEqual({ type: 'error', message: 'fast length must be less than slow length' });
  });
});
