import * as Blockly from 'blockly';
import { defaultWorkspace } from '../blocks/defaultWorkspace';
import { defineBlocks } from '../blocks/definitions';
import type { CompileIssue } from '../blocks/generator';
import { quantTheme } from '../blocks/theme';
import { buildToolbox } from '../blocks/toolbox';
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
  /** How the workspace was restored on startup. */
  readonly restored: 'storage' | 'default' | 'default-after-error';
}

/**
 * Injects the Blockly workspace into `container`, restores the saved workspace (falling back to the example),
 * and calls `onChange(json)` (debounced) after every real edit and once after loading. Edits are persisted to
 * localStorage; a failed write only means it is not remembered.
 */
export function createBlockEditor(container: HTMLElement, onChange: (json: unknown) => void): BlockEditor {
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
  });

  let loading = false;
  let lastJson = '';
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Scrolls so the top-left corner of the script is visible (not hidden under the toolbox). */
  const showTopLeft = () => {
    if (ws.getTopBlocks(false).length === 0) return;
    const box = ws.getBlocksBoundingBox();
    ws.scrollBoundsIntoView(new Blockly.utils.Rect(box.top, box.top + 40, box.left, box.left + 120), 16);
  };

  const load = (state: unknown) => {
    loading = true;
    try {
      ws.clear();
      Blockly.serialization.workspaces.load(state as Record<string, unknown>, ws);
    } finally {
      loading = false;
    }
    requestAnimationFrame(showTopLeft);
  };

  const emit = () => {
    const json = Blockly.serialization.workspaces.save(ws);
    const text = JSON.stringify(json);
    if (text === lastJson) return;
    lastJson = text;
    ws.highlightBlock(null);
    saveJson(WORKSPACE_STORAGE_KEY, json);
    onChange(json);
  };

  let restored: BlockEditor['restored'] = 'storage';
  const saved = loadJson(WORKSPACE_STORAGE_KEY);
  if (saved === undefined) {
    load(defaultWorkspace());
    restored = 'default';
  } else {
    try {
      load(saved);
    } catch {
      load(defaultWorkspace());
      restored = 'default-after-error';
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
      load(defaultWorkspace());
      emit();
    },
  };
}
