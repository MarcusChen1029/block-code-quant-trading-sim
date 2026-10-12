import { describe, expect, it } from 'vitest';
import { LoginBusyError, LoginThrottle } from './loginThrottle';

describe('LoginThrottle: per-address backoff', () => {
  it('counts the attempt in begin (before the await), so concurrent attempts cannot all pass', () => {
    let t = 0;
    const throttle = new LoginThrottle({ maxPerAddress: 3, backoffBaseMs: 1000, now: () => t });
    // 40 begins in one synchronous burst from one address, none settled yet (verification still "in flight").
    const results = Array.from({ length: 40 }, () => throttle.begin('1.2.3.4'));
    expect(results.filter((r) => r.ok).length).toBe(3);
    expect(results.filter((r) => !r.ok).length).toBe(37);
    expect(results.find((r) => !r.ok)?.status).toBe(429);
    expect(results.find((r) => !r.ok)?.retryAfterMs).toBeGreaterThan(0);
  });

  it('backoff grows exponentially and is capped; a success clears the address', () => {
    let t = 0;
    const throttle = new LoginThrottle({ maxPerAddress: 1, backoffBaseMs: 1000, backoffCapMs: 8000, now: () => t });
    expect(throttle.begin('a').ok).toBe(true); // 1st allowed
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r = throttle.begin('a');
      expect(r.ok).toBe(false);
      waits.push(r.retryAfterMs!);
      t += r.retryAfterMs!; // wait exactly, then it is allowed again (and fails again)
      expect(throttle.begin('a').ok).toBe(true);
    }
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(waits.every((w) => w <= 8000)).toBe(true); // capped
    // success() clears an address: one failure then a success, and it is back to a clean slate.
    expect(throttle.begin('b').ok).toBe(true); // 1st (counts as a pending failure)
    const win = throttle.begin('b');
    expect(win.ok).toBe(false); // at cap (maxPerAddress 1)
    t += 1000;
    const ok = throttle.begin('b');
    expect(ok.ok).toBe(true);
    ok.attempt!.success();
    expect(throttle.begin('b').ok).toBe(true); // cleared
  });

  it('a fresh address is never blocked by another address (no global lockout)', () => {
    let t = 0;
    const throttle = new LoginThrottle({ maxPerAddress: 2, now: () => t });
    for (let i = 0; i < 20; i++) throttle.begin(`attacker-${i}`); // many distinct IPs, each one failure
    throttle.begin('attacker-x');
    throttle.begin('attacker-x'); // attacker-x now at the cap
    expect(throttle.begin('attacker-x').ok).toBe(false);
    expect(throttle.begin('owner').ok).toBe(true); // fresh IP still works
  });

  it('refund keeps a non-guess (bad body / busy) from counting against the address', () => {
    const throttle = new LoginThrottle({ maxPerAddress: 1 });
    const a = throttle.begin('a');
    a.attempt!.refund();
    expect(throttle.begin('a').ok).toBe(true); // the refunded attempt did not count
  });
});

describe('LoginThrottle: serialized verification', () => {
  it('runs one verification at a time and refuses with 503 when the queue is full', async () => {
    const throttle = new LoginThrottle({ maxQueue: 2 });
    const gate = () => throttle.begin('x').attempt!;
    let release!: () => void;
    const slow = () => new Promise<boolean>((r) => { release = () => r(true); });
    const running = gate().verify(slow); // takes the only slot
    await Promise.resolve();
    const queued1 = gate().verify(() => Promise.resolve(true)); // queue 1/2
    const queued2 = gate().verify(() => Promise.resolve(true)); // queue 2/2
    await expect(gate().verify(() => Promise.resolve(true))).rejects.toBeInstanceOf(LoginBusyError); // full -> 503
    expect(throttle.pending).toBe(3);
    release();
    await Promise.all([running, queued1, queued2]);
    expect(throttle.pending).toBe(0);
  });
});
