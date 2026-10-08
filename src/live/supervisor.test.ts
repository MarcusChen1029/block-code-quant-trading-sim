import { describe, expect, it } from 'vitest';
import { LiveWorkerClient, HEARTBEAT_TIMEOUT_MS, type WorkerLike } from './client';
import type { LiveCommand, LiveEvent } from './host';
import type { LiveSessionRecord } from './session';
import { LiveWorkerSupervisor } from './supervisor';
import { ManualTimers, testSession } from './testing';

class FakeWorker implements WorkerLike {
  onmessage: ((ev: MessageEvent<LiveEvent>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  onmessageerror: ((ev: MessageEvent) => void) | null = null;
  readonly sent: LiveCommand[] = [];
  terminated = false;
  postMessage(command: LiveCommand): void {
    this.sent.push(command);
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(event: LiveEvent): void {
    this.onmessage?.({ data: event } as MessageEvent<LiveEvent>);
  }
  crash(message = 'Uncaught Error: boom'): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

function harness() {
  const timers = new ManualTimers();
  let now = 0;
  const workers: FakeWorker[] = [];
  const events: LiveEvent[] = [];
  const crashes: string[] = [];
  const make = (session: LiveSessionRecord, mode: 'live' | 'replay', onEvent: (e: LiveEvent) => void, onCrash: (m: string) => void) =>
    new LiveWorkerClient(session, mode, onEvent, onCrash, {
      createWorker: () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      timers,
      now: () => now,
    });
  const advance = (ms: number, step = 5000) => {
    for (let t = 0; t < ms; t += step) {
      now += step;
      timers.runIntervals();
    }
  };
  return { timers, workers, events, crashes, make, advance, setNow: (t: number) => { now = t; }, getNow: () => now };
}

const status: LiveEvent = { type: 'status', status: { state: 'live', lastBarTime: null, barsProcessed: 0, behindBars: 0 } };

describe('LiveWorkerClient crash detection', () => {
  it('starts the worker with the session and forwards its events (heartbeats are internal)', () => {
    const h = harness();
    h.make(testSession(), 'live', (e) => h.events.push(e), (m) => h.crashes.push(m));
    expect(h.workers[0].sent[0]).toMatchObject({ type: 'start', mode: 'live' });
    h.workers[0].emit(status);
    h.workers[0].emit({ type: 'heartbeat' });
    expect(h.events).toEqual([status]);
  });

  it('a worker error is reported once; the worker is terminated and its later messages ignored', () => {
    const h = harness();
    h.make(testSession(), 'live', (e) => h.events.push(e), (m) => h.crashes.push(m));
    h.workers[0].crash('Uncaught TypeError: x is undefined');
    h.workers[0].crash('again');
    h.workers[0].emit(status);
    expect(h.crashes).toEqual(['Uncaught TypeError: x is undefined']);
    expect(h.workers[0].terminated).toBe(true);
    expect(h.events).toEqual([]);
    expect(h.timers.intervals.size).toBe(0);
  });

  it('a message that cannot be deserialised is a crash', () => {
    const h = harness();
    h.make(testSession(), 'live', () => {}, (m) => h.crashes.push(m));
    h.workers[0].onmessageerror?.({} as MessageEvent);
    expect(h.crashes).toHaveLength(1);
    expect(h.crashes[0]).toMatch(/could not be read/);
  });

  it('silence longer than the heartbeat timeout is a crash (hung worker); heartbeats keep it alive', () => {
    const h = harness();
    h.make(testSession(), 'live', () => {}, (m) => h.crashes.push(m));
    for (let i = 0; i < 20; i++) {
      h.advance(5000);
      h.workers[0].emit({ type: 'heartbeat' });
    }
    expect(h.crashes).toEqual([]);
    h.advance(HEARTBEAT_TIMEOUT_MS + 5000);
    expect(h.crashes).toHaveLength(1);
    expect(h.crashes[0]).toMatch(/not responding/);
    expect(h.workers[0].terminated).toBe(true);
  });

  it('a frozen page (no timer ran for a long time) is not mistaken for a hung worker', () => {
    const h = harness();
    h.make(testSession(), 'live', () => {}, (m) => h.crashes.push(m));
    h.setNow(h.getNow() + 10 * 60_000); // laptop asleep: neither the worker nor the page ran
    h.timers.runIntervals();
    expect(h.crashes).toEqual([]);
    h.workers[0].emit({ type: 'heartbeat' });
    h.advance(10_000);
    expect(h.crashes).toEqual([]);
  });

  it('terminate() stops the heartbeat check', () => {
    const h = harness();
    const c = h.make(testSession(), 'live', () => {}, (m) => h.crashes.push(m));
    c.terminate();
    expect(h.timers.intervals.size).toBe(0);
    h.advance(HEARTBEAT_TIMEOUT_MS * 3);
    expect(h.crashes).toEqual([]);
  });
});

describe('LiveWorkerSupervisor', () => {
  function supervised(onStop = false) {
    const h = harness();
    const restarts: string[] = [];
    const fatal: string[] = [];
    const session = testSession({ id: 'abc' });
    const sup = new LiveWorkerSupervisor(session, 'live', {
      event: (e) => h.events.push(e),
      restarting: (m) => restarts.push(m),
      fatal: (m) => fatal.push(m),
    }, h.make);
    if (onStop) sup.stop();
    return { h, sup, restarts, fatal, session };
  }

  it('restarts a crashed worker ONCE with the same session and mode (deterministic replay)', () => {
    const { h, restarts, fatal } = supervised();
    h.workers[0].crash('boom');
    expect(restarts).toEqual(['boom']);
    expect(fatal).toEqual([]);
    expect(h.workers).toHaveLength(2);
    expect(h.workers[0].terminated).toBe(true);
    expect(h.workers[1].sent[0]).toEqual(h.workers[0].sent[0]);
    h.workers[0].emit(status); // a late message of the dead worker
    h.workers[1].emit(status);
    expect(h.events).toEqual([status]);
  });

  it('a second crash is fatal: no third worker', () => {
    const { h, restarts, fatal } = supervised();
    h.workers[0].crash('first');
    h.advance(HEARTBEAT_TIMEOUT_MS + 5000); // the restarted worker hangs
    expect(restarts).toEqual(['first']);
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatch(/not responding/);
    expect(h.workers).toHaveLength(2);
    expect(h.workers[1].terminated).toBe(true);
    expect(h.timers.intervals.size).toBe(0);
  });

  it('a crash while stopping is not restarted', () => {
    const { h, restarts, fatal } = supervised(true);
    h.workers[0].crash('boom');
    expect(restarts).toEqual([]);
    expect(fatal).toEqual(['boom']);
    expect(h.workers).toHaveLength(1);
  });

  it('commands go to the current worker', () => {
    const { h, sup } = supervised();
    h.workers[0].crash('boom');
    sup.resync();
    sup.stop();
    expect(h.workers[1].sent.map((c) => c.type)).toEqual(['start', 'resync', 'stop']);
    sup.terminate();
    expect(h.workers[1].terminated).toBe(true);
  });
});
