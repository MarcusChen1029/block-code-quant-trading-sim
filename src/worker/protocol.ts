import type { Candle } from '../data/types';
import { runBacktest, type BacktestResult, type EngineConfig } from '../engine/engine';
import { createSmaCross, type SmaCrossParams } from '../engine/strategies/smaCross';
import type { Strategy } from '../engine/strategy';

/** Which strategy the worker should build. Blocks/Pine strategies will be added as new union members. */
export type StrategySpec = { id: 'smaCross'; params: SmaCrossParams };

export interface RunRequest {
  type: 'run';
  candles: Candle[];
  config: EngineConfig;
  strategy: StrategySpec;
}

export type WorkerResponse = { type: 'result'; result: BacktestResult } | { type: 'error'; message: string };

export function buildStrategy(spec: StrategySpec): Strategy {
  switch (spec.id) {
    case 'smaCross':
      return createSmaCross(spec.params);
  }
}

/** Pure request handler (the worker file is only glue), so it is testable without a Worker. */
export function handleRequest(request: RunRequest): WorkerResponse {
  try {
    const result = runBacktest(request.candles, buildStrategy(request.strategy), request.config);
    return { type: 'result', result };
  } catch (err) {
    return { type: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}
