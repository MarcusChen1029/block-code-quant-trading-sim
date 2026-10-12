import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/**
 * A single-instance lock: one quant-sim process per data directory (they would fight over the SQLite file and run
 * the same sessions twice). A lock file holds the owner's pid; a second process refuses to start. A stale lock from
 * a crashed process (its pid no longer alive) is taken over.
 */
export interface InstanceLock {
  release(): void;
}

export class InstanceLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceLockError';
  }
}

export interface LockHooks {
  /** True when a process with this pid is running (default: process.kill(pid, 0)). */
  isAlive?(pid: number): boolean;
  pid?: number;
}

const defaultAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (stale). EPERM = alive but not ours (still alive).
    return (err as { code?: string }).code === 'EPERM';
  }
};

/** Acquires `path` or throws InstanceLockError. Call release() (or let the process exit) to free it. */
export function acquireInstanceLock(path: string, hooks: LockHooks = {}): InstanceLock {
  const isAlive = hooks.isAlive ?? defaultAlive;
  const myPid = hooks.pid ?? process.pid;
  const take = () => writeFileSync(path, String(myPid));

  if (existsSync(path)) {
    let owner = NaN;
    try {
      owner = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    } catch {
      owner = NaN;
    }
    if (Number.isInteger(owner) && owner !== myPid && isAlive(owner)) {
      throw new InstanceLockError(`another quant-sim server (pid ${owner}) is using this data directory; stop it first or use a different QS_DATA_DIR`);
    }
    // Stale (dead owner) or unreadable: take it over.
  }
  take();
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      try {
        if (existsSync(path) && readFileSync(path, 'utf8').trim() === String(myPid)) rmSync(path, { force: true });
      } catch {
        // best effort
      }
    },
  };
}
