import type { BlockState } from './workspaceState';

/**
 * An indicator block's output (`OUT`) or signal (`SIGOUT`) choice that no longer exists (the Pine plot or signal
 * was renamed or removed). Blockly cannot keep an invalid dropdown value (it falls back to the first option), so
 * the choice is remembered in the block's serialized `data` string; the generator then refuses to compile the
 * block instead of silently reading another output. Cleared when the user picks a value in that dropdown, and
 * the old value is restored if the script gets that output back.
 */
export interface StaleChoice {
  field: 'OUT' | 'SIGOUT';
  key: string;
  title: string;
}

const PREFIX = 'quant-sim:stale-choice:';

/** The stale choice recorded on a block (data from saved, untrusted JSON), or null. */
export function readStaleChoice(block: Pick<BlockState, 'data'>): StaleChoice | null {
  const data = block.data;
  if (typeof data !== 'string' || !data.startsWith(PREFIX)) return null;
  try {
    const v = JSON.parse(data.slice(PREFIX.length)) as Record<string, unknown>;
    if ((v.field === 'OUT' || v.field === 'SIGOUT') && typeof v.key === 'string' && typeof v.title === 'string') {
      return { field: v.field, key: v.key.slice(0, 100), title: v.title.slice(0, 200) };
    }
  } catch {
    // malformed: ignore
  }
  return null;
}

export function staleChoiceData(choice: StaleChoice): string {
  return PREFIX + JSON.stringify(choice);
}
