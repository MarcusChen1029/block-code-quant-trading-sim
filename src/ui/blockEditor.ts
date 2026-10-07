import * as Blockly from 'blockly';
import { HAT_MAX_INSTANCES } from '../blocks/blockTypes';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { defineBlocks, defineMissingIndicatorBlocks } from '../blocks/definitions';
import type { CompileIssue } from '../blocks/generator';
import { quantTheme } from '../blocks/theme';
import { buildToolbox } from '../blocks/toolbox';
import { fixupIndicatorBlocks } from '../blocks/workspaceFixup';
import { loadWorkspaceSafely, type LoadResult } from '../blocks/workspaceLoad';
import { loadJson, saveJson } from './storage';

export const WORKSPACE_STORAGE_KEY = 'quant-sim.blocks.workspace.v1';
const ISSUE_WARNING_ID = 'compile';

export interface BlockEditor {
  /** The workspace as Blockly JSON (what the compiler and the worker consume). */
  save(): unknown;
  /** Puts warning icons on the blocks named by compile issues (clears old ones). */
  showIssues(issues: readonly CompileIssue[]): void;
  /** Highlights, selects and scrolls to a block that failed at runtime. */
  highlightError(blockId: string, message: string): void;
  resize(): void;
  /** Replaces the workspace with the SMA-cross example. */
  resetToExample(): void;
  /**
   * Indicator registrations changed (Pine scripts saved / deleted): redefines blocks, rebuilds the toolbox and
   * reloads the current workspace so blocks pick up new shapes; then recompiles (onChange) even if unchanged.
   */
  refreshIndicators(): void;
  /** How the workspace was restored on startup. */
  readonly restored: 'storage' | 'default' | 'default-after-error';
  /** Why the saved workspace could not be loaded (with restored = 'default-after-error'). */
  readonly loadError?: string;
}

/** Copy of a saved workspace that failed to load; never overwritten by edits. */
export const WORKSPACE_BACKUP_KEY = 'quant-sim.blocks.workspace.unloadable';

/**
 * Injects the Blockly workspace into `container`, restores the saved workspace (falling back to the example),
 * and calls `onChange(json)` (debounced) after every real edit and once after loading. Edits are persisted to
 * localStorage; a failed write only means it is not remembered.
 */
export function createBlockEditor(
  container: HTMLElement,
  onChange: (json: unknown) => void,
  onLoadError: (message: string) => void = () => {},
): BlockEditor {
  defineBlocks();
  const ws = Blockly.inject(container, {
    toolbox: buildToolbox() as unknown as Blockly.utils.toolbox.ToolboxDefinition,
    theme: quantTheme(),
    renderer: 'zelos',
    trashcan: true,
    sounds: false,
    grid: { spacing: 24, length: 2, colour: '#2a2e39', snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.65, maxScale: 2, minScale: 0.3, scaleSpeed: 1.15 },
    move: { scrollbars: true, drag: true, wheel: false },
    maxInstances: { ...HAT_MAX_INSTANCES },
  });

  let loading = false;
  let lastJson = '';
  /** False while the editor shows something other than the saved workspace that failed to load. */
  let persist = true;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Scrolls so the top-left corner of the script is visible (not hidden under the toolbox). */
  const showTopLeft = () => {
    if (ws.getTopBlocks(false).length === 0) return;
    const box = ws.getBlocksBoundingBox();
    ws.scrollBoundsIntoView(new Blockly.utils.Rect(box.top, box.top + 40, box.left, box.left + 120), 16);
  };

  /** Loads `state`; on failure the workspace is left untouched and the error returned. */
  const load = (state: unknown, keepView = false): LoadResult => {
    let result: LoadResult;
    loading = true;
    try {
      // Indicator blocks may have changed shape (edited Pine script) or lost their definition (deleted one).
      const { workspace, missingTypes } = fixupIndicatorBlocks(state);
      defineMissingIndicatorBlocks(missingTypes);
      result = loadWorkspaceSafely(ws, workspace);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      loading = false;
    }
    if (result.ok && !keepView) requestAnimationFrame(showTopLeft);
    return result;
  };

  const emit = () => {
    const json = Blockly.serialization.workspaces.save(ws);
    const text = JSON.stringify(json);
    if (text === lastJson) return;
    lastJson = text;
    ws.highlightBlock(null);
    if (persist) saveJson(WORKSPACE_STORAGE_KEY, json);
    onChange(json);
  };

  let restored: BlockEditor['restored'] = 'storage';
  let loadError: string | undefined;
  const saved = loadJson(WORKSPACE_STORAGE_KEY);
  if (saved === undefined) {
    load(defaultWorkspace());
    restored = 'default';
  } else {
    const result = load(saved);
    if (!result.ok) {
      // Keep the saved copy untouched (and backed up); show the example without persisting it.
      saveJson(WORKSPACE_BACKUP_KEY, saved);
      persist = false;
      load(defaultWorkspace());
      restored = 'default-after-error';
      loadError = result.error;
    }
  }

  ws.addChangeListener((event) => {
    if (loading || event.isUiEvent) return;
    clearTimeout(timer);
    timer = setTimeout(emit, 250);
  });
  // Report the restored workspace once the listeners of the caller exist.
  queueMicrotask(emit);

  return {
    restored,
    loadError,
    save: () => Blockly.serialization.workspaces.save(ws),
    showIssues(issues) {
      const byBlock = new Map<string, string[]>();
      for (const issue of issues) {
        if (issue.blockId) byBlock.set(issue.blockId, [...(byBlock.get(issue.blockId) ?? []), issue.message]);
      }
      for (const block of ws.getAllBlocks(false)) {
        const messages = byBlock.get(block.id);
        block.setWarningText(messages ? messages.join('\n') : null, ISSUE_WARNING_ID);
      }
    },
    highlightError(blockId, message) {
      const block = ws.getBlockById(blockId);
      if (!block) return;
      ws.centerOnBlock(blockId);
      ws.highlightBlock(blockId);
      block.setWarningText(message, ISSUE_WARNING_ID);
    },
    resize: () => Blockly.svgResize(ws),
    resetToExample() {
      if (!load(defaultWorkspace()).ok) return;
      persist = true;
      emit();
    },
    refreshIndicators() {
      const json = Blockly.serialization.workspaces.save(ws);
      const { scrollX, scrollY } = ws;
      defineBlocks();
      ws.updateToolbox(buildToolbox() as unknown as Blockly.utils.toolbox.ToolboxDefinition);
      const result = load(json, true);
      if (!result.ok) {
        // The workspace still shows (and storage still holds) the previous blocks.
        onLoadError(`The blocks could not be updated for the changed Pine scripts: ${result.error}`);
        return;
      }
      ws.scroll(scrollX, scrollY);
      lastJson = '';
      emit();
    },
  };
}
