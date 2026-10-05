import { getIndicator, INDICATOR_BLOCK_PREFIX, paramFieldName } from './registry';
import type { BlockState, ConnectionState } from './workspaceState';

/**
 * Prepares saved workspace JSON for Blockly after indicator definitions changed (a Pine script was edited or
 * deleted). Blockly throws on inputs a block no longer has, so indicator blocks keep only the inputs and fields
 * of their current definition; blocks whose indicator is gone keep only SOURCE (their placeholder has it).
 * Returns a cleaned copy plus the indicator block types that have no definition. Pure (no Blockly).
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
    if (block.type.startsWith(INDICATOR_BLOCK_PREFIX)) {
      const def = getIndicator(block.type.slice(INDICATOR_BLOCK_PREFIX.length));
      const inputs = block.inputs && typeof block.inputs === 'object' ? block.inputs : {};
      const keepSource = def ? def.source !== undefined : true;
      block.inputs = keepSource && inputs.SOURCE ? { SOURCE: inputs.SOURCE } : {};
      if (def) {
        const allowed = new Set([...def.params.map(paramFieldName), ...(def.outputs.length > 1 ? ['OUT'] : [])]);
        const fields = block.fields && typeof block.fields === 'object' ? block.fields : {};
        block.fields = Object.fromEntries(Object.entries(fields).filter(([k, v]) => {
          if (!allowed.has(k)) return false;
          return k !== 'OUT' || def.outputs.some((o) => o.key === v);
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
