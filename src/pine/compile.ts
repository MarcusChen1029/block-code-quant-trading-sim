import type { PriceSource } from '../blocks/priceSource';
import type { RuntimeLimits } from '../blocks/runtime';
import type { Candle } from '../data/types';
import type { CallExpr, Stmt } from './ast';
import { analyze, type InputKind } from './analyze';
import { generate, type InputBinding } from './codegen';
import { dialectFor } from './dialect';
import { byPosition, type PineDiagnostic, PineRuntimeError, PineSyntaxError } from './diagnostics';
import { parse } from './parser';
import { MAX_TA_LENGTH, PineRuntime } from './runtime';
import { forbiddenReferences, SHADOWED_GLOBALS } from './safety';
import { normalizeV4 } from './v4';
import type { SignalMarkerSpec, SignalSite } from './signals';
import { checkV6, exprTyper } from './v6';
import { detectVersion, type PineVersion } from './version';

/** A block parameter made from input.int / input.float / input.bool (bool -> 0/1). */
export interface PineInput {
  /** Block parameter name (lowercase identifier). */
  name: string;
  /** Pine variable name. */
  varName: string;
  kind: Exclude<InputKind, 'source'>;
  title: string;
  default: number;
  min?: number;
  max?: number;
}

/** An input.source (fed by the block's SOURCE input when it is the first one). */
export interface PineSourceInput {
  varName: string;
  title: string;
  default: PriceSource;
}

export interface PinePlot {
  /** Output key (lowercase identifier). */
  key: string;
  title: string;
}

/** A signal output (plotshape / plotchar / alertcondition / label.new): 1 on bars where it fires, else 0. */
export interface PineSignal {
  /** Output key (lowercase identifier, unique among plot and signal keys). */
  key: string;
  title: string;
  marker: SignalMarkerSpec;
}

/** One running copy of a script: `step` is called exactly once per closed bar, in bar order. */
export interface PineInstance {
  /**
   * `source` feeds the first input.source (undefined = its default price source). Returns one value per plot key
   * plus 1/0 per signal key.
   */
  step(source: number | undefined, candle: Candle): Record<string, number>;
  /** Marker price of signal `key` on the last stepped bar (label y, location.absolute series), NaN if none. */
  markerPrice(key: string): number;
}

export interface PineScript {
  /** Pine language version it was compiled as (from //@version, default 5). */
  version: PineVersion;
  title: string;
  shortTitle: string;
  overlay: boolean;
  inputs: PineInput[];
  sources: PineSourceInput[];
  plots: PinePlot[];
  signals: PineSignal[];
  warnings: PineDiagnostic[];
  /** The generated JS (for inspection and tests). */
  js: string;
  /**
   * New instance; `params` are keyed by PineInput.name (missing -> default). Throws on out-of-range values.
   * `limits` overrides the per-bar loop / time budget (tests inject a clock).
   */
  create(params?: Record<string, number>, limits?: RuntimeLimits): PineInstance;
}

export type PineCompileResult =
  | { ok: true; script: PineScript; warnings: PineDiagnostic[] }
  | { ok: false; errors: PineDiagnostic[]; warnings: PineDiagnostic[] };

const RESERVED_PARAM_NAMES = new Set(['out', 'source', 'sigout']);

/** A lowercase identifier for the registry from arbitrary text, unique within `taken`. */
export function slugIdentifier(text: string, fallback: string, taken: Set<string>, maxLength = 40): string {
  let base = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, maxLength);
  if (!/^[a-z]/.test(base)) base = base === '' ? fallback : `p_${base}`.slice(0, maxLength);
  if (RESERVED_PARAM_NAMES.has(base) || base in Object.prototype) base = `${base}_v`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base.slice(0, maxLength - String(i).length - 1)}_${i}`;
  taken.add(name);
  return name;
}

const fail = (errors: PineDiagnostic[], warnings: PineDiagnostic[]): PineCompileResult => ({
  ok: false, errors: [...errors].sort(byPosition), warnings: [...warnings].sort(byPosition),
});

/** Pine v4 / v5 / v6 (subset) source -> a runnable indicator, or errors with line:col. Never throws. */
export function compilePine(source: string): PineCompileResult {
  try {
    return compileUnguarded(source);
  } catch (err) {
    // The parser bounds nesting, so this is a last resort (e.g. an engine with a very small stack).
    const message = err instanceof RangeError
      ? 'the script is too large or too deeply nested to compile'
      : `internal compiler error: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, errors: [{ line: 1, col: 1, message }], warnings: [] };
  }
}

function compileUnguarded(source: string): PineCompileResult {
  const warnings: PineDiagnostic[] = [];
  const detected = detectVersion(source);
  if (!detected.ok) return fail([detected.error], warnings);
  if (detected.warning) warnings.push(detected.warning);
  const { version } = detected;

  let program: Stmt[];
  try {
    program = parse(source);
  } catch (err) {
    if (err instanceof PineSyntaxError) return fail([err.diagnostic], warnings);
    throw err;
  }

  // Version front ends: v4 is rewritten into the v5 AST; v6 adds type rules. Everything after is shared.
  const frontErrors: PineDiagnostic[] = [];
  if (version === 4) {
    const v4 = normalizeV4(program);
    program = v4.program;
    frontErrors.push(...v4.errors);
    warnings.push(...v4.warnings);
  }
  const v6 = version === 6 ? checkV6(program) : null;
  if (v6) frontErrors.push(...v6.errors);

  const analysis = analyze(program, version === 4 ? 'study' : 'indicator', version);
  // A string or colour series can never be true: reject it rather than compile a signal that never fires.
  const typeOf = exprTyper(program);
  for (const sg of analysis.signals) {
    for (const site of sg.sites) {
      const t = site.value ? typeOf(site.value) : 'unknown';
      if (site.value && (t === 'string' || t === 'color')) {
        const what = site.kind === 'alertcondition' ? 'condition' : site.kind === 'label' ? 'y' : 'series';
        const name = site.kind === 'label' ? 'label.new' : site.kind;
        frontErrors.push({ line: site.value.line, col: site.value.col, message: `${name} ${what} must be a bool or a number, not a ${t}` });
      }
    }
  }
  const params = new Set<string>();
  const inputs: PineInput[] = [];
  const sources: PineSourceInput[] = [];
  const bindings = new Map<Stmt, InputBinding>();
  for (const info of analysis.inputs) {
    if (info.kind === 'source') {
      bindings.set(info.decl, { info, primarySource: sources.length === 0 });
      sources.push({ varName: info.varName, title: info.title, default: info.defval as PriceSource });
    } else {
      bindings.set(info.decl, { info, param: inputs.length });
      inputs.push({
        name: slugIdentifier(info.varName, 'input', params), varName: info.varName, kind: info.kind, title: info.title,
        default: info.defval as number, ...(info.min !== undefined ? { min: info.min } : {}), ...(info.max !== undefined ? { max: info.max } : {}),
      });
    }
  }
  const keys = new Set<string>();
  const plots: PinePlot[] = analysis.plots.map((p, i) => ({ key: slugIdentifier(p.title, `plot${i + 1}`, keys), title: p.title }));
  const plotIndex = new Map<CallExpr, number>(analysis.plots.map((p, i) => [p.call, i]));
  const signals: PineSignal[] = analysis.signals.map((sg, i) => ({ key: slugIdentifier(sg.title, `signal${i + 1}`, keys), title: sg.title, marker: sg.marker }));
  const signalSites = new Map<CallExpr, { index: number; site: SignalSite }>();
  analysis.signals.forEach((sg, index) => {
    for (const site of sg.sites) signalSites.set(site.call, { index, site });
  });
  const signalSlot = new Map(signals.map((sg, i) => [sg.key, i]));

  const gen = generate({
    program, inputs: bindings, plotIndex, reassigned: analysis.reassigned, dialect: dialectFor(version), boolHistory: v6?.boolHistory,
    signals: signalSites,
  });
  // An input used as a ta.* length can only be 1..MAX_TA_LENGTH: make that the block field's range, so a bad
  // value is a block compile error rather than a failure when the run starts.
  for (const input of inputs) {
    if (!gen.lengthInputs.has(input.varName)) continue;
    input.min = Math.max(input.min ?? 1, 1);
    input.max = Math.min(input.max ?? MAX_TA_LENGTH, MAX_TA_LENGTH);
  }
  warnings.push(...gen.warnings);
  const errors = [...frontErrors, ...analysis.errors, ...gen.errors];
  if (errors.length > 0) return fail(errors, warnings);

  const forbidden = forbiddenReferences(gen.js);
  if (forbidden.length > 0) return fail([{ line: 1, col: 1, message: `internal compiler error: generated code mentions ${forbidden.join(', ')}` }], warnings);
  let factory: (rt: PineRuntime, P: number[]) => { step(): void };
  try {
    factory = new Function('rt', 'P', ...SHADOWED_GLOBALS, gen.js) as typeof factory;
  } catch (err) {
    return fail([{ line: 1, col: 1, message: `internal compiler error: ${err instanceof Error ? err.message : String(err)}` }], warnings);
  }

  const header = analysis.header!;
  const sourceDefault: PriceSource = sources[0]?.default ?? 'close';
  const script: PineScript = {
    version,
    title: header.title,
    shortTitle: header.shortTitle,
    overlay: header.overlay,
    inputs,
    sources,
    plots,
    signals,
    warnings: [...warnings].sort(byPosition),
    js: gen.js,
    create(values = {}, limits) {
      const P = inputs.map((input) => {
        const given = Object.prototype.hasOwnProperty.call(values, input.name) ? values[input.name] : input.default;
        const v = Number(given);
        const integer = input.kind !== 'float';
        if (!Number.isFinite(v) || (integer && !Number.isInteger(v)) || (input.min !== undefined && v < input.min) || (input.max !== undefined && v > input.max)) {
          throw new Error(`Pine script "${header.title}": input "${input.title}" must be ${integer ? 'a whole number' : 'a number'}` +
            ` from ${input.min ?? '-∞'} to ${input.max ?? '∞'}, got ${String(given)}`);
        }
        return v;
      });
      const rt = new PineRuntime(header.title, gen.maxBarsBack, plots.length, sourceDefault, limits, signals.length);
      const program = factory(rt, P);
      return {
        step(src, candle) {
          rt.begin(candle, src);
          program.step();
          const out: Record<string, number> = {};
          for (let i = 0; i < plots.length; i++) out[plots[i].key] = rt.out[i];
          for (let i = 0; i < signals.length; i++) out[signals[i].key] = rt.sg[i];
          return out;
        },
        markerPrice(key) {
          const i = signalSlot.get(key);
          return i === undefined ? NaN : rt.sp[i];
        },
      };
    },
  };
  // Instantiate once with the defaults so bad ta.* lengths etc. surface as compile errors with a position.
  try {
    script.create();
  } catch (err) {
    if (err instanceof PineRuntimeError) return fail([{ line: err.line, col: err.col, message: err.message.replace(/^Pine script "[^"]*", line \d+: /, '') }], warnings);
    return fail([{ line: 1, col: 1, message: err instanceof Error ? err.message : String(err) }], warnings);
  }
  return { ok: true, script, warnings: script.warnings };
}

/** Test/overlay helper: runs a fresh instance over `candles`; returns one array per plot key and per signal key (1/0). */
export function runPine(script: PineScript, candles: readonly Candle[], params?: Record<string, number>, sources?: readonly number[]): Record<string, number[]> {
  const inst = script.create(params);
  const out: Record<string, number[]> = {};
  const keys = [...script.plots.map((p) => p.key), ...script.signals.map((s) => s.key)];
  for (const k of keys) out[k] = [];
  candles.forEach((c, i) => {
    const values = inst.step(sources?.[i], c);
    for (const k of keys) out[k].push(values[k]);
  });
  return out;
}
