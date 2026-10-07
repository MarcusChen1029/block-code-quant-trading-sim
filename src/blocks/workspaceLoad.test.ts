import * as Blockly from 'blockly';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { BT, HAT_MAX_INSTANCES } from './blockTypes';
import { defaultWorkspace } from './defaultWorkspace';
import { defineBlocks } from './definitions';
import { loadWorkspaceSafely } from './workspaceLoad';

/**
 * Blockly dispatches events (and fills the undo stack) asynchronously: in Node through setTimeout, so fake
 * timers flush them deterministically. A browser uses requestAnimationFrame, which a hidden window never runs.
 */
const flush = () => vi.runAllTimers();
const hats = (ws: Blockly.Workspace) => ({
  event_start: ws.getTopBlocks(false).filter((b) => b.type === 'event_start').length,
  event_bar: ws.getTopBlocks(false).filter((b) => b.type === 'event_bar').length,
});

// Blockly's event queue is global: every test runs on fake timers and drains it, or a pending real timer
// would leave the queue non-empty and later flushes would dispatch nothing.
beforeEach(() => {
  vi.useFakeTimers();
  defineBlocks();
});

afterEach(() => {
  flush();
  vi.useRealTimers();
});

describe('event hats are single-instance (Blockly maxInstances)', () => {
  it('with one of each hat loaded, no capacity is left for another (toolbox greys out, paste is refused)', () => {
    const ws = new Blockly.Workspace(new Blockly.Options({ maxInstances: { ...HAT_MAX_INSTANCES } }));
    expect(ws.isCapacityAvailable({ [BT.start]: 1 })).toBe(true);
    Blockly.serialization.workspaces.load(defaultWorkspace() as Record<string, unknown>, ws);
    expect(hats(ws)).toEqual({ event_start: 1, event_bar: 1 });
    expect(ws.isCapacityAvailable({ [BT.start]: 1 })).toBe(false);
    expect(ws.isCapacityAvailable({ [BT.bar]: 1 })).toBe(false);
    expect(ws.isCapacityAvailable({ [BT.marketOrder]: 3 })).toBe(true);
    ws.dispose();
  });
});

describe('reloading a workspace (Pine refresh, Reset to example) is not undoable', () => {
  let ws: Blockly.Workspace;

  beforeEach(() => {
    ws = new Blockly.Workspace();
  });

  afterEach(() => {
    ws.dispose();
  });

  it('Ctrl+Z after a reload does not bring back the cleared blocks next to the reloaded ones', () => {
    expect(loadWorkspaceSafely(ws, defaultWorkspace())).toEqual({ ok: true });
    flush();
    // What refreshIndicators() does after a Pine script is saved: reload the same workspace.
    expect(loadWorkspaceSafely(ws, Blockly.serialization.workspaces.save(ws))).toEqual({ ok: true });
    flush();
    for (let i = 0; i < 5; i++) {
      ws.undo(false);
      flush();
    }
    expect(hats(ws)).toEqual({ event_start: 1, event_bar: 1 });
    expect(ws.getUndoStack()).toHaveLength(0);
  });

  it('undo after a user edit and a reload never crosses the reload (no stale events from the old blocks)', () => {
    loadWorkspaceSafely(ws, defaultWorkspace());
    flush();
    ws.getTopBlocks(false).find((b) => b.type === 'event_start')!.dispose(false); // a user edit
    flush();
    expect(ws.getUndoStack().length).toBeGreaterThan(0);
    loadWorkspaceSafely(ws, defaultWorkspace()); // Reset to example
    flush();
    expect(ws.getUndoStack()).toHaveLength(0);
    ws.undo(false);
    flush();
    expect(hats(ws)).toEqual({ event_start: 1, event_bar: 1 });
  });
});
