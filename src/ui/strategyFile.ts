/**
 * Saving the blocks to a file and opening one again ("Start from…" -> Your files). The file is plain JSON: a small
 * wrapper around the Blockly workspace, so it can be sent to a friend or kept in a folder.
 */
export const STRATEGY_FILE_APP = 'quant-sim';
export const STRATEGY_FILE_KIND = 'blocks-workspace';
export const STRATEGY_FILE_VERSION = 1;
/** Bigger files are refused before parsing (a strategy is a few kB). */
export const MAX_STRATEGY_FILE_BYTES = 2_000_000;

export interface StrategyFile {
  app: typeof STRATEGY_FILE_APP;
  kind: typeof STRATEGY_FILE_KIND;
  version: number;
  savedAt: string;
  workspace: unknown;
}

/** The text to write to a file. */
export function serializeStrategy(workspace: unknown, now: number): string {
  const file: StrategyFile = {
    app: STRATEGY_FILE_APP, kind: STRATEGY_FILE_KIND, version: STRATEGY_FILE_VERSION, savedAt: new Date(now).toISOString(), workspace,
  };
  return `${JSON.stringify(file, null, 2)}\n`;
}

export type ParsedStrategy = { ok: true; workspace: unknown } | { ok: false; error: string };

const hasBlocks = (v: unknown): boolean => {
  const blocks = (v as { blocks?: { blocks?: unknown } } | null)?.blocks?.blocks;
  return Array.isArray(blocks);
};

/**
 * Reads a strategy file. Accepts our wrapper and, for convenience, a bare Blockly workspace. The block editor does
 * the real validation when it loads the workspace (and keeps the old one if that fails); this only rules out files
 * that are clearly something else, with a message a beginner can act on.
 */
export function parseStrategyFile(text: string): ParsedStrategy {
  if (text.length > MAX_STRATEGY_FILE_BYTES) return { ok: false, error: 'That file is too big to be a strategy.' };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: 'That file is not a strategy file (it is not valid JSON).' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return { ok: false, error: 'That file is not a strategy file.' };
  const wrapped = json as Partial<StrategyFile>;
  if (wrapped.app === STRATEGY_FILE_APP) {
    if (wrapped.kind !== STRATEGY_FILE_KIND) return { ok: false, error: 'That Quant Sim file does not hold blocks.' };
    if (typeof wrapped.version === 'number' && wrapped.version > STRATEGY_FILE_VERSION) {
      return { ok: false, error: 'That file was saved by a newer version of Quant Sim. Please update this page and try again.' };
    }
    return hasBlocks(wrapped.workspace) ? { ok: true, workspace: wrapped.workspace } : { ok: false, error: 'That file has no blocks in it.' };
  }
  return hasBlocks(json) ? { ok: true, workspace: json } : { ok: false, error: 'That file is not a Quant Sim strategy.' };
}

/** "My robot!.json" -> "My robot!" (the label shown in messages). */
export function strategyLabelFromFileName(name: string): string {
  const base = name.replace(/\.[^.]*$/, '').trim();
  return base === '' ? 'Opened file' : base.slice(0, 60);
}
