/** The part of the Web Locks API (navigator.locks) used here; injectable for tests. */
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: { name: string } | null) => Promise<unknown>,
  ): Promise<unknown>;
}

/** Ownership of one session in this tab; release() lets another tab take it. */
export interface SessionLock {
  release(): void;
}

const lockName = (id: string) => `quant-sim-live-session:${id}`;

/** The browser's lock manager, or undefined (old browsers, some embedded views). */
export function browserLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator;
  return nav?.locks;
}

function hold(locks: LockManagerLike, id: string, options: { ifAvailable?: boolean; signal?: AbortSignal }, onLock: (lock: SessionLock | null) => void): Promise<unknown> {
  return locks.request(lockName(id), options, (lock) => {
    if (lock === null) {
      onLock(null);
      return Promise.resolve();
    }
    return new Promise<void>((release) => onLock({ release: () => release() }));
  });
}

/**
 * Makes this tab the single runner of session `id` when no other tab is: the lock is held until release() (or the
 * tab closes). null = another tab runs it (show it read-only). 'unsupported' = no Web Locks here; callers run
 * the session anyway and rely on merge-on-write in the store.
 */
export function claimSession(locks: LockManagerLike | undefined, id: string): Promise<SessionLock | null | 'unsupported'> {
  if (!locks) return Promise.resolve('unsupported');
  return new Promise((resolve, reject) => {
    hold(locks, id, { ifAvailable: true }, resolve).catch(reject);
  });
}

/**
 * Calls `onOwned` once this tab becomes the owner of session `id` (the owning tab stopped it or was closed).
 * Returns a cancel function; after cancel the session is never taken.
 */
export function waitForSession(locks: LockManagerLike | undefined, id: string, onOwned: (lock: SessionLock) => void): () => void {
  if (!locks) return () => {};
  const abort = new AbortController();
  let cancelled = false;
  hold(locks, id, { signal: abort.signal }, (lock) => {
    if (!lock) return;
    if (cancelled) lock.release();
    else onOwned(lock);
  }).catch(() => {
    // aborted: nothing to do
  });
  return () => {
    cancelled = true;
    abort.abort();
  };
}
