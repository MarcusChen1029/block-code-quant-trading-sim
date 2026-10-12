import { parentPort, workerData } from 'node:worker_threads';
import type { LiveCommand } from '../../../src/live/host';
import { createWorkerRuntime, type WorkerConfig } from './runtime';

// worker_threads glue around the runtime (the twin of src/worker/live.worker.ts in the browser).
const port = parentPort!;
const runtime = createWorkerRuntime((event) => port.postMessage(event), workerData as WorkerConfig);
port.on('message', (command: LiveCommand) => runtime.handle(command));
