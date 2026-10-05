import { CompileError, createBlockStrategy } from '../blocks/compiler';
import type { Candle } from '../data/types';
import { runBacktest, type BacktestResult, type EngineConfig } from '../engine/engine';
import { createSmaCross, type SmaCrossParams } from '../engine/strategies/smaCross';
import { StrategyError, type Strategy } from '../engine/strategy';

/**
 * Which strategy the worker should build. Block strategies travel as the saved workspace JSON and are compiled
 * inside the worker, so generated code only ever runs there. Pine strategies will be added as a new member.
 */
export type StrategySpec = { id: 'smaCross'; params: SmaCrossParams } | { id: 'blocks'; workspace: unknown };

export interface RunRequest {
  type: 'run';
  candles: Candle[];
  config: EngineConfig;
  strategy: StrategySpec;
}

export type WorkerResponse =
  | { type: 'result'; result: BacktestResult }
  /** `blockId`: the block to highlight, for block strategies. */
  | { type: 'error'; message: string; blockId?: string };

export function buildStrategy(spec: StrategySpec): Strategy {
  switch (spec.id) {
    case 'smaCross':
      return createSmaCross(spec.params);
    case 'blocks':
      return createBlockStrategy(spec.workspace);
  }
}

/** Pure request handler (the worker file is only glue), so it is testable without a Worker. */
export function handleRequest(request: RunRequest): WorkerResponse {
  try {
    const result = runBacktest(request.candles, buildStrategy(request.strategy), request.config);
    return { type: 'result', result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const blockId = err instanceof StrategyError || err instanceof CompileError ? err.blockId : undefined;
    return blockId === undefined ? { type: 'error', message } : { type: 'error', message, blockId };
  }
}
