/**
 * Bookkeeping behind the "Start from…" picker, so loading a starter never loses work:
 * - `last`: the starter loaded most recently and the workspace text right after loading it. When the current
 *   workspace still equals that text it is an untouched starter and may be replaced without asking.
 * - `previous`: the workspace that was showing before the last replacement ("Restore previous" brings it back;
 *   restoring swaps, so the workspace it replaces becomes the new previous one).
 */
export interface KeyValueStore {
  get(key: string): unknown;
  /** False when the write did not stick (the caller warns). */
  set(key: string, value: unknown): boolean;
}

export const LAST_STARTER_KEY = 'quant-sim.starter.last.v1';
export const PREVIOUS_WORKSPACE_KEY = 'quant-sim.blocks.previous.v1';

export interface LastStarter {
  id: string;
  /** JSON text of the workspace right after the starter was loaded. */
  text: string;
}

export interface PreviousWorkspace {
  workspace: unknown;
  /** Epoch ms. */
  savedAt: number;
}

export interface StarterPlan {
  /** Ask before replacing: the current workspace has edits that are not an untouched starter. */
  confirm: boolean;
  /** Copy the current workspace into the previous slot first. */
  savePrevious: boolean;
}

function asLast(value: unknown): LastStarter | null {
  const v = value as Partial<LastStarter> | null;
  return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.text === 'string' ? { id: v.id, text: v.text } : null;
}

function asPrevious(value: unknown): PreviousWorkspace | null {
  const v = value as Partial<PreviousWorkspace> | null;
  return v && typeof v === 'object' && v.workspace !== undefined && v.workspace !== null && typeof v.savedAt === 'number'
    ? { workspace: v.workspace, savedAt: v.savedAt }
    : null;
}

export class StarterMemory {
  constructor(private readonly store: KeyValueStore) {}

  get last(): LastStarter | null {
    return asLast(this.store.get(LAST_STARTER_KEY));
  }

  get previous(): PreviousWorkspace | null {
    return asPrevious(this.store.get(PREVIOUS_WORKSPACE_KEY));
  }

  /** True when the workspace (as JSON text) is not exactly the last starter as loaded. */
  isModified(currentText: string): boolean {
    return this.last?.text !== currentText;
  }

  /** What picking a starter means for the current workspace. An empty workspace is never worth keeping. */
  planLoad(currentText: string, currentIsEmpty: boolean): StarterPlan {
    if (currentIsEmpty || !this.isModified(currentText)) return { confirm: false, savePrevious: false };
    return { confirm: true, savePrevious: true };
  }

  savePrevious(workspace: unknown, now: number): boolean {
    return this.store.set(PREVIOUS_WORKSPACE_KEY, { workspace, savedAt: now } satisfies PreviousWorkspace);
  }

  recordLoaded(id: string, text: string): void {
    this.store.set(LAST_STARTER_KEY, { id, text } satisfies LastStarter);
  }

  /** The workspace is something the user made (or restored): the next starter pick must ask again. */
  forgetLoaded(): void {
    this.store.set(LAST_STARTER_KEY, null);
  }

  /**
   * Restore = swap. Call AFTER the previous workspace loaded successfully: `replaced` (what was showing before)
   * becomes the new previous one, so restoring twice gets back to where you started.
   */
  completeRestore(replaced: unknown, now: number): boolean {
    this.forgetLoaded();
    return this.savePrevious(replaced, now);
  }
}

/** True when a workspace JSON has no top-level blocks. */
export function isEmptyWorkspace(json: unknown): boolean {
  const blocks = (json as { blocks?: { blocks?: unknown[] } } | null)?.blocks?.blocks;
  return !Array.isArray(blocks) || blocks.length === 0;
}
