import type { BacktestResult } from '../engine/engine';
import type { RunRequest, WorkerResponse } from './protocol';

/** A failed run; `blockId` names the block to highlight (block strategies). */
export class BacktestError extends Error {
  constructor(message: string, readonly blockId?: string) {
    super(message);
    this.name = 'BacktestError';
  }
}

/** Runs one backtest in a fresh Web Worker; the worker is terminated on result, error or timeout. */
export function runBacktestInWorker(request: RunRequest, timeoutMs = 60_000): Promise<BacktestResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./backtest.worker.ts', import.meta.url), { type: 'module' });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new BacktestError(`backtest timed out after ${timeoutMs / 1000}s (worker stopped)`));
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      finish();
      if (event.data.type === 'result') resolve(event.data.result);
      else reject(new BacktestError(event.data.message, event.data.blockId));
    };
    worker.onerror = (event: ErrorEvent) => {
      finish();
      reject(new BacktestError(event.message || 'backtest worker crashed'));
    };
    worker.postMessage(request);
  });
}
