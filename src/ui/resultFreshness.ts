/**
 * Are the verdict / benchmark / stats on screen still about what the editor and the top bar show now?
 * A backtest's results are tied to the strategy and the settings it ran with. Loading a starter or restoring a
 * previous workspace DISCARDS them (they describe a strategy that is no longer in the editor at all); editing blocks
 * or Pine scripts, switching the strategy source or changing a setting makes them STALE (dimmed, with a note) until
 * the next Run, or until the edit is undone. Pure, so the rules are testable without a DOM.
 */

/** What a run depends on, as comparable strings (the serialized workspace + Pine scripts; the raw top-bar fields). */
export interface RunKey {
  strategy: string;
  settings: string;
}

export type StaleReason = 'strategy' | 'settings';
export type Freshness = { status: 'none' } | { status: 'fresh' } | { status: 'stale'; reason: StaleReason };

export const STALE_NOTE: Record<StaleReason, string> = {
  strategy: 'Results are from the previous strategy — press Run',
  settings: 'Results are from the previous settings — press Run',
};

/** `shown`: the key the results on screen were run with (null: nothing shown). */
export function freshness(shown: RunKey | null, current: RunKey): Freshness {
  if (shown === null) return { status: 'none' };
  if (shown.strategy !== current.strategy) return { status: 'stale', reason: 'strategy' };
  if (shown.settings !== current.settings) return { status: 'stale', reason: 'settings' };
  return { status: 'fresh' };
}

/** Remembers the key of the results on screen. */
export class ResultTracker {
  private shown: RunKey | null = null;

  /** A run finished and its results are now shown. */
  ranWith(key: RunKey): void {
    this.shown = { ...key };
  }

  /** The results were cleared (starter / previous workspace loaded, mode switch, new run started). */
  discard(): void {
    this.shown = null;
  }

  /** Results are on screen (check() would not be 'none'). */
  get showing(): boolean {
    return this.shown !== null;
  }

  check(current: RunKey): Freshness {
    return freshness(this.shown, current);
  }
}

/**
 * Comparable text of a Blockly workspace for RunKey.strategy: block positions (`x` / `y` of top-level block states)
 * are dropped, so dragging blocks around the canvas does not make results stale; every field, input, connection,
 * variable and block id still counts. (Blockly's JSON holds no scroll / zoom view state.)
 */
export function workspaceKey(workspace: unknown): string {
  return JSON.stringify(workspace, (_key, value: unknown) => {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'type' in value && 'id' in value && ('x' in value || 'y' in value)) {
      const { x: _x, y: _y, ...rest } = value as Record<string, unknown>;
      return rest;
    }
    return value;
  });
}
