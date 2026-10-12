/** The lazily loaded block editor could not be loaded (its message is the user-facing text). */
export class LoadFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoadFailedError';
  }
}

export type LoadState<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'failed'; error: string };

/**
 * A value loaded on demand once (main.ts: the Blockly block editor chunk). get() starts the load, or shares the one
 * in flight, or returns the loaded value; after a FAILED load, the next get() tries again (a new dynamic import), so
 * Run or a Retry button can recover from a network hiccup. Failures reject with LoadFailedError and are kept in
 * `current` (so callers can tell "still loading" from "failed").
 */
export class LazyLoader<T> {
  private state: LoadState<T> = { status: 'loading' };
  private pending: Promise<T> | null = null;

  constructor(private readonly load: () => Promise<T>, private readonly onFailed: (error: string) => void = () => {}) {}

  get current(): LoadState<T> {
    return this.state;
  }

  get(): Promise<T> {
    if (this.state.status === 'ready') return Promise.resolve(this.state.value);
    if (this.pending) return this.pending;
    this.state = { status: 'loading' };
    this.pending = this.load().then(
      (value) => {
        this.state = { status: 'ready', value };
        this.pending = null;
        return value;
      },
      (err: unknown) => {
        const error = `The block editor could not be loaded (${err instanceof Error ? err.message : String(err)}).`;
        this.state = { status: 'failed', error };
        this.pending = null;
        this.onFailed(error);
        throw new LoadFailedError(error);
      },
    );
    return this.pending;
  }
}

/** Why `action` cannot happen while the editor is not ready: still loading, or failed (with the error and a way out). */
export function notReadyMessage(state: LoadState<unknown>, action: string): string {
  if (state.status === 'failed') return `Cannot ${action}: ${state.error} Press Retry in the Blocks pane, or reload the page.`;
  return `Cannot ${action} yet: the block editor is still loading — try again in a moment.`;
}
