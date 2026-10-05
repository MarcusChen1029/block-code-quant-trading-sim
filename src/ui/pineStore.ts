import { isPineId, parsePineRecords, type PineSourceRecord } from '../pine/library';
import { loadJson, saveJson } from './storage';

export const PINE_SCRIPTS_KEY = 'quant-sim.pine.scripts.v1';
export const PINE_DRAFT_KEY = 'quant-sim.pine.draft.v1';

/** Saved (successfully compiled) Pine scripts; malformed storage just means none. */
export function loadPineRecords(): PineSourceRecord[] {
  return parsePineRecords(loadJson(PINE_SCRIPTS_KEY));
}

export function savePineRecords(records: readonly PineSourceRecord[]): boolean {
  return saveJson(PINE_SCRIPTS_KEY, records);
}

/** The text in the editor (may not compile yet), so a reload does not lose work. `id` null = a new script. */
export interface PineDraft {
  id: string | null;
  source: string;
}

export function loadPineDraft(): PineDraft | null {
  const raw = loadJson(PINE_DRAFT_KEY) as Partial<PineDraft> | undefined;
  if (!raw || typeof raw !== 'object' || typeof raw.source !== 'string') return null;
  return { id: isPineId(raw.id) ? raw.id : null, source: raw.source };
}

export function savePineDraft(draft: PineDraft | null): void {
  saveJson(PINE_DRAFT_KEY, draft);
}
