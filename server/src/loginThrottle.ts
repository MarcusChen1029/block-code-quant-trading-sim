/**
 * Login throttling. Two independent guards, both needed:
 *
 *  - Per client address: failed attempts raise an exponential, capped backoff (a fresh address is never blocked by
 *    another's failures — no global lockout). The attempt is COUNTED synchronously in `begin`, before the async
 *    password check, and refunded on success; so N concurrent wrong logins from one address do not all slip through
 *    the window ahead of the first failure being recorded.
 *  - Globally: at most one password verification (scrypt) runs at a time, with a bounded wait queue. When the queue
 *    is full the request is refused with 503 (busy) instead of running unbounded scrypt work or locking anyone out.
 *    Under a distributed attack the queue stays bounded and drains, so a correct password from a fresh address still
 *    succeeds once it is served.
 */

export interface ThrottleOptions {
  /** Failures within the window before an address is made to wait. */
  maxPerAddress?: number;
  windowMs?: number;
  /** Backoff after the (maxPerAddress+1)th failure: base, then doubling, capped. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Verifications waiting for the single scrypt slot before new ones are refused (503). */
  maxQueue?: number;
  now?: () => number;
  /** Addresses tracked at once (oldest dropped). */
  maxKeys?: number;
}

export class LoginBusyError extends Error {
  constructor() {
    super('the server is busy checking logins; try again shortly');
    this.name = 'LoginBusyError';
  }
}

interface AddressState {
  /** Failed-attempt timestamps within the window (pending ones included until refunded). */
  times: number[];
}

export interface LoginAttempt {
  /** Password verification, serialized to one at a time; throws LoginBusyError when the queue is full. */
  verify<T>(fn: () => Promise<T>): Promise<T>;
  /** The password was right: clear this address's failures. */
  success(): void;
  /** The attempt never reached verification (bad body, busy): do not hold it against the address. */
  refund(): void;
}

export interface BeginResult {
  ok: boolean;
  /** When !ok. */
  status?: 429;
  retryAfterMs?: number;
  message?: string;
  attempt?: LoginAttempt;
}

export class LoginThrottle {
  private readonly addresses = new Map<string, AddressState>();
  private readonly max: number;
  private readonly windowMs: number;
  private readonly base: number;
  private readonly cap: number;
  private readonly maxQueue: number;
  private readonly maxKeys: number;
  private readonly now: () => number;
  private running = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(options: ThrottleOptions = {}) {
    this.max = options.maxPerAddress ?? 5;
    this.windowMs = options.windowMs ?? 15 * 60_000;
    this.base = options.backoffBaseMs ?? 1000;
    this.cap = options.backoffCapMs ?? 5 * 60_000;
    this.maxQueue = options.maxQueue ?? 20;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.now = options.now ?? (() => Date.now());
  }

  /** How long `address` must wait before another attempt (0 = none). */
  private retryAfter(times: number[]): number {
    if (times.length < this.max) return 0;
    const over = times.length - this.max; // 0 for the first blocking failure
    const backoff = Math.min(this.cap, this.base * 2 ** over);
    return Math.max(0, times[times.length - 1] + backoff - this.now());
  }

  private state(address: string): AddressState {
    const cutoff = this.now() - this.windowMs;
    const existing = this.addresses.get(address);
    const times = (existing?.times ?? []).filter((t) => t > cutoff);
    const state: AddressState = { times };
    this.addresses.set(address, state); // refresh recency (re-insertion moves it to the end)
    if (this.addresses.size > this.maxKeys) {
      const oldest = this.addresses.keys().next().value;
      if (oldest !== undefined && oldest !== address) this.addresses.delete(oldest);
    }
    return state;
  }

  /**
   * Begins an attempt from `address`: refuses with the wait when it is in backoff, otherwise records the attempt
   * (counted now, before any await) and returns a handle whose success() refunds it. The record keeps the address
   * honest even if many attempts arrive at once.
   */
  begin(address: string): BeginResult {
    const state = this.state(address);
    const wait = this.retryAfter(state.times);
    if (wait > 0) return { ok: false, status: 429, retryAfterMs: wait, message: 'too many failed logins from here; wait before trying again' };
    const stamp = this.now();
    state.times.push(stamp);
    if (state.times.length > this.max * 4) state.times.splice(0, state.times.length - this.max * 4);
    let settled = false;
    const remove = () => {
      const i = state.times.indexOf(stamp);
      if (i >= 0) state.times.splice(i, 1);
    };
    return {
      ok: true,
      attempt: {
        verify: (fn) => this.serialize(fn),
        success: () => {
          if (settled) return;
          settled = true;
          this.addresses.delete(address);
        },
        refund: () => {
          if (settled) return;
          settled = true;
          remove();
        },
      },
    };
  }

  /** Runs `fn` with at most one running at a time; refuses (LoginBusyError) when the queue is full. */
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= 1) {
      if (this.waiters.length >= this.maxQueue) throw new LoginBusyError();
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiters.shift()?.();
    }
  }

  /** Tests: verifications queued right now (0 or 1 running + waiters). */
  get pending(): number {
    return this.running + this.waiters.length;
  }
}
