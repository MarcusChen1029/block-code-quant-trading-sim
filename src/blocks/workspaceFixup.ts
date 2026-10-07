import {
  blockParams, getIndicator, INDICATOR_BLOCK_PREFIX, paramFieldName, rememberedChoiceTitle, SIGNAL_BLOCK_PREFIX, type IndicatorBlockDef,
} from './registry';
import { readStaleChoice, staleChoiceData } from './staleChoice';
import type { BlockState, ConnectionState } from './workspaceState';

/** The definition behind an `ind_` / `sig_` block when that block kind still exists, else undefined. */
function liveDef(type: string): { def: IndicatorBlockDef; kind: 'ind' | 'sig' } | undefined {
  if (type.startsWith(INDICATOR_BLOCK_PREFIX)) {
    const def = getIndicator(type.slice(INDICATOR_BLOCK_PREFIX.length));
    return def && def.outputs.length > 0 ? { def, kind: 'ind' } : undefined;
  }
  const def = getIndicator(type.slice(SIGNAL_BLOCK_PREFIX.length));
  return def && (def.signals ?? []).length > 0 ? { def, kind: 'sig' } : undefined;
}

/**
 * Prepares saved workspace JSON for Blockly after indicator definitions changed (a Pine script was edited or
 * deleted). Blockly throws on inputs a block no longer has, so indicator and signal blocks keep only the inputs
 * and fields of their current definition; blocks whose indicator (or that kind of output) is gone keep only
 * SOURCE (their placeholder has it). Returns a cleaned copy plus the block types that have no definition.
 * Pure (no Blockly).
 */
export function fixupIndicatorBlocks(workspace: unknown): { workspace: unknown; missingTypes: string[] } {
  const missing = new Set<string>();
  const copy = structuredClone(workspace) as { blocks?: { blocks?: unknown } };

  const visitConn = (conn: ConnectionState | undefined) => {
    if (!conn || typeof conn !== 'object') return;
    visit(conn.block);
    visit(conn.shadow);
  };
  const visit = (block: BlockState | undefined) => {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') return;
    if (block.type.startsWith(INDICATOR_BLOCK_PREFIX) || block.type.startsWith(SIGNAL_BLOCK_PREFIX)) {
      const live = liveDef(block.type);
      const inputs = block.inputs && typeof block.inputs === 'object' ? block.inputs : {};
      const keepSource = live ? live.def.source !== undefined : true;
      block.inputs = keepSource && inputs.SOURCE ? { SOURCE: inputs.SOURCE } : {};
      if (live) {
        const { def, kind } = live;
        const choice = kind === 'ind' ? (def.outputs.length > 1 ? 'OUT' : null) : 'SIGOUT';
        const choices = kind === 'ind' ? def.outputs : def.signals ?? [];
        const allowed = new Set([...blockParams(def, kind).map(paramFieldName), ...(choice ? [choice] : [])]);
        const fields = block.fields && typeof block.fields === 'object' ? block.fields : {};
        // The choice field is checked even when the dropdown is gone (a script down to one output).
        const field = kind === 'ind' ? 'OUT' : 'SIGOUT';
        const stale = readStaleChoice(block);
        const chosen = fields[field];
        if (stale && stale.field === field) {
          // An earlier vanished choice wins over the dropdown's fallback value; restored once the script has it again.
          if (choices.some((o) => o.key === stale.key)) {
            if (choice) fields[choice] = stale.key;
            delete block.data;
          }
        } else if (chosen !== undefined && !choices.some((o) => o.key === chosen)) {
          // The chosen output / signal is gone: remember it (Blockly will show the first option) so it errors.
          const key = String(chosen);
          block.data = staleChoiceData({ field, key, title: rememberedChoiceTitle(def.id, field, key) ?? key });
        }
        block.fields = Object.fromEntries(Object.entries(fields).filter(([k, v]) => {
          if (!allowed.has(k)) return false;
          return k !== choice || choices.some((o) => o.key === v);
        }));
      } else {
        missing.add(block.type);
      }
    }
    for (const conn of Object.values(block.inputs ?? {})) visitConn(conn);
    visitConn(block.next);
  };

  const top = copy?.blocks?.blocks;
  if (Array.isArray(top)) for (const b of top) visit(b as BlockState);
  return { workspace: copy, missingTypes: [...missing] };
}
