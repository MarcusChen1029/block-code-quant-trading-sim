import type { Candle } from '../data/types';
import { BUILTIN_INDICATORS } from './builtinIndicators';
import type { PriceSource } from './priceSource';

/** A numeric parameter; it becomes a number field on the block (constant for the whole run). */
export interface IndicatorParam {
  /** Identifier, e.g. 'length'. The block field is named `name.toUpperCase()`. */
  name: string;
  label: string;
  default: number;
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface IndicatorOutput {
  /** Identifier, e.g. 'signal'. */
  key: string;
  label: string;
}

/**
 * One stateful, incremental indicator instance. `step` is called exactly once per closed bar, in bar order,
 * and returns one value per output key (NaN = na).
 */
export interface IndicatorInstance {
  step(source: number, candle: Candle): Record<string, number>;
}

/**
 * An indicator offered as a block. Built-ins are registered below; later work (Pine-compiled indicators)
 * registers more with `registerIndicator`. The registry is per JS realm: whatever compiles block strategies
 * (main thread for the editor and overlays, the worker for runs) must have the same registrations.
 */
export interface IndicatorBlockDef {
  /** Registry key and block type suffix (`ind_<id>`); lowercase identifier. */
  id: string;
  /** Text on the block, e.g. 'SMA'. */
  label: string;
  tooltip: string;
  /** Where its chart overlay goes. */
  pane: 'price' | 'sub';
  params: IndicatorParam[];
  /** When set, the block has a SOURCE value input whose default (shadow) reads this bar value. */
  source?: PriceSource;
  /** At least one; more than one gives the block an output dropdown. */
  outputs: IndicatorOutput[];
  create(params: Record<string, number>): IndicatorInstance;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;
const registry = new Map<string, IndicatorBlockDef>();

/** Adds an indicator block definition. Throws on a malformed definition or a duplicate id. */
export function registerIndicator(def: IndicatorBlockDef): void {
  if (!IDENTIFIER.test(def.id)) throw new Error(`indicator id must be a lowercase identifier, got "${def.id}"`);
  if (registry.has(def.id)) throw new Error(`indicator "${def.id}" is already registered`);
  if (def.outputs.length === 0) throw new Error(`indicator "${def.id}" needs at least one output`);
  for (const item of [...def.params.map((p) => p.name), ...def.outputs.map((o) => o.key)]) {
    if (!IDENTIFIER.test(item)) throw new Error(`indicator "${def.id}": "${item}" is not a lowercase identifier`);
  }
  registry.set(def.id, def);
}

/** Removes a registered indicator (used when a Pine script is edited or deleted). Returns whether it existed. */
export function unregisterIndicator(id: string): boolean {
  return registry.delete(id);
}

const missingTitles = new Map<string, string>();

/**
 * Last known titles of indicators that are not registered (deleted Pine scripts, scripts that no longer
 * compile), so errors and placeholder blocks can name them. Replaces the previous set.
 */
export function setMissingIndicatorTitles(titles: Iterable<readonly [string, string]>): void {
  missingTitles.clear();
  for (const [id, title] of titles) missingTitles.set(id, title);
}

export function missingIndicatorTitle(id: string): string | undefined {
  return missingTitles.get(id);
}

/** Registry ids of Pine-compiled indicators start with this. */
export const PINE_ID_PREFIX = 'pine_';

export function getIndicator(id: string): IndicatorBlockDef | undefined {
  return registry.get(id);
}

/** All registered indicators in registration order (built-ins first). */
export function listIndicators(): IndicatorBlockDef[] {
  return [...registry.values()];
}

export const INDICATOR_BLOCK_PREFIX = 'ind_';

export function indicatorBlockType(id: string): string {
  return INDICATOR_BLOCK_PREFIX + id;
}

/** Field name of a parameter on the block. */
export function paramFieldName(param: IndicatorParam): string {
  return param.name.toUpperCase();
}

for (const def of BUILTIN_INDICATORS) registerIndicator(def);
