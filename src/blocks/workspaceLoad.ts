import * as Blockly from 'blockly';

export type LoadResult = { ok: true } | { ok: false; error: string };

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Replaces the contents of `ws` with `state` only if `state` loads cleanly. It is first loaded into a scratch
 * headless workspace (same block definitions); if that throws, `ws` is left exactly as it was, so a bad saved
 * workspace never ends up as a blank one that the next edit would persist.
 */
export function loadWorkspaceSafely(ws: Blockly.Workspace, state: unknown): LoadResult {
  const scratch = new Blockly.Workspace();
  try {
    Blockly.serialization.workspaces.load(state as Record<string, unknown>, scratch);
  } catch (err) {
    return { ok: false, error: message(err) };
  } finally {
    scratch.dispose();
  }
  const previous = Blockly.serialization.workspaces.save(ws);
  try {
    ws.clear();
    Blockly.serialization.workspaces.load(state as Record<string, unknown>, ws);
    return { ok: true };
  } catch (err) {
    // Rendering-only failure (the scratch load passed): put the previous contents back.
    ws.clear();
    try {
      Blockly.serialization.workspaces.load(previous, ws);
    } catch {
      // Nothing more to do; the caller keeps the stored copy untouched.
    }
    return { ok: false, error: message(err) };
  }
}
