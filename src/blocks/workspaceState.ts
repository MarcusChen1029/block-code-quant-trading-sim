/**
 * The subset of Blockly's JSON serialization (`Blockly.serialization.workspaces.save`) the generator reads.
 * Verified against blockly 13.3.0. Everything is optional/unknown because saved workspaces come from
 * localStorage and must be treated as untrusted input.
 */
export interface ConnectionState {
  block?: BlockState;
  shadow?: BlockState;
}

export interface BlockState {
  type: string;
  id?: string;
  x?: number;
  y?: number;
  enabled?: boolean;
  disabledReasons?: string[];
  extraState?: unknown;
  /** Blockly's per-block user data string (we keep a stale dropdown choice there, see staleChoice.ts). */
  data?: unknown;
  fields?: Record<string, unknown>;
  inputs?: Record<string, ConnectionState>;
  next?: ConnectionState;
}

export interface VariableState {
  name: string;
  id: string;
  type?: string;
}

export interface WorkspaceState {
  blocks?: { languageVersion?: number; blocks?: BlockState[] };
  variables?: VariableState[];
}

/** The block plugged into a connection; a real block wins over its shadow (Blockly semantics). */
export function connected(conn: ConnectionState | undefined): BlockState | undefined {
  return conn?.block ?? conn?.shadow;
}

export function isEnabled(block: BlockState): boolean {
  return block.enabled !== false && !(Array.isArray(block.disabledReasons) && block.disabledReasons.length > 0);
}
