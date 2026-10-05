import { childBlocks, dottedName, stmtExprs, walkExpr, type CallExpr, type Expr, type Stmt } from './ast';
import { bindArgs, INDICATOR_SIG, INPUT_SIGS, type Issue, PLOT_SIG, SOURCE_DEFAULTS } from './builtins';

export type InputKind = 'int' | 'float' | 'bool' | 'source';

/** One `name = input.*(...)` declaration (top level), read statically. */
export interface InputInfo {
  /** Pine variable name. */
  varName: string;
  kind: InputKind;
  title: string;
  /** Default: a number (bool -> 0/1) or, for sources, the price field name. */
  defval: number | string;
  min?: number;
  max?: number;
  decl: Extract<Stmt, { k: 'decl' }>;
}

export interface PlotInfo {
  title: string;
  call: CallExpr;
}

export interface Header {
  title: string;
  shortTitle: string;
  overlay: boolean;
}

export interface Analysis {
  header: Header | null;
  inputs: InputInfo[];
  plots: PlotInfo[];
  /** Every name reassigned (:=, +=, ...) anywhere in the script. */
  reassigned: Set<string>;
  errors: Issue[];
}

/** A number literal, possibly negated. */
export function literalNumber(e: Expr | undefined): number | null {
  if (!e) return null;
  if (e.k === 'num') return e.value;
  if (e.k === 'unary' && (e.op === '-' || e.op === '+')) {
    const v = literalNumber(e.operand);
    return v === null ? null : e.op === '-' ? -v : v;
  }
  return null;
}

const callName = (e: Expr): string | null => (e.k === 'call' ? dottedName(e.callee) : null);
const isInputCall = (e: Expr): boolean => {
  const n = callName(e);
  return n !== null && INPUT_SIGS.has(n);
};

/**
 * Static pass over the AST: indicator() header, inputs (block params) and plots (block outputs), plus
 * placement errors for indicator / input / plot calls that are not where v1 needs them.
 */
export function analyze(program: Stmt[]): Analysis {
  const errors: Issue[] = [];
  const inputs: InputInfo[] = [];
  const plots: PlotInfo[] = [];
  const reassigned = new Set<string>();
  let header: Header | null = null;
  const allowed = new Set<Expr>();

  for (const s of program) {
    if (s.k === 'expr' && callName(s.expr) === 'indicator') {
      allowed.add(s.expr);
      if (header) errors.push({ line: s.line, col: s.col, message: 'indicator() is declared twice' });
      else header = readHeader(s.expr as CallExpr, errors);
    } else if (s.k === 'expr' && callName(s.expr) === 'plot') {
      allowed.add(s.expr);
      plots.push(readPlot(s.expr as CallExpr, plots.length, errors));
    } else if (s.k === 'decl' && isInputCall(s.init)) {
      allowed.add(s.init);
      const info = readInput(s, errors);
      if (info) inputs.push(info);
    } else if (s.k === 'decl' && callName(s.init) === 'plot') {
      allowed.add(s.init);
      plots.push(readPlot(s.init as CallExpr, plots.length, errors));
    }
  }

  const visitStmts = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.k === 'assign') reassigned.add(s.name);
      for (const e of stmtExprs(s)) {
        walkExpr(e, (x) => {
          if (x.k !== 'call' || allowed.has(x)) return;
          const name = dottedName(x.callee);
          if (name === 'indicator') errors.push({ line: x.line, col: x.col, message: 'indicator() must be a statement of its own at the top level' });
          else if (name === 'plot') errors.push({ line: x.line, col: x.col, message: 'plot() must be at the top level of the script (not inside if / for / functions / expressions)' });
          else if (name !== null && INPUT_SIGS.has(name)) {
            errors.push({ line: x.line, col: x.col, message: `${name}() must be assigned to a variable at the top level, e.g. len = ${name}(14)` });
          }
        });
      }
      for (const b of childBlocks(s)) visitStmts(b);
    }
  };
  visitStmts(program);

  const otherHeader = program.some((s) => s.k === 'expr' && ['strategy', 'library'].includes(callName(s.expr) ?? ''));
  if (!header && !otherHeader) {
    errors.push({ line: 1, col: 1, message: 'the script must declare indicator("Title", overlay=true|false)' });
  }
  if (plots.length === 0 && !otherHeader) errors.push({ line: 1, col: 1, message: 'the script has no plot(): each plot becomes an output of the block' });
  return { header, inputs, plots, reassigned, errors };
}

function readHeader(call: CallExpr, errors: Issue[]): Header {
  const [title, shortTitle, overlay, , , , , timeframe] = bindArgs('indicator', INDICATOR_SIG, call.args, call, errors);
  const header: Header = { title: 'Pine script', shortTitle: '', overlay: false };
  if (title?.k === 'str' && title.value.trim() !== '') header.title = title.value.trim();
  else if (title) errors.push({ line: title.line, col: title.col, message: 'indicator() title must be a non-empty string literal' });
  if (shortTitle?.k === 'str') header.shortTitle = shortTitle.value;
  if (overlay) {
    if (overlay.k === 'bool') header.overlay = overlay.value;
    else errors.push({ line: overlay.line, col: overlay.col, message: 'overlay must be true or false' });
  }
  if (timeframe) errors.push({ line: timeframe.line, col: timeframe.col, message: 'indicator(timeframe=...) (multi-timeframe) is not supported in v1' });
  return header;
}

function readPlot(call: CallExpr, index: number, errors: Issue[]): PlotInfo {
  const bound = bindArgs('plot', PLOT_SIG, call.args, call, errors);
  const title = bound[1];
  const offset = bound[7];
  if (offset && literalNumber(offset) !== 0) {
    errors.push({ line: offset.line, col: offset.col, message: 'plot(offset=...) is not supported in v1 (it would shift the values)' });
  }
  let text = `Plot ${index + 1}`;
  if (title) {
    if (title.k === 'str' && title.value.trim() !== '') text = title.value.trim();
    else errors.push({ line: title.line, col: title.col, message: 'plot title must be a string literal' });
  }
  return { title: text, call };
}

function readInput(decl: Extract<Stmt, { k: 'decl' }>, errors: Issue[]): InputInfo | null {
  const call = decl.init as CallExpr;
  const name = dottedName(call.callee)!;
  const [defval, title, ...rest] = bindArgs(name, INPUT_SIGS.get(name)!, call.args, call, errors);
  if (!defval) return null;
  const err = (e: { line: number; col: number }, message: string) => {
    errors.push({ line: e.line, col: e.col, message });
    return null;
  };
  let kind: InputKind;
  if (name === 'input') {
    if (defval.k === 'bool') kind = 'bool';
    else if (defval.k === 'ident') kind = 'source';
    else if (literalNumber(defval) !== null) kind = Number.isInteger(literalNumber(defval)) ? 'int' : 'float';
    else return err(defval, 'input() default must be a number, true/false or a price source such as close');
  } else {
    kind = name.slice('input.'.length) as InputKind;
  }
  let titleText = decl.name;
  if (title) {
    if (title.k === 'str' && title.value.trim() !== '') titleText = title.value.trim();
    else return err(title, 'input title must be a string literal');
  }
  if (decl.mode === 'var') return err(decl, 'inputs are constant: drop "var"');

  if (kind === 'source') {
    if (defval.k !== 'ident' || !SOURCE_DEFAULTS.has(defval.name)) {
      return err(defval, 'input.source default must be one of open, high, low, close, hl2, hlc3, ohlc4, volume');
    }
    return { varName: decl.name, kind, title: titleText, defval: defval.name, decl };
  }
  if (kind === 'bool') {
    if (defval.k !== 'bool') return err(defval, 'input.bool default must be true or false');
    return { varName: decl.name, kind, title: titleText, defval: defval.value ? 1 : 0, min: 0, max: 1, decl };
  }
  const value = literalNumber(defval);
  if (value === null) return err(defval, `${name} default must be a number literal`);
  if (kind === 'int' && !Number.isInteger(value)) return err(defval, 'input.int default must be a whole number');
  const info: InputInfo = { varName: decl.name, kind, title: titleText, defval: value, decl };
  const [minval, maxval] = name === 'input' ? [undefined, undefined] : rest;
  for (const [key, e] of [['min', minval], ['max', maxval]] as const) {
    if (!e) continue;
    const v = literalNumber(e);
    if (v === null) return err(e, `${key}val must be a number literal`);
    if (kind === 'int' && !Number.isInteger(v)) return err(e, `${key}val of input.int must be a whole number`);
    info[key] = v;
  }
  if (info.min !== undefined && info.max !== undefined && info.min > info.max) return err(call, 'minval is greater than maxval');
  if ((info.min !== undefined && value < info.min) || (info.max !== undefined && value > info.max)) {
    return err(defval, 'the default is outside minval..maxval');
  }
  return info;
}
