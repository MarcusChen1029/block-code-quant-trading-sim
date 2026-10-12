import type { StarterDef } from '../blocks/starters';
import { fmtTime } from './format';
import { isEmptyWorkspace, MAX_PREVIOUS, type PreviousWorkspace, type StarterMemory } from './starterMemory';

/** What the starter flows need from the block editor. */
export interface EditorLike {
  save(): unknown;
  /** Replaces the workspace; false (workspace unchanged) when it cannot be loaded. */
  loadWorkspace(state: unknown): boolean;
}

export interface FlowDeps {
  editor: EditorLike;
  memory: StarterMemory;
  confirm(message: string): boolean;
  status(message: string, isError?: boolean): void;
  now(): number;
}

/** "Edited SMA 10/30 cross · 14:40 UTC" */
export function previousTitle(p: Pick<PreviousWorkspace, 'label' | 'savedAt'>): string {
  return `${p.label} · ${fmtTime(p.savedAt).slice(11)} UTC`;
}

/**
 * Loads a starter. A workspace with edits is confirmed first and kept in the previous-workspaces list (written
 * BEFORE the load; reverted exactly if the load fails, so a failed load never consumes or overwrites a slot).
 * True when the starter was loaded.
 */
export function pickStarter(deps: FlowDeps, starter: Pick<StarterDef, 'label' | 'description' | 'build'> & { id: string }): boolean {
  const { editor, memory } = deps;
  const current = editor.save();
  const plan = memory.planReplace(JSON.stringify(current), isEmptyWorkspace(current));
  if (plan.confirm) {
    const drop = plan.evicts ? ` The oldest one, "${previousTitle(plan.evicts)}", will be dropped.` : '';
    const message = `Replace your current blocks with "${starter.label}"?\n\nThey are kept under "Start from…" → Previous workspaces ` +
      `as "${plan.label}" (it keeps your last ${MAX_PREVIOUS}).${drop}`;
    if (!deps.confirm(message)) return false;
  }
  let snapshot: unknown = null;
  if (plan.savePrevious) {
    snapshot = memory.snapshot();
    if (!memory.writeList([{ workspace: current, savedAt: deps.now(), label: plan.label }])) {
      snapshot = null;
      if (!deps.confirm('Your current blocks could not be saved as a previous workspace (browser storage is full or blocked), so they would be lost. Replace them anyway?')) {
        deps.status('Kept your blocks: they could not be saved in browser storage, so the starter was not loaded.', true);
        return false;
      }
    }
  }
  if (!editor.loadWorkspace(starter.build())) {
    if (snapshot !== null) memory.revert(snapshot);
    return false;
  }
  memory.recordLoaded(starter.id, JSON.stringify(editor.save()), starter.label);
  deps.status(`Loaded starter "${starter.label}": ${starter.description} Press Run to backtest it.`);
  return true;
}

/**
 * Brings previous workspace `id` back. The workspace it replaces is kept in its place (unless it is an untouched
 * starter), so the list never grows. True when restored; the status line says truthfully what was kept.
 */
export function restorePrevious(deps: FlowDeps, id: string): boolean {
  const { editor, memory } = deps;
  const entry = memory.previousList.find((p) => p.id === id);
  if (!entry) return false;
  const current = editor.save();
  const plan = memory.planReplace(JSON.stringify(current), isEmptyWorkspace(current));
  const snapshot = memory.snapshot();
  const written = memory.writeList(plan.savePrevious ? [{ workspace: current, savedAt: deps.now(), label: plan.label }] : [], entry.id);
  if (!written && plan.savePrevious) {
    if (!deps.confirm('Your current blocks could not be saved as a previous workspace (browser storage is full or blocked), so they would be lost. Restore anyway?')) {
      deps.status('Kept your blocks: browser storage refused to save them, so nothing was restored.', true);
      return false;
    }
  }
  if (!editor.loadWorkspace(entry.workspace)) {
    if (written) memory.revert(snapshot);
    return false;
  }
  memory.forgetLoaded();
  if (!written) {
    deps.status(`Restored "${previousTitle(entry)}", but browser storage refused the update: the previous-workspaces list could not be changed${plan.savePrevious ? ' and the blocks you had are not saved' : ''}.`, true);
  } else {
    deps.status(`Restored "${previousTitle(entry)}".${plan.savePrevious ? ` The blocks you had are kept as "${plan.label}".` : ''}`);
  }
  return true;
}
