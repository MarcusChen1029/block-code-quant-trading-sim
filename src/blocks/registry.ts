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
  /** Only shown on (and only affects) the signal block, e.g. RSI's overbought level. The numeric block omits it. */
  signalOnly?: boolean;
}

export interface IndicatorOutput {
  /** Identifier, e.g. 'signal'. */
  key: string;
  label: string;
}

/** How a signal is drawn on the chart. 'price': at the price from IndicatorInstance.markerPrice (else above the bar). */
export interface SignalMarker {
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  location: 'aboveBar' | 'belowBar' | 'price';
  /** CSS colour from a fixed table / validated literal; default by side. */
  color?: string;
  /** Text next to the marker (default: the signal label). */
  text?: string;
}

/**
 * A true/false event output (buy/sell signal). The instance returns 1 (fired on this bar) or 0 under `key`,
 * alongside the numeric outputs. Keys are unique across outputs and signals. (A later "zone" output kind is meant
 * to sit next to this one as its own optional list.)
 */
export interface SignalOutput {
  key: string;
  label: string;
  marker?: SignalMarker;
}

/**
 * One stateful, incremental indicator instance. `step` is called exactly once per closed bar, in bar order,
 * and returns one value per output key (NaN = na).
 */
export interface IndicatorInstance {
  step(source: number, candle: Candle): Record<string, number>;
  /** Marker price of signal `key` on the last stepped bar, for markers located at 'price' (NaN = none). */
  markerPrice?(key: string): number;
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
  /**
   * Numeric outputs: more than one gives the block an output dropdown. May be empty only when there are signals
   * (then there is no numeric block, only the signal block).
   */
  outputs: IndicatorOutput[];
  /** Signal outputs: they get a second, Boolean block type `sig_<id>` with a dropdown of them. */
  signals?: SignalOutput[];
  create(params: Record<string, number>): IndicatorInstance;
}

const IDENTIFIER = /^[a-z][a-z0-9_]{0,40}$/;
const registry = new Map<string, IndicatorBlockDef>();

/** Adds an indicator block definition. Throws on a malformed definition or a duplicate id. */
export function registerIndicator(def: IndicatorBlockDef): void {
  if (!IDENTIFIER.test(def.id)) throw new Error(`indicator id must be a lowercase identifier, got "${def.id}"`);
  if (registry.has(def.id)) throw new Error(`indicator "${def.id}" is already registered`);
  const signals = def.signals ?? [];
  if (def.outputs.length === 0 && signals.length === 0) throw new Error(`indicator "${def.id}" needs at least one output`);
  for (const item of [...def.params.map((p) => p.name), ...def.outputs.map((o) => o.key), ...signals.map((o) => o.key)]) {
    if (!IDENTIFIER.test(item)) throw new Error(`indicator "${def.id}": "${item}" is not a lowercase identifier`);
  }
  const keys = [...def.outputs.map((o) => o.key), ...signals.map((o) => o.key)];
  if (new Set(keys).size !== keys.length) throw new Error(`indicator "${def.id}": output and signal keys must be unique`);
  registry.set(def.id, def);
  for (const o of def.outputs) seenTitles.set(`${def.id}|OUT|${o.key}`, o.label);
  for (const s of signals) seenTitles.set(`${def.id}|SIGOUT|${s.key}`, s.label);
}

/** Titles of every output / signal key registered in this realm, so a block whose choice vanished can name it. */
const seenTitles = new Map<string, string>();

/** The title an output (`OUT`) or signal (`SIGOUT`) key of indicator `id` had when it was last registered. */
export function rememberedChoiceTitle(id: string, field: 'OUT' | 'SIGOUT', key: string): string | undefined {
  return seenTitles.get(`${id}|${field}|${key}`);
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

export const SIGNAL_BLOCK_PREFIX = 'sig_';

/** Boolean block of an indicator's signals. */
export function signalBlockType(id: string): string {
  return SIGNAL_BLOCK_PREFIX + id;
}

/** Parameters shown on a block: the numeric block leaves out signal-only ones. */
export function blockParams(def: IndicatorBlockDef, kind: 'ind' | 'sig'): IndicatorParam[] {
  return kind === 'sig' ? def.params : def.params.filter((p) => !p.signalOnly);
}

/** Field name of a parameter on the block. */
export function paramFieldName(param: IndicatorParam): string {
  return param.name.toUpperCase();
}

for (const def of BUILTIN_INDICATORS) registerIndicator(def);
