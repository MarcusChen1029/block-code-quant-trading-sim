import * as Blockly from 'blockly';
import { HAT_MAX_INSTANCES } from '../blocks/blockTypes';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { zoneExampleWorkspace } from '../blocks/zoneExample';
import { defineBlocks, defineMissingIndicatorBlocks } from '../blocks/definitions';
import type { CompileIssue } from '../blocks/generator';
import { quantTheme } from '../blocks/theme';
import { buildToolbox } from '../blocks/toolbox';
import { readStaleChoice } from '../blocks/staleChoice';
import { fixupIndicatorBlocks } from '../blocks/workspaceFixup';
import { loadWorkspaceSafely, type LoadResult } from '../blocks/workspaceLoad';
import { BLOCK_GROUP_TEXT } from './descriptions';
import { loadJson, saveJson } from './storage';
import { currentTheme, onThemeChange } from './theme';

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
  /** Steps back / forward through the edits (the same as Ctrl+Z / Ctrl+Shift+Z in the editor). */
  undo(): void;
  redo(): void;
  /** Replaces the workspace with an example: the SMA cross (default) or the order block + FVG zones example. */
  resetToExample(example?: 'smaCross' | 'zones'): void;
  /**
   * Replaces the workspace with `state` (a starter, or a restored previous workspace) and saves it. Returns false
   * (workspace unchanged) when it cannot be loaded.
   */
  loadWorkspace(state: unknown): boolean;
  /** Zooms and scrolls so the whole strategy is visible (never zoomed in past 100 %). No-op while hidden. */
  fit(minScale?: number): void;
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
    theme: quantTheme(currentTheme()),
    renderer: 'zelos',
    trashcan: true,
    sounds: false,
    media: `${import.meta.env.BASE_URL}blockly-media/`, // Blockly's icons, served by this site (its default is a third-party CDN)
    grid: { spacing: 24, length: 2, colour: '#7a829e', snap: true },
    zoom: { controls: true, wheel: true, startScale: 0.8, maxScale: 2, minScale: 0.2, scaleSpeed: 1.15 },
    move: { scrollbars: true, drag: true, wheel: false },
    maxInstances: { ...HAT_MAX_INSTANCES },
  });

  /** Hover notes for the block groups in the menu on the left (what each group is for). */
  const describeToolbox = () => {
    const toolbox = ws.getToolbox();
    if (!toolbox) return;
    for (const item of toolbox.getToolboxItems()) {
      const name = 'getName' in item && typeof item.getName === 'function' ? item.getName() : '';
      const text = BLOCK_GROUP_TEXT[name];
      const div = item.getDiv();
      if (text && div) div.setAttribute('data-tip', text);
    }
  };
  describeToolbox();
  onThemeChange((theme) => ws.setTheme(quantTheme(theme)));

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

  /** A fit asked for while the pane had no size (hidden tab / window); done on the next resize that gives it one. */
  let pendingFit = false;
  /** Pixels kept free on each side after a fit, so blocks clear the scrollbars (zoomToFit measures under them). */
  const FIT_PAD_PX = 24;
  const fit = (minScale = 0) => {
    if (ws.getTopBlocks(false).length === 0) return;
    if (container.clientWidth === 0 || container.clientHeight === 0) {
      pendingFit = true;
      return;
    }
    pendingFit = false;
    Blockly.svgResize(ws);
    Blockly.renderManagement.triggerQueuedRenders(ws); // renders are queued on animation frames, which stall while hidden
    ws.zoomToFit();
    const view = ws.getMetricsManager().getViewMetrics();
    const room = Math.min((view.width - 2 * FIT_PAD_PX) / view.width, (view.height - 2 * FIT_PAD_PX) / view.height);
    // `minScale` keeps automatic fits readable: a big strategy then scrolls instead of shrinking to tiny text.
    const target = Math.max(Math.min(1, ws.scale * Math.max(0.5, room)), Math.min(minScale, 1));
    ws.zoomCenter(Math.log(target / ws.scale) / Math.log(ws.options.zoomOptions.scaleSpeed));
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
    // Picking an output / signal clears the "your old choice no longer exists" marker (see staleChoice.ts).
    if (event instanceof Blockly.Events.BlockChange && event.element === 'field' && (event.name === 'OUT' || event.name === 'SIGOUT')) {
      const block = event.blockId ? ws.getBlockById(event.blockId) : null;
      if (block && readStaleChoice({ data: block.data }) !== null) block.data = null;
    }
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
    undo() { ws.undo(false); },
    redo() { ws.undo(true); },
    resize() {
      Blockly.svgResize(ws);
      if (pendingFit) fit();
    },
    resetToExample(example = 'smaCross') {
      if (!load(example === 'zones' ? zoneExampleWorkspace() : defaultWorkspace()).ok) return;
      persist = true;
      emit();
    },
    loadWorkspace(state) {
      const result = load(state, true);
      if (!result.ok) {
        onLoadError(`The blocks could not be loaded: ${result.error}`);
        return false;
      }
      persist = true;
      emit();
      return true;
    },
    fit,
    refreshIndicators() {
      const json = Blockly.serialization.workspaces.save(ws);
      const { scrollX, scrollY } = ws;
      defineBlocks();
      ws.updateToolbox(buildToolbox() as unknown as Blockly.utils.toolbox.ToolboxDefinition);
      describeToolbox();
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
