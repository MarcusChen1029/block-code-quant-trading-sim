import { isPriceSource } from '../blocks/priceSource';
import {
  getIndicator, listIndicators, PINE_ID_PREFIX, registerIndicator, unregisterIndicator, type IndicatorBlockDef,
} from '../blocks/registry';
import { compilePine, slugIdentifier, type PineScript } from './compile';
import type { PineDiagnostic } from './diagnostics';

/** What is persisted (localStorage) and sent to the worker: the id is fixed when the script is first saved. */
export interface PineSourceRecord {
  id: string;
  source: string;
}

export interface PineSyncResult {
  id: string;
  ok: boolean;
  title?: string;
  errors: PineDiagnostic[];
  warnings: PineDiagnostic[];
}

const PINE_ID = /^pine_[a-z0-9_]{1,35}$/;

export function isPineId(id: unknown): id is string {
  return typeof id === 'string' && PINE_ID.test(id);
}

/** A registry id for a new script: `pine_<slug of title>`, deduplicated against `existing`. */
export function pineIdFor(title: string, existing: Iterable<string>): string {
  const taken = new Set([...existing].filter((id) => id.startsWith(PINE_ID_PREFIX)).map((id) => id.slice(PINE_ID_PREFIX.length)));
  return PINE_ID_PREFIX + slugIdentifier(title, 'script', taken, 30);
}

/** Records from untrusted JSON (storage, worker messages): keeps well-formed entries with unique ids. */
export function parsePineRecords(raw: unknown): PineSourceRecord[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PineSourceRecord[] = [];
  for (const r of raw) {
    const { id, source } = (typeof r === 'object' && r !== null ? r : {}) as Record<string, unknown>;
    if (!isPineId(id) || typeof source !== 'string' || seen.has(id) || source.length > 200_000) continue;
    seen.add(id);
    out.push({ id, source });
  }
  return out;
}

/** The registry definition of a compiled script (pane from overlay, params from inputs, outputs from plots). */
export function pineIndicatorDef(id: string, script: PineScript): IndicatorBlockDef {
  const source = script.sources[0]?.default;
  const extraSources = script.sources.slice(1).map((s) => `${s.title} = ${s.default}`);
  return {
    id,
    label: script.title,
    tooltip: `Pine script "${script.title}".` + (extraSources.length ? ` Other sources use their defaults (${extraSources.join(', ')}).` : ''),
    pane: script.overlay ? 'price' : 'sub',
    ...(source && isPriceSource(source) ? { source } : {}),
    params: script.inputs.map((input) => ({
      name: input.name,
      label: input.kind === 'bool' ? `${input.title} (0/1)` : input.title,
      default: input.default,
      ...(input.min !== undefined ? { min: input.min } : {}),
      ...(input.max !== undefined ? { max: input.max } : {}),
      ...(input.kind !== 'float' ? { integer: true } : {}),
    })),
    outputs: script.plots.map((p) => ({ key: p.key, label: p.title })),
    create(params) {
      const instance = script.create(params);
      return { step: (src, candle) => instance.step(script.sources.length > 0 ? src : undefined, candle) };
    },
  };
}

/** Sources currently registered in this JS realm, by id. */
const registered = new Map<string, string>();

/**
 * Makes this realm's registry hold exactly the given scripts: compiles new or changed sources, unregisters
 * deleted, changed and failing ones. Main thread (toolbox, overlays) and worker (runs) each call it.
 */
export function syncPineIndicators(records: readonly PineSourceRecord[]): PineSyncResult[] {
  const wanted = new Map(parsePineRecords(records).map((r) => [r.id, r.source]));
  for (const def of listIndicators()) {
    if (def.id.startsWith(PINE_ID_PREFIX) && wanted.get(def.id) !== registered.get(def.id)) {
      unregisterIndicator(def.id);
      registered.delete(def.id);
    }
  }
  const results: PineSyncResult[] = [];
  for (const [id, source] of wanted) {
    // Each stored script is isolated: a bad (or hostile) one is reported and skipped, never breaks the others.
    try {
      const result = compilePine(source);
      if (!result.ok) {
        results.push({ id, ok: false, errors: result.errors, warnings: result.warnings });
        continue;
      }
      if (!getIndicator(id)) {
        registerIndicator(pineIndicatorDef(id, result.script));
        registered.set(id, source);
      }
      results.push({ id, ok: true, title: result.script.title, errors: [], warnings: result.warnings });
    } catch (err) {
      const message = `could not load this script: ${err instanceof Error ? err.message : String(err)}`;
      results.push({ id, ok: false, errors: [{ line: 1, col: 1, message }], warnings: [] });
    }
  }
  return results;
}
