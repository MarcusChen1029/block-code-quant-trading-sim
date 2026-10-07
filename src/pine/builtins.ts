import type { Arg, Expr, Pos } from './ast';

/**
 * Whitelists of everything a Pine script may name. Every table is a Map, so Object.prototype keys such as
 * `constructor` or `__proto__` never resolve. Generated code only ever contains the fixed `js` strings below.
 */

export interface Signature {
  params: readonly string[];
  /** Number of leading params that are required. */
  required: number;
  /** Accepts any number (≥ required) of positional arguments. */
  variadic?: boolean;
}

const sig = (params: string, required = params.split(',').length, variadic = false): Signature => ({
  params: params.split(',').map((p) => p.trim()).filter(Boolean),
  required,
  variadic,
});

export interface Issue extends Pos {
  message: string;
}

/**
 * Maps call arguments onto parameter names. Returns one entry per param (undefined = not given) or, for
 * variadic signatures, the positional values. Problems are pushed to `issues` as plain { line, col, message }
 * (`at` may be any node: only its position is copied).
 */
export function bindArgs(name: string, s: Signature, args: Arg[], at: Pos, issues: Issue[]): (Expr | undefined)[] {
  if (s.variadic) {
    const named = args.find((a) => a.name !== undefined);
    if (named) issues.push({ ...pos(named), message: `${name}() does not take named arguments` });
    if (args.length < s.required) issues.push({ ...pos(at), message: `${name}() needs at least ${s.required} argument${s.required > 1 ? 's' : ''}` });
    return args.map((a) => a.value);
  }
  const out: (Expr | undefined)[] = s.params.map(() => undefined);
  let positional = 0;
  for (const a of args) {
    if (a.name === undefined) {
      if (positional >= s.params.length) {
        issues.push({ ...pos(a), message: `too many arguments for ${name}() (it takes ${s.params.length})` });
        continue;
      }
      out[positional++] = a.value;
    } else {
      const idx = s.params.indexOf(a.name);
      if (idx < 0) {
        issues.push({ ...pos(a), message: `${name}() has no argument named "${a.name}"` });
      } else if (out[idx] !== undefined) {
        issues.push({ ...pos(a), message: `${name}(): argument "${a.name}" is given twice` });
      } else {
        out[idx] = a.value;
      }
    }
  }
  for (let i = 0; i < s.required; i++) {
    if (out[i] === undefined) {
      issues.push({ ...pos(at), message: `${name}() needs the "${s.params[i]}" argument (${s.params.slice(0, s.required).join(', ')})` });
      break;
    }
  }
  return out;
}

const pos = (p: Pos): Pos => ({ line: p.line, col: p.col });

// ---- built-in series -------------------------------------------------------------------------------------

export interface SeriesInfo {
  /** Code for the current value. */
  js: string;
  /** Field passed to rt.px for history (`close[3]`), or 'bar_index'. */
  field: string;
}

export const BUILTIN_SERIES = new Map<string, SeriesInfo>([
  ['open', { js: 'rt.bar.open', field: 'open' }],
  ['high', { js: 'rt.bar.high', field: 'high' }],
  ['low', { js: 'rt.bar.low', field: 'low' }],
  ['close', { js: 'rt.bar.close', field: 'close' }],
  ['volume', { js: 'rt.bar.volume', field: 'volume' }],
  ['time', { js: 'rt.bar.time', field: 'time' }],
  ['hl2', { js: 'rt.px("hl2", 0)', field: 'hl2' }],
  ['hlc3', { js: 'rt.px("hlc3", 0)', field: 'hlc3' }],
  ['ohlc4', { js: 'rt.px("ohlc4", 0)', field: 'ohlc4' }],
  ['hlcc4', { js: 'rt.px("hlcc4", 0)', field: 'hlcc4' }],
  ['bar_index', { js: 'rt.barIndex', field: 'bar_index' }],
]);

/** input.source defaults the block can feed (they must be PriceSource values). */
export const SOURCE_DEFAULTS = new Set(['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'volume']);

// ---- ta.* ----------------------------------------------------------------------------------------------

export type TaKind = 'series' | 'macd' | 'bb' | 'atr' | 'stoch' | 'cross' | 'tr' | 'hilo';

export interface TaInfo {
  sig: Signature;
  kind: TaKind;
  /** Runtime factory method (rt.<factory>). */
  factory: string;
  /** Indexes of params that must be constant ("simple") and are passed to the factory. */
  simple: number[];
  /** Number of values returned (0 = one plain value). */
  tuple: number;
}

const series = (factory: string, params = 'source, length'): TaInfo => ({ sig: sig(params), kind: 'series', factory, simple: [1], tuple: 0 });

export const TA_FUNCTIONS = new Map<string, TaInfo>([
  ['sma', series('sma')],
  ['ema', series('ema')],
  ['rma', series('rma')],
  ['wma', series('wma')],
  ['rsi', series('rsi')],
  ['stdev', series('stdev')],
  ['change', { sig: sig('source, length', 1), kind: 'series', factory: 'change', simple: [1], tuple: 0 }],
  ['highest', { sig: sig('source, length', 1), kind: 'hilo', factory: 'highest', simple: [1], tuple: 0 }],
  ['lowest', { sig: sig('source, length', 1), kind: 'hilo', factory: 'lowest', simple: [1], tuple: 0 }],
  ['macd', { sig: sig('source, fastlen, slowlen, siglen'), kind: 'macd', factory: 'macd', simple: [1, 2, 3], tuple: 3 }],
  ['bb', { sig: sig('series, length, mult'), kind: 'bb', factory: 'bb', simple: [1, 2], tuple: 3 }],
  ['atr', { sig: sig('length'), kind: 'atr', factory: 'atr', simple: [0], tuple: 0 }],
  ['stoch', { sig: sig('source, high, low, length'), kind: 'stoch', factory: 'stoch', simple: [3], tuple: 0 }],
  ['crossover', { sig: sig('source1, source2'), kind: 'cross', factory: 'crossover', simple: [], tuple: 0 }],
  ['crossunder', { sig: sig('source1, source2'), kind: 'cross', factory: 'crossunder', simple: [], tuple: 0 }],
  ['tr', { sig: sig('handle_na', 0), kind: 'tr', factory: 'tr', simple: [], tuple: 0 }],
]);

// ---- math.* --------------------------------------------------------------------------------------------

export interface MathInfo {
  sig: Signature;
  /** Runtime method (rt.<js>). */
  js: string;
}

const math = (js: string, params = 'number'): MathInfo => ({ sig: sig(params), js });

export const MATH_FUNCTIONS = new Map<string, MathInfo>([
  ['abs', math('m_abs')],
  ['sqrt', math('m_sqrt')],
  ['log', math('m_log')],
  ['log10', math('m_log10')],
  ['exp', math('m_exp')],
  ['floor', math('m_floor')],
  ['ceil', math('m_ceil')],
  ['sign', math('m_sign')],
  ['sin', math('m_sin', 'angle')],
  ['cos', math('m_cos', 'angle')],
  ['tan', math('m_tan', 'angle')],
  ['asin', math('m_asin', 'angle')],
  ['acos', math('m_acos', 'angle')],
  ['atan', math('m_atan', 'angle')],
  ['todegrees', math('m_todegrees', 'radians')],
  ['toradians', math('m_toradians', 'degrees')],
  ['pow', math('m_pow', 'base, exponent')],
  ['round', { sig: sig('number, precision', 1), js: 'm_round' }],
  ['max', { sig: sig('number0, number1', 2, true), js: 'm_max' }],
  ['min', { sig: sig('number0, number1', 2, true), js: 'm_min' }],
  ['avg', { sig: sig('number0, number1', 2, true), js: 'm_avg' }],
]);

export const MATH_CONSTANTS = new Map<string, number>([
  ['pi', Math.PI],
  ['e', Math.E],
  ['phi', (1 + Math.sqrt(5)) / 2],
  ['rphi', (Math.sqrt(5) - 1) / 2],
]);

// ---- script structure ----------------------------------------------------------------------------------

export const INDICATOR_SIG = sig(
  'title, shorttitle, overlay, format, precision, scale, max_bars_back, timeframe, timeframe_gaps, explicit_plot_zorder, ' +
    'max_lines_count, max_labels_count, max_boxes_count, calc_bars_count, max_polylines_count, dynamic_requests, behind_chart',
  1,
);

export const INPUT_SIGS = new Map<string, Signature>([
  ['input.int', sig('defval, title, minval, maxval, step, tooltip, inline, group, confirm, options, display, active', 1)],
  ['input.float', sig('defval, title, minval, maxval, step, tooltip, inline, group, confirm, options, display, active', 1)],
  ['input.bool', sig('defval, title, tooltip, inline, group, confirm, display, active', 1)],
  ['input.source', sig('defval, title, tooltip, inline, group, display, active', 1)],
  ['input', sig('defval, title, tooltip, inline, group, display, active', 1)],
]);

export const PLOT_SIG = sig(
  'series, title, color, linewidth, style, trackprice, histbase, offset, join, editable, show_last, display, format, precision, force_overlay',
  1,
);

export const NA_SIG = sig('x');
export const NZ_SIG = sig('source, replacement', 1);

/** Visual-only calls accepted but not drawn (warning). */
export const IGNORED_CALLS = new Set(['hline', 'bgcolor', 'barcolor', 'fill']);

export const COLOR_NAMES = new Set([
  'aqua', 'black', 'blue', 'fuchsia', 'gray', 'green', 'lime', 'maroon', 'navy', 'olive', 'orange', 'purple', 'red',
  'silver', 'teal', 'white', 'yellow',
]);
export const COLOR_FUNCTIONS = new Map<string, Signature>([
  ['new', sig('color, transp')],
  ['rgb', sig('red, green, blue, transp', 3)],
]);
/** Members of plot.style_* / shape.* etc. are not needed; they only appear in ignored arguments. */

/** Namespaces the script may use. */
export const NAMESPACES = new Set(['ta', 'math', 'input', 'color']);

/** Namespaces / functions outside the v1 subset, with the reason shown to the user. */
export const UNSUPPORTED = new Map<string, string>([
  ['strategy', 'strategy() scripts and strategy.* are not supported in v1 (write an indicator() and trade it with blocks)'],
  ['library', 'libraries are not supported in v1'],
  ['request', 'request.* (other symbols / timeframes) is not supported in v1'],
  ['array', 'arrays (array.*) are not supported in v1'],
  ['map', 'maps (map.*) are not supported in v1'],
  ['matrix', 'matrices (matrix.*) are not supported in v1'],
  ['line', 'drawing objects (line.*) are not supported in v1'],
  ['label', 'label objects beyond label.new at the current bar are not supported'],
  ['box', 'drawing objects (box.*) are not supported in v1'],
  ['table', 'drawing objects (table.*) are not supported in v1'],
  ['linefill', 'drawing objects (linefill.*) are not supported in v1'],
  ['polyline', 'drawing objects (polyline.*) are not supported in v1'],
  ['alert', 'alerts (alert) are not supported in v1'],
  ['str', 'str.* is not supported in v1'],
  ['barstate', 'barstate.* is not supported in v1'],
  ['syminfo', 'syminfo.* is not supported in v1'],
  ['timeframe', 'timeframe.* is not supported in v1'],
  ['plotarrow', 'plotarrow() is not supported (use plotshape(cond, style=shape.arrowup) for a signal)'],
  ['plotcandle', 'plotcandle() is not supported in v1 (use plot)'],
  ['plotbar', 'plotbar() is not supported in v1 (use plot)'],
]);

/** Names a script cannot declare (built-ins and namespaces). */
export function isReservedName(name: string): boolean {
  return BUILTIN_SERIES.has(name) || NAMESPACES.has(name) || UNSUPPORTED.has(name) || IGNORED_CALLS.has(name) ||
    ['na', 'nz', 'plot', 'indicator', 'input', 'plotshape', 'plotchar', 'alertcondition'].includes(name);
}
