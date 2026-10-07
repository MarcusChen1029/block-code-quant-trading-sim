import { dottedName, type CallExpr, type Expr } from './ast';
import { bindArgs, type Issue, type Signature } from './builtins';
import type { PineVersion } from './version';

/** A number literal, possibly negated (same rule as analyze.ts; kept local to avoid an import cycle). */
function literalNumber(e: Expr | undefined): number | null {
  if (!e) return null;
  if (e.k === 'num') return e.value;
  if (e.k === 'unary' && (e.op === '-' || e.op === '+')) {
    const v = literalNumber(e.operand);
    return v === null ? null : e.op === '-' ? -v : v;
  }
  return null;
}

/**
 * Pine calls that mark events on the chart become SIGNAL outputs of the block (true on the bars where they fire):
 * plotshape(), plotchar(), alertcondition() and the simple form of label.new(). Everything here is static: names,
 * shapes, locations and colours are read from the AST (literals and fixed constants only), never evaluated, and
 * none of it reaches generated code. All tables are Maps (no Object.prototype lookups).
 */

/** How the chart draws one signal. 'price' = at the price the instance reports (label y, location.absolute). */
export interface SignalMarkerSpec {
  shape: 'arrowUp' | 'arrowDown' | 'circle' | 'square';
  location: 'aboveBar' | 'belowBar' | 'price';
  color?: string;
  text?: string;
}

export type SignalCallKind = 'plotshape' | 'plotchar' | 'alertcondition' | 'label';

/** How the call site sets its signal on a bar. */
export type SignalMode =
  /** true when the series is true (v4/v5: also a non-zero, non-na number). */
  | 'cond'
  /** location.absolute: the series is a price; fires (at that price) when it is not na. */
  | 'absolute'
  /** label.new: fires whenever the line runs; `value` is the y price. */
  | 'label';

/** One signal call site, read statically. */
export interface SignalSite {
  kind: SignalCallKind;
  call: CallExpr;
  mode: SignalMode;
  /** The series / condition / y expression (compiled per bar). */
  value: Expr | undefined;
  /** Name candidates in order of preference (string literals), before deduplication. */
  names: string[];
  /** Used when `names` is empty. */
  fallback: string;
  marker: SignalMarkerSpec;
  /** label.new sites with the same text are one signal (fires if any of them runs). */
  mergeKey?: string;
}

const sig = (params: string, required: number): Signature => ({ params: params.split(',').map((p) => p.trim()), required });

export const PLOTSHAPE_SIG = sig('series, title, style, location, color, offset, text, textcolor, editable, size, show_last, display, format, precision, force_overlay', 1);
export const PLOTCHAR_SIG = sig('series, title, char, location, color, offset, text, textcolor, editable, size, show_last, display, format, precision, force_overlay', 1);
export const ALERTCONDITION_SIG = sig('condition, title, message', 1);
export const LABEL_NEW_SIG = sig('x, y, text, xloc, yloc, color, style, textcolor, size, textalign, tooltip, text_font_family, force_overlay, text_formatting', 2);

/** Pine v4 positional order (transp sits after color); the v4 front end re-binds by these and drops transp. */
export const PLOTSHAPE_SIG_V4 = sig('series, title, style, location, color, transp, offset, text, textcolor, editable, size, show_last, display', 0);
export const PLOTCHAR_SIG_V4 = sig('series, title, char, location, color, transp, offset, text, textcolor, editable, size, show_last, display', 0);

/** Statement-level calls that are signals (label.new is matched by its dotted name). */
export const SIGNAL_FUNCTIONS: ReadonlySet<string> = new Set(['plotshape', 'plotchar', 'alertcondition', 'label.new']);

export const LABEL_OBJECT_ERROR = 'label objects beyond label.new at the current bar are not supported';

/** Longest signal name kept (names are display text; keys are derived separately). */
export const MAX_SIGNAL_NAME = 100;

const SHAPES = new Map<string, SignalMarkerSpec['shape']>([
  ['triangleup', 'arrowUp'], ['arrowup', 'arrowUp'], ['labelup', 'arrowUp'],
  ['triangledown', 'arrowDown'], ['arrowdown', 'arrowDown'], ['labeldown', 'arrowDown'],
  ['circle', 'circle'], ['cross', 'circle'], ['xcross', 'circle'],
  ['diamond', 'square'], ['square', 'square'], ['flag', 'square'],
]);

const LOCATIONS = new Map<string, SignalMarkerSpec['location']>([
  ['abovebar', 'aboveBar'], ['top', 'aboveBar'], ['belowbar', 'belowBar'], ['bottom', 'belowBar'], ['absolute', 'price'],
]);

const LABEL_STYLES = new Map<string, SignalMarkerSpec['shape']>([
  ['style_label_up', 'arrowUp'], ['style_label_lower_left', 'arrowUp'], ['style_label_lower_right', 'arrowUp'],
  ['style_triangleup', 'arrowUp'], ['style_arrowup', 'arrowUp'],
  ['style_label_down', 'arrowDown'], ['style_label_upper_left', 'arrowDown'], ['style_label_upper_right', 'arrowDown'],
  ['style_triangledown', 'arrowDown'], ['style_arrowdown', 'arrowDown'],
  ['style_label_left', 'circle'], ['style_label_right', 'circle'], ['style_label_center', 'circle'], ['style_none', 'circle'],
  ['style_text_outline', 'circle'], ['style_circle', 'circle'], ['style_cross', 'circle'], ['style_xcross', 'circle'],
  ['style_square', 'square'], ['style_diamond', 'square'], ['style_flag', 'square'],
]);

/** TradingView's colour constants (v5 values; v6 changed red, teal and yellow). */
const COLORS_V5 = new Map<string, string>([
  ['aqua', '#00BCD4'], ['black', '#363A45'], ['blue', '#2196F3'], ['fuchsia', '#E040FB'], ['gray', '#787B86'],
  ['green', '#4CAF50'], ['lime', '#00E676'], ['maroon', '#880E4F'], ['navy', '#311B92'], ['olive', '#808000'],
  ['orange', '#FF9800'], ['purple', '#9C27B0'], ['red', '#FF5252'], ['silver', '#B2B5BE'], ['teal', '#00897B'],
  ['white', '#FFFFFF'], ['yellow', '#FFEB3B'],
]);
const COLORS_V6 = new Map<string, string>([...COLORS_V5, ['red', '#F23645'], ['teal', '#089981'], ['yellow', '#FDD835']]);

export const BUY_COLOR = '#26a69a';
export const SELL_COLOR = '#ef5350';
/** alertcondition() draws a small marker of this colour (unless its name reads as buy/sell). */
export const ALERT_COLOR = '#f5c542';

const BUY_WORDS = /\b(buy|long|bull(?:ish)?|up)\b/i;
const SELL_WORDS = /\b(sell|short|bear(?:ish)?|down)\b/i;

/** Buy / sell defaults from a signal's name, when the script does not say otherwise. */
export function sideOf(text: string): 'buy' | 'sell' | null {
  const buy = BUY_WORDS.test(text);
  const sell = SELL_WORDS.test(text);
  return buy === sell ? null : buy ? 'buy' : 'sell';
}

const memberOf = (e: Expr | undefined, ns: string): string | null => {
  const name = e ? dottedName(e) : null;
  return name !== null && name.startsWith(`${ns}.`) && name.indexOf('.', ns.length + 1) < 0 ? name.slice(ns.length + 1) : null;
};

/** A colour read statically (constants, #hex, color.new / color.rgb of literals), or undefined. */
export function staticColor(e: Expr | undefined, version: PineVersion): string | undefined {
  if (!e) return undefined;
  if (e.k === 'color') return /^#[0-9a-fA-F]{6}/.test(e.value) ? e.value.slice(0, 7) : undefined;
  const named = memberOf(e, 'color');
  if (named !== null) return (version === 6 ? COLORS_V6 : COLORS_V5).get(named);
  if (e.k === 'call') {
    const name = dottedName(e.callee);
    const positional = e.args.filter((a) => a.name === undefined).map((a) => a.value);
    if (name === 'color.new') return staticColor(positional[0] ?? e.args.find((a) => a.name === 'color')?.value, version);
    if (name === 'color.rgb' && positional.length >= 3) {
      const [r, g, b] = positional.slice(0, 3).map((x) => literalNumber(x));
      if ([r, g, b].every((v) => v !== null && Number.isFinite(v) && v >= 0 && v <= 255)) return `rgb(${Math.round(r!)}, ${Math.round(g!)}, ${Math.round(b!)})`;
    }
  }
  return undefined;
}

const LINE_BREAKS = new RegExp(`[\r\n\t${String.fromCharCode(0x2028, 0x2029)}]+`, "g");

/** Display text: one line, trimmed, at most MAX_SIGNAL_NAME characters. */
export function cleanName(text: string): string {
  return text.replace(LINE_BREAKS, ' ').trim().slice(0, MAX_SIGNAL_NAME).trim();
}

interface Reader {
  version: PineVersion;
  errors: Issue[];
  /** 1-based number of this signal call among all signal calls (for fallback names). */
  ordinal: number;
}

/** A string literal argument (or undefined); anything else is an error naming `what`. */
function literal(e: Expr | undefined, what: string, r: Reader): string | undefined {
  if (!e) return undefined;
  if (e.k === 'str') return e.value;
  r.errors.push({ line: e.line, col: e.col, message: `${what} must be a string literal` });
  return undefined;
}

function checkOffset(name: string, e: Expr | undefined, r: Reader): void {
  if (e && literalNumber(e) !== 0) {
    r.errors.push({ line: e.line, col: e.col, message: `offset not supported: ${name}(offset=...) would move the signal to another bar` });
  }
}

/** Reads a location.* argument (undefined when absent; errors when not a constant). */
function location(e: Expr | undefined, name: string, r: Reader): SignalMarkerSpec['location'] | undefined {
  if (!e) return undefined;
  const loc = LOCATIONS.get(memberOf(e, 'location') ?? '');
  if (!loc) r.errors.push({ line: e.line, col: e.col, message: `${name}() location must be location.abovebar, belowbar, top, bottom or absolute` });
  return loc;
}

/** Buy/sell/neutral defaults for anything the script left out. */
function withDefaults(spec: Partial<SignalMarkerSpec>, name: string, neutral: SignalMarkerSpec): SignalMarkerSpec {
  const side = sideOf(name);
  const base: SignalMarkerSpec = side === 'buy'
    ? { shape: 'arrowUp', location: 'belowBar', color: BUY_COLOR }
    : side === 'sell' ? { shape: 'arrowDown', location: 'aboveBar', color: SELL_COLOR } : neutral;
  const out: SignalMarkerSpec = { shape: spec.shape ?? base.shape, location: spec.location ?? base.location };
  const color = spec.color ?? base.color;
  if (color !== undefined) out.color = color;
  if (spec.text !== undefined && spec.text !== '') out.text = spec.text;
  return out;
}

function plotLike(kind: 'plotshape' | 'plotchar', call: CallExpr, r: Reader): SignalSite {
  const bound = bindArgs(kind, kind === 'plotshape' ? PLOTSHAPE_SIG : PLOTCHAR_SIG, call.args, call, r.errors);
  const [series, titleArg, styleOrChar, locArg, colorArg, offset, textArg] = bound;
  checkOffset(kind, offset, r);
  const title = literal(titleArg, `${kind} title`, r);
  const text = literal(textArg, `${kind} text`, r);
  const spec: Partial<SignalMarkerSpec> = {};
  if (kind === 'plotshape') {
    if (styleOrChar) {
      const shape = SHAPES.get(memberOf(styleOrChar, 'shape') ?? '');
      if (shape) spec.shape = shape;
      else r.errors.push({ line: styleOrChar.line, col: styleOrChar.col, message: 'plotshape() style must be a shape.* constant, e.g. shape.triangleup' });
    }
    if (text !== undefined) spec.text = cleanName(text);
  } else {
    const ch = literal(styleOrChar, 'plotchar char', r);
    spec.shape = 'circle';
    const shown = [ch === undefined ? '★' : cleanName(ch).slice(0, 4), text === undefined ? '' : cleanName(text)].filter((s) => s !== '').join(' ');
    if (shown !== '') spec.text = shown;
  }
  const loc = location(locArg, kind, r);
  if (loc) spec.location = loc;
  const color = staticColor(colorArg, r.version);
  if (color) spec.color = color;
  const names = [title, text].filter((s): s is string => s !== undefined && cleanName(s) !== '').map(cleanName);
  const name = names[0] ?? '';
  // TradingView defaults: plotshape draws an x-cross above the bar, plotchar a star above the bar.
  const neutral: SignalMarkerSpec = { shape: 'circle', location: 'aboveBar', color: '#2962ff' };
  return {
    kind, call, value: series, mode: spec.location === 'price' ? 'absolute' : 'cond', names,
    fallback: `Signal ${r.ordinal}`, marker: withDefaults(spec, name, neutral),
  };
}

function alertCondition(call: CallExpr, r: Reader): SignalSite {
  const [condition, titleArg, messageArg] = bindArgs('alertcondition', ALERTCONDITION_SIG, call.args, call, r.errors);
  const title = literal(titleArg, 'alertcondition title', r);
  const message = literal(messageArg, 'alertcondition message', r);
  const names = [title, message].filter((s): s is string => s !== undefined && cleanName(s) !== '').map(cleanName);
  const name = names[0] ?? `Alert ${r.ordinal}`;
  // Not drawn by TradingView; we draw a small circle above the bar so the alert is visible (see the design note).
  const marker = withDefaults({ text: name }, name, { shape: 'circle', location: 'aboveBar', color: ALERT_COLOR });
  return { kind: 'alertcondition', call, value: condition, mode: 'cond', names, fallback: `Alert ${r.ordinal}`, marker };
}

function labelNew(call: CallExpr, r: Reader): SignalSite | null {
  const [x, y, textArg, xloc, yloc, colorArg, styleArg] = bindArgs('label.new', LABEL_NEW_SIG, call.args, call, r.errors);
  const err = (at: { line: number; col: number }, message: string) => r.errors.push({ line: at.line, col: at.col, message });
  if (x && !(x.k === 'ident' && (x.name === 'bar_index' || x.name === 'time'))) {
    err(x, `${LABEL_OBJECT_ERROR}: label.new x must be bar_index (the current bar)`);
  }
  const xl = memberOf(xloc, 'xloc');
  if (xloc && xl !== 'bar_index' && xl !== 'bar_time') err(xloc, 'label.new xloc must be xloc.bar_index or xloc.bar_time');
  if (!textArg) {
    err(call, 'label.new needs a text string literal: it names the signal, e.g. label.new(bar_index, low, "Buy")');
    return null;
  }
  if (textArg.k !== 'str') {
    err(textArg, `${LABEL_OBJECT_ERROR}: label.new text must be a string literal (it names the signal)`);
    return null;
  }
  const text = cleanName(textArg.value);
  if (text === '') {
    err(textArg, 'label.new text must not be empty (it names the signal)');
    return null;
  }
  const spec: Partial<SignalMarkerSpec> = { text, location: 'price', shape: 'arrowDown' }; // label.style_label_down is the default
  if (styleArg) {
    const shape = LABEL_STYLES.get(memberOf(styleArg, 'label') ?? '');
    if (shape) spec.shape = shape;
    else err(styleArg, 'label.new style must be a label.style_* constant, e.g. label.style_label_up');
  }
  const yl = memberOf(yloc, 'yloc');
  if (yloc) {
    if (yl === 'abovebar') spec.location = 'aboveBar';
    else if (yl === 'belowbar') spec.location = 'belowBar';
    else if (yl !== 'price') err(yloc, 'label.new yloc must be yloc.price, yloc.abovebar or yloc.belowbar');
  }
  const color = staticColor(colorArg, r.version);
  if (color) spec.color = color;
  else if (sideOf(text) === null) spec.color = '#2962ff';
  else spec.color = sideOf(text) === 'buy' ? BUY_COLOR : SELL_COLOR;
  return { kind: 'label', call, value: y, mode: 'label', names: [text], fallback: text, marker: withDefaults(spec, text, { shape: 'circle', location: 'price' }), mergeKey: text };
}

/** Reads one signal call (named `name`, one of SIGNAL_FUNCTIONS). Null when it cannot become a signal (errors pushed). */
export function readSignalCall(name: string, call: CallExpr, version: PineVersion, ordinal: number, errors: Issue[]): SignalSite | null {
  const r: Reader = { version, errors, ordinal };
  switch (name) {
    case 'plotshape':
    case 'plotchar':
      return plotLike(name, call, r);
    case 'alertcondition':
      return alertCondition(call, r);
    case 'label.new':
      return labelNew(call, r);
    default:
      return null;
  }
}
