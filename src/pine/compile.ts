import type { PriceSource } from '../blocks/priceSource';
import type { Candle } from '../data/types';
import type { CallExpr, Stmt } from './ast';
import { analyze, type InputKind } from './analyze';
import { generate, type InputBinding } from './codegen';
import { byPosition, type PineDiagnostic, PineRuntimeError, PineSyntaxError } from './diagnostics';
import { pineVersion } from './lexer';
import { parse } from './parser';
import { PineRuntime } from './runtime';
import { forbiddenReferences, SHADOWED_GLOBALS } from './safety';

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

/** One running copy of a script: `step` is called exactly once per closed bar, in bar order. */
export interface PineInstance {
  /** `source` feeds the first input.source (undefined = its default price source). Returns one value per plot key. */
  step(source: number | undefined, candle: Candle): Record<string, number>;
}

export interface PineScript {
  title: string;
  shortTitle: string;
  overlay: boolean;
  inputs: PineInput[];
  sources: PineSourceInput[];
  plots: PinePlot[];
  warnings: PineDiagnostic[];
  /** The generated JS (for inspection and tests). */
  js: string;
  /** New instance; `params` are keyed by PineInput.name (missing -> default). Throws on out-of-range values. */
  create(params?: Record<string, number>): PineInstance;
}

export type PineCompileResult =
  | { ok: true; script: PineScript; warnings: PineDiagnostic[] }
  | { ok: false; errors: PineDiagnostic[]; warnings: PineDiagnostic[] };

const RESERVED_PARAM_NAMES = new Set(['out', 'source']);

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

/** Pine v5 (subset) source -> a runnable indicator, or errors with line:col. Never throws. */
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
  const version = pineVersion(source);
  if (version === null) warnings.push({ line: 1, col: 1, message: 'no //@version=5 line: compiled as Pine v5' });
  else if (version.version !== 5) return fail([{ line: version.line, col: 1, message: `only //@version=5 is supported (found version ${version.version})` }], warnings);

  let program: Stmt[];
  try {
    program = parse(source);
  } catch (err) {
    if (err instanceof PineSyntaxError) return fail([err.diagnostic], warnings);
    throw err;
  }

  const analysis = analyze(program);
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

  const gen = generate({ program, inputs: bindings, plotIndex, reassigned: analysis.reassigned });
  warnings.push(...gen.warnings);
  const errors = [...analysis.errors, ...gen.errors];
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
    title: header.title,
    shortTitle: header.shortTitle,
    overlay: header.overlay,
    inputs,
    sources,
    plots,
    warnings: [...warnings].sort(byPosition),
    js: gen.js,
    create(values = {}) {
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
      const rt = new PineRuntime(header.title, gen.maxBarsBack, plots.length, sourceDefault);
      const program = factory(rt, P);
      return {
        step(src, candle) {
          rt.begin(candle, src);
          program.step();
          const out: Record<string, number> = {};
          for (let i = 0; i < plots.length; i++) out[plots[i].key] = rt.out[i];
          return out;
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

/** Test/overlay helper: runs a fresh instance over `candles`; returns one array per plot key. */
export function runPine(script: PineScript, candles: readonly Candle[], params?: Record<string, number>, sources?: readonly number[]): Record<string, number[]> {
  const inst = script.create(params);
  const out: Record<string, number[]> = {};
  for (const p of script.plots) out[p.key] = [];
  candles.forEach((c, i) => {
    const values = inst.step(sources?.[i], c);
    for (const p of script.plots) out[p.key].push(values[p.key]);
  });
  return out;
}
