/**
 * Bookkeeping behind the "Start from…" picker, so loading a starter never loses work:
 * - `last`: the starter loaded most recently and the workspace text right after loading it. When the current
 *   workspace still equals that text it is an untouched starter: replacing it needs no confirm and keeps nothing.
 * - `previousList`: up to MAX_PREVIOUS workspaces that were replaced (most recent first), each labelled with what
 *   it was ("Your blocks", "Edited SMA 10/30 cross") and when it was saved. Only the oldest is evicted.
 */
export interface KeyValueStore {
  get(key: string): unknown;
  /** False when the write did not stick (the caller warns). */
  set(key: string, value: unknown): boolean;
}

export const LAST_STARTER_KEY = 'quant-sim.starter.last.v1';
/** The list of previous workspaces. */
export const PREVIOUS_LIST_KEY = 'quant-sim.blocks.previous.v2';
/** The single previous slot of earlier builds; migrated into the list on first read (and left in place). */
export const PREVIOUS_WORKSPACE_KEY = 'quant-sim.blocks.previous.v1';
export const MAX_PREVIOUS = 3;

export interface LastStarter {
  id: string;
  /** JSON text of the workspace right after the starter was loaded. */
  text: string;
  /** The starter's display name (labels an edited copy). */
  label?: string;
}

export interface PreviousWorkspace {
  id: string;
  workspace: unknown;
  /** Epoch ms. */
  savedAt: number;
  /** What it was: "Your blocks" or "Edited <starter>". */
  label: string;
}

export interface StarterPlan {
  /** Ask before replacing: the current workspace has edits that are not an untouched starter. */
  confirm: boolean;
  /** Keep the current workspace in the previous list first. */
  savePrevious: boolean;
  /** Label of the entry that keeping the current one would evict (the list is full), else null. */
  evicts: PreviousWorkspace | null;
  /** Label the current workspace gets in the list. */
  label: string;
}

function asLast(value: unknown): LastStarter | null {
  const v = value as Partial<LastStarter> | null;
  return v && typeof v === 'object' && typeof v.id === 'string' && typeof v.text === 'string'
    ? { id: v.id, text: v.text, ...(typeof v.label === 'string' ? { label: v.label } : {}) }
    : null;
}

function asEntry(value: unknown): PreviousWorkspace | null {
  const v = value as Partial<PreviousWorkspace> | null;
  if (!v || typeof v !== 'object' || v.workspace === undefined || v.workspace === null || typeof v.savedAt !== 'number') return null;
  return { id: typeof v.id === 'string' ? v.id : `p-${v.savedAt}`, workspace: v.workspace, savedAt: v.savedAt, label: typeof v.label === 'string' ? v.label : 'Your blocks' };
}

export class StarterMemory {
  constructor(private readonly store: KeyValueStore) {}

  get last(): LastStarter | null {
    return asLast(this.store.get(LAST_STARTER_KEY));
  }

  /** Previous workspaces, most recent first (migrates the old single slot the first time). */
  get previousList(): PreviousWorkspace[] {
    const raw = this.store.get(PREVIOUS_LIST_KEY);
    if (Array.isArray(raw)) return raw.map(asEntry).filter((e): e is PreviousWorkspace => e !== null).slice(0, MAX_PREVIOUS);
    const old = asEntry(this.store.get(PREVIOUS_WORKSPACE_KEY));
    const list = old ? [old] : [];
    if (old) this.store.set(PREVIOUS_LIST_KEY, list);
    return list;
  }

  /** True when the workspace (as JSON text) is not exactly the last starter as loaded. */
  isModified(currentText: string): boolean {
    return this.last?.text !== currentText;
  }

  /** What replacing the current workspace means. An empty or untouched-starter workspace is never kept. */
  planReplace(currentText: string, currentIsEmpty: boolean): StarterPlan {
    const last = this.last;
    const label = last?.label ? `Edited ${last.label}` : 'Your blocks';
    if (currentIsEmpty || !this.isModified(currentText)) return { confirm: false, savePrevious: false, evicts: null, label };
    const list = this.previousList;
    return { confirm: true, savePrevious: true, evicts: list.length >= MAX_PREVIOUS ? list[list.length - 1] : null, label };
  }

  /** Raw list as stored, for an exact revert. */
  snapshot(): unknown {
    return this.store.get(PREVIOUS_LIST_KEY) ?? this.previousList;
  }

  revert(snapshot: unknown): boolean {
    return this.store.set(PREVIOUS_LIST_KEY, snapshot);
  }

  /** Writes `entries` (most recent first) in front of the list minus `removeId`, trimmed to MAX_PREVIOUS. */
  writeList(entries: Array<Omit<PreviousWorkspace, 'id'>>, removeId: string | null = null): boolean {
    const rest = this.previousList.filter((p) => p.id !== removeId);
    const used = new Set(rest.map((p) => p.id));
    const fresh = entries.map((e) => {
      let id = `p-${e.savedAt}`;
      for (let n = 2; used.has(id); n++) id = `p-${e.savedAt}-${n}`;
      used.add(id);
      return { id, ...e };
    });
    return this.store.set(PREVIOUS_LIST_KEY, [...fresh, ...rest].slice(0, MAX_PREVIOUS));
  }

  recordLoaded(id: string, text: string, label?: string): void {
    this.store.set(LAST_STARTER_KEY, { id, text, ...(label ? { label } : {}) } satisfies LastStarter);
  }

  /** The workspace is something the user made (or restored): the next starter pick must ask again. */
  forgetLoaded(): void {
    this.store.set(LAST_STARTER_KEY, null);
  }
}

/** True when a workspace JSON has no top-level blocks. */
export function isEmptyWorkspace(json: unknown): boolean {
  const blocks = (json as { blocks?: { blocks?: unknown[] } } | null)?.blocks?.blocks;
  return !Array.isArray(blocks) || blocks.length === 0;
}
