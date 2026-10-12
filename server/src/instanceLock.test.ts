import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireInstanceLock, InstanceLockError } from './instanceLock';

const dirs: string[] = [];
const lockPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'qs-lock-'));
  dirs.push(dir);
  return join(dir, 'quant-sim.lock');
};
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('instance lock', () => {
  it('a second process refuses to start while the owner is alive, and starts after release', () => {
    const path = lockPath();
    const first = acquireInstanceLock(path, { pid: 111, isAlive: (p) => p === 111 });
    expect(readFileSync(path, 'utf8')).toBe('111');
    expect(() => acquireInstanceLock(path, { pid: 222, isAlive: () => true })).toThrow(InstanceLockError);
    first.release();
    expect(existsSync(path)).toBe(false);
    const second = acquireInstanceLock(path, { pid: 222, isAlive: () => true });
    expect(readFileSync(path, 'utf8')).toBe('222');
    second.release();
  });

  it('takes over a stale lock whose owner is no longer running', () => {
    const path = lockPath();
    writeFileSync(path, '999'); // a crashed process left this behind
    const lock = acquireInstanceLock(path, { pid: 333, isAlive: (p) => p !== 999 });
    expect(readFileSync(path, 'utf8')).toBe('333');
    lock.release();
  });

  it('release only removes the lock while this process still owns it', () => {
    const path = lockPath();
    const lock = acquireInstanceLock(path, { pid: 444, isAlive: () => true });
    writeFileSync(path, '555'); // someone else now owns it
    lock.release();
    expect(readFileSync(path, 'utf8')).toBe('555'); // not removed
  });
});
