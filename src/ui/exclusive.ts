/**
 * Wraps an async action so that calls made while one is still running are ignored (a double click or a second
 * Enter on "Start live session" must not start two sessions). The guard is set synchronously, before the
 * action's first await.
 */
export function exclusive<A extends unknown[]>(action: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  let busy = false;
  return async (...args: A) => {
    if (busy) return;
    busy = true;
    try {
      await action(...args);
    } finally {
      busy = false;
    }
  };
}
