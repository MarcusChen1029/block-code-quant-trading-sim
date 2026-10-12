import { Worker } from 'node:worker_threads';
import type { MarketDataAdapter } from '../../../src/data/adapter';
import { LiveWorkerClient, type WorkerLike } from '../../../src/live/client';
import type { LiveCommand, LiveEvent, RunnerTuning } from '../../../src/live/host';
import type { ClientFactory } from '../../../src/live/supervisor';
import { createWorkerRuntime, type WorkerConfig } from './runtime';

/** Memory caps of one session worker (MB). A strategy that allocates without bound kills only its own worker. */
export const WORKER_RESOURCE_LIMITS = { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32, codeRangeSizeMb: 32, stackSizeMb: 4 };

const errorEvent = (message: string) => ({ message, preventDefault() {} }) as unknown as ErrorEvent;

/** A real worker_threads Worker running `script` (server/dist/worker.js), seen through the browser's WorkerLike. */
export function threadWorker(script: string | URL, config: WorkerConfig): WorkerLike {
  const worker = new Worker(script, { workerData: config, resourceLimits: WORKER_RESOURCE_LIMITS, stdout: false, stderr: false });
  let ended = false;
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (command: LiveCommand) => {
      if (!ended) worker.postMessage(command);
    },
    terminate: () => {
      if (ended) return;
      ended = true;
      void worker.terminate();
    },
  };
  worker.on('message', (data: LiveEvent) => like.onmessage?.({ data } as MessageEvent<LiveEvent>));
  worker.on('messageerror', () => like.onmessageerror?.({} as MessageEvent));
  worker.on('error', (err: Error) => {
    if (!ended) like.onerror?.(errorEvent(err.message || 'live worker crashed'));
  });
  worker.on('exit', (code: number) => {
    if (!ended) like.onerror?.(errorEvent(`live worker exited (code ${code})`));
    ended = true;
  });
  return like;
}

/**
 * The same runtime in this thread (tests): events are structured-cloned and delivered asynchronously like a
 * worker's, `debug throw` reports a crash, terminate() stops it. `market` is the (fake) market data per worker.
 */
export function inThreadWorker(config: WorkerConfig, market: () => MarketDataAdapter, tuning: RunnerTuning = {}): WorkerLike {
  let ended = false;
  const like: WorkerLike = {
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage: (command: LiveCommand) => {
      if (ended) return;
      if (command.type === 'debug' && command.action === 'throw') {
        setTimeout(() => {
          if (!ended) like.onerror?.(errorEvent('simulated live worker crash (debug hook)'));
        }, 0);
        return;
      }
      const copy = structuredClone(command);
      setTimeout(() => {
        if (!ended) runtime.handle(copy);
      }, 0);
    },
    terminate: () => {
      if (ended) return;
      ended = true;
      runtime.close();
    },
  };
  const runtime = createWorkerRuntime((event) => {
    if (ended) return;
    const copy = structuredClone(event);
    setTimeout(() => {
      if (!ended) like.onmessage?.({ data: copy } as MessageEvent<LiveEvent>);
    }, 0);
  }, { ...config, allowDebug: false }, market(), tuning);
  return like;
}

/** Supervisor client factory using `createWorker` for every (re)start. */
export function clientFactory(createWorker: () => WorkerLike): ClientFactory {
  return (session, mode, onEvent, onCrash) => new LiveWorkerClient(session, mode, onEvent, onCrash, { createWorker });
}
