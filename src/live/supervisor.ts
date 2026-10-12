import { LiveWorkerClient } from './client';
import type { LiveEvent } from './host';
import type { LiveSessionRecord } from './session';

export interface SupervisorHandlers {
  /** Events of the current worker only (never of one that crashed). */
  event(event: LiveEvent): void;
  /** The worker crashed; a fresh one replays the session from its definition. The page should reset its view. */
  restarting(message: string): void;
  /** Crashed again (or while stopping): no more workers. The session should be stopped with this error. */
  fatal(message: string): void;
}

export type ClientFactory = (
  session: LiveSessionRecord,
  mode: 'live' | 'replay',
  onEvent: (event: LiveEvent) => void,
  onCrash: (message: string) => void,
) => LiveWorkerClient;

const defaultFactory: ClientFactory = (session, mode, onEvent, onCrash) => new LiveWorkerClient(session, mode, onEvent, onCrash);

/**
 * Runs one session's worker and restarts it ONCE after a crash. The budget refills once the restarted worker is live again
 * (bars processed), so only a crash during recovery is fatal. The restart is the same start command (same
 * record, same mode): the session state is a pure function of its definition and the closed candles, so the new
 * worker rebuilds it deterministically (from the candle cache, then REST).
 */
export class LiveWorkerSupervisor {
  private client: LiveWorkerClient;
  private restarts = 0;
  private stopping = false;
  private dead = false;

  constructor(
    private readonly session: LiveSessionRecord,
    private readonly mode: 'live' | 'replay',
    private readonly handlers: SupervisorHandlers,
    private readonly create: ClientFactory = defaultFactory,
    private readonly maxRestarts = 1,
  ) {
    this.client = this.spawn();
  }

  private spawn(): LiveWorkerClient {
    let client: LiveWorkerClient | null = null;
    const current = () => client !== null && client === this.client && !this.dead;
    client = this.create(
      this.session,
      this.mode,
      (event) => {
        if (!current()) return;
        // Recovered: the restarted worker is live again and has processed bars, so a crash much later (days) gets
        // its own restart instead of counting against the earlier one.
        if (this.restarts > 0 && event.type === 'status' && event.status.state === 'live' && event.status.barsProcessed > 0) this.restarts = 0;
        this.handlers.event(event);
      },
      (message) => {
        if (current()) this.onCrash(message);
      },
    );
    return client;
  }

  private onCrash(message: string): void {
    this.client.terminate();
    if (this.stopping || this.restarts >= this.maxRestarts) {
      this.dead = true;
      this.handlers.fatal(message);
      return;
    }
    this.restarts++;
    this.handlers.restarting(message);
    this.client = this.spawn();
  }

  stop(): void {
    this.stopping = true;
    this.client.stop();
  }

  resync(): void {
    this.client.resync();
  }

  debug(action: 'throw' | 'hang'): void {
    this.client.debug(action);
  }

  terminate(): void {
    this.dead = true;
    this.client.terminate();
  }
}
