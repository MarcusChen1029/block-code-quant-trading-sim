import type { BacktestResult } from '../engine/engine';
import type { RunRequest, WorkerResponse } from './protocol';

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
      reject(new Error(`backtest timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      finish();
      if (event.data.type === 'result') resolve(event.data.result);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event: ErrorEvent) => {
      finish();
      reject(new Error(event.message || 'backtest worker crashed'));
    };
    worker.postMessage(request);
  });
}
