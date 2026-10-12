import { describe, it, expect } from 'vitest';
import { LazyLoader, LoadFailedError } from './lazyLoader';

/** A load that fails `failures` times, then resolves with the attempt number. */
function flaky(failures: number) {
  let attempts = 0;
  return {
    get attempts() { return attempts; },
    load: () => {
      attempts++;
      return attempts <= failures ? Promise.reject(new Error('chunk fetch failed')) : Promise.resolve(attempts);
    },
  };
}

describe('LazyLoader (the lazily loaded block editor chunk)', () => {
  it('is loading, then ready; later gets reuse the value without loading again', async () => {
    const f = flaky(0);
    const l = new LazyLoader(f.load);
    const p = l.get();
    expect(l.current).toEqual({ status: 'loading' });
    expect(await p).toBe(1);
    expect(l.current).toEqual({ status: 'ready', value: 1 });
    expect(await l.get()).toBe(1);
    expect(f.attempts).toBe(1);
  });

  it('concurrent gets share one attempt', async () => {
    const f = flaky(0);
    const l = new LazyLoader(f.load);
    expect(await Promise.all([l.get(), l.get()])).toEqual([1, 1]);
    expect(f.attempts).toBe(1);
  });

  it('a failure is kept (failed + the error) and reported as LoadFailedError; the next get retries', async () => {
    const f = flaky(1);
    const failed: string[] = [];
    const l = new LazyLoader(f.load, (error) => failed.push(error));
    const err = await l.get().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadFailedError);
    expect((err as Error).message).toBe('The block editor could not be loaded (chunk fetch failed).');
    expect(l.current).toEqual({ status: 'failed', error: 'The block editor could not be loaded (chunk fetch failed).' });
    expect(failed).toEqual(['The block editor could not be loaded (chunk fetch failed).']);
    expect(await l.get()).toBe(2); // retry: a new import attempt
    expect(l.current).toEqual({ status: 'ready', value: 2 });
  });
});
