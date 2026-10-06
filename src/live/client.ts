import type { LiveCommand, LiveEvent } from './host';
import type { LiveSessionRecord } from './session';

/** Page side of one live worker: one session per worker; terminate() discards it. */
export class LiveWorkerClient {
  private readonly worker: Worker;
  private terminated = false;

  constructor(session: LiveSessionRecord, mode: 'live' | 'replay', onEvent: (event: LiveEvent) => void, onCrash: (message: string) => void) {
    this.worker = new Worker(new URL('../worker/live.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<LiveEvent>) => {
      if (!this.terminated) onEvent(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      if (!this.terminated) onCrash(event.message || 'live worker crashed');
    };
    this.send({ type: 'start', session, mode });
  }

  stop(): void {
    this.send({ type: 'stop' });
  }

  resync(): void {
    this.send({ type: 'resync' });
  }

  terminate(): void {
    this.terminated = true;
    this.worker.terminate();
  }

  private send(command: LiveCommand): void {
    if (!this.terminated) this.worker.postMessage(command);
  }
}
