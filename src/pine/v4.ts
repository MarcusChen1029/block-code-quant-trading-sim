import { dottedName, type Arg, type CallExpr, type Expr, type Pos, type Stmt } from './ast';
import { literalNumber } from './analyze';
import { bindArgs, type Issue, SOURCE_DEFAULTS, type Signature } from './builtins';
import { PLOTCHAR_SIG_V4, PLOTSHAPE_SIG_V4 } from './signals';
import { V4_INPUT_TYPES, V4_MATH_FUNCTIONS, V4_OTHER_INPUT_TYPES, V4_TA_FUNCTIONS, V4_UNSUPPORTED } from './dialect';

/**
 * Pine v4 front end: rewrites a parsed v4 script into the v5 AST the rest of the compiler understands
 * (`sma()` -> `ta.sma()`, `study()` -> `indicator()`, `input(type=…)` -> `input.int()` …) and reports v5-only
 * spellings, which do not exist in v4. Positions are kept, so later errors still point at the user's text.
 */
export interface V4Result {
  program: Stmt[];
  errors: Issue[];
  warnings: Issue[];
}

const sig = (params: string, required: number): Signature => ({ params: params.split(',').map((p) => p.trim()), required });

/** Pine v4 reference signatures (positional order differs from v5 after the first few parameters). */
const STUDY_SIG = sig('title, shorttitle, overlay, format, precision, scale, max_bars_back, max_lines_count, max_labels_count, resolution, resolution_gaps, max_boxes_count, explicit_plot_zorder', 1);
const PLOT_SIG_V4 = sig('series, title, color, linewidth, style, trackprice, transp, histbase, offset, join, editable, show_last, display', 1);
const INPUT_SIG_V4 = sig('defval, title, type, minval, maxval, confirm, step, options, tooltip, inline, group', 1);

/** Parameters each v5 input function accepts (from the v4 call), in v5 naming. */
const INPUT_PARAMS = new Map<string, ReadonlySet<string>>([
  ['int', new Set(['defval', 'title', 'minval', 'maxval', 'confirm', 'step', 'options', 'tooltip', 'inline', 'group'])],
  ['float', new Set(['defval', 'title', 'minval', 'maxval', 'confirm', 'step', 'options', 'tooltip', 'inline', 'group'])],
  ['bool', new Set(['defval', 'title', 'confirm', 'tooltip', 'inline', 'group'])],
  ['source', new Set(['defval', 'title', 'tooltip', 'inline', 'group'])],
]);
const V4_TYPE_NAME = new Map([['int', 'integer'], ['float', 'float'], ['bool', 'bool'], ['source', 'source']]);

const pos = (p: Pos): Pos => ({ line: p.line, col: p.col });
const ident = (name: string, at: Pos): Expr => ({ k: 'ident', name, ...pos(at) });
const dotted = (ns: string, name: string, at: Pos): Expr => ({ k: 'member', object: ident(ns, at), name, ...pos(at) });

/** Named arguments for every bound parameter except `skip`. */
function named(params: readonly string[], bound: (Expr | undefined)[], skip: ReadonlySet<string> = new Set()): Arg[] {
  const out: Arg[] = [];
  params.forEach((name, i) => {
    const value = bound[i];
    if (value && !skip.has(name)) out.push({ name, value, ...pos(value) });
  });
  return out;
}

class V4Normalizer {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  /**
   * Names the script defines itself win over a v4 built-in spelling, with Pine scoping: a user function from
   * its definition on (functions are top level); a variable from its declaration to the end of its block; a
   * parameter inside its function; a loop variable inside its loop. Functions and variables are separate
   * namespaces: only functions hide built-in calls, only variables hide built-in values (`tr`).
   */
  private readonly userFunctions = new Set<string>();
  private readonly scopes: Set<string>[] = [new Set()];

  private error(at: Pos, message: string): void {
    this.errors.push({ line: at.line, col: at.col, message });
  }

  private isVariable(name: string): boolean {
    return this.scopes.some((scope) => scope.has(name));
  }

  /** Statements of a nested block (if / else / for / function body) in a new scope seeded with `names`. */
  private block(list: Stmt[], names: readonly string[] = []): Stmt[] {
    this.scopes.push(new Set(names));
    try {
      return this.stmts(list, false);
    } finally {
      this.scopes.pop();
    }
  }

  stmts(list: Stmt[], topLevel: boolean): Stmt[] {
    return list.map((s) => this.stmt(s, topLevel));
  }

  private stmt(s: Stmt, topLevel: boolean): Stmt {
    const declare = (name: string) => this.scopes[this.scopes.length - 1].add(name);
    switch (s.k) {
      case 'decl': {
        // The initial value is read before the new name exists (`tr = tr * 2` reads the built-in).
        const init = this.expr(s.init);
        declare(s.name);
        const isInput = topLevel && init.k === 'call' && init.callee.k === 'ident' && init.callee.name === 'input' && !this.userFunctions.has('input');
        return { ...s, init: isInput ? this.input(init as CallExpr) : init };
      }
      case 'tupleDecl': {
        const init = this.expr(s.init);
        for (const n of s.names) declare(n.name);
        return { ...s, init };
      }
      case 'assign':
        return { ...s, value: this.expr(s.value) };
      case 'if':
        return { ...s, cond: this.expr(s.cond), then: this.block(s.then), else: s.else ? this.block(s.else) : null };
      case 'for':
        return { ...s, from: this.expr(s.from), to: this.expr(s.to), by: s.by ? this.expr(s.by) : null, body: this.block(s.body, [s.name]) };
      case 'func': {
        const body = this.block(s.body, s.params.map((p) => p.name));
        this.userFunctions.add(s.name);
        return { ...s, body };
      }
      case 'expr':
        return { ...s, expr: this.expr(s.expr) };
      default:
        return s;
    }
  }

  /** Rewrites children first, then the node itself. */
  private expr(e: Expr): Expr {
    switch (e.k) {
      case 'ident':
        if (e.name === 'tr' && !this.isVariable('tr')) return dotted('ta', 'tr', e);
        return e;
      case 'member':
        return this.member(e);
      case 'call': {
        // input(…, type=input.integer): the type constant is read by input(), not rewritten as a value.
        const isInput = e.callee.k === 'ident' && e.callee.name === 'input' && !this.userFunctions.has('input');
        const isType = (a: Arg, i: number) => isInput && (a.name === 'type' || (a.name === undefined && i === 2)) && a.value.k === 'member';
        return this.call({ ...e, args: e.args.map((a, i) => (isType(a, i) ? a : { ...a, value: this.expr(a.value) })) });
      }
      case 'index':
        return { ...e, object: this.expr(e.object), index: this.expr(e.index) };
      case 'unary':
        return { ...e, operand: this.expr(e.operand) };
      case 'binary':
        return { ...e, left: this.expr(e.left), right: this.expr(e.right) };
      case 'ternary':
        return { ...e, cond: this.expr(e.cond), then: this.expr(e.then), else: this.expr(e.else) };
      case 'tuple':
        return { ...e, items: e.items.map((x) => this.expr(x)) };
      default:
        return e;
    }
  }

  /** A member that is not called (`ta.tr`, `math.pi`, `input.integer` …). */
  private member(e: Extract<Expr, { k: 'member' }>): Expr {
    const name = dottedName(e);
    const root = name?.split('.')[0];
    if (root === 'ta' || root === 'math') {
      this.error(e, `${name} is not available in Pine v4 (no ${root}.* namespace): use ${e.name}`);
    } else if (root === 'input' && name !== null) {
      this.error(e, `${name} is only valid as the type of an input: x = input(10, "Title", type=${name})`);
      return ident('na', e);
    }
    return e;
  }

  private call(e: CallExpr): Expr {
    const name = dottedName(e.callee);
    if (name === null) return e;
    if (e.callee.k === 'ident') {
      if (this.userFunctions.has(name)) return e;
      if (name === 'study') return this.study(e);
      if (name === 'plot') return this.plot(e);
      if (name === 'plotshape' || name === 'plotchar') {
        // v4 order has transp after color: re-bind by v4 position, drop transp (visual only), keep named v5 args.
        const s = name === 'plotshape' ? PLOTSHAPE_SIG_V4 : PLOTCHAR_SIG_V4;
        return { ...e, args: named(s.params, bindArgs(name, s, e.args, pos(e), this.errors), new Set(['transp'])) };
      }
      if (V4_TA_FUNCTIONS.has(name)) return { ...e, callee: dotted('ta', name, e.callee) };
      if (V4_MATH_FUNCTIONS.has(name)) return { ...e, callee: dotted('math', name, e.callee) };
      if (name === 'indicator') this.error(e, 'indicator() is not available in Pine v4: use study("Title", overlay=true|false)');
      const unsupported = V4_UNSUPPORTED.get(name);
      if (unsupported !== undefined) {
        this.error(e, unsupported);
        return ident('na', e);
      }
      return e;
    }
    const [root, member] = [name.slice(0, name.indexOf('.')), name.slice(name.indexOf('.') + 1)];
    if (root === 'ta' || root === 'math') {
      this.error(e, `${name}() is not available in Pine v4 (no ${root}.* namespace): use ${member}()`);
    } else if (root === 'input') {
      const type = V4_TYPE_NAME.get(member);
      this.error(e, `${name}() is not available in Pine v4: use input(defval, title, type=input.${type ?? 'integer'})`);
    }
    return e;
  }

  /** study(...) -> indicator(...) with named arguments. */
  private study(e: CallExpr): Expr {
    const bound = bindArgs('study', STUDY_SIG, e.args, pos(e), this.errors);
    const resolution = STUDY_SIG.params.indexOf('resolution');
    for (const i of [resolution, resolution + 1]) {
      const a = bound[i];
      if (a) this.error(a, `study(${STUDY_SIG.params[i]}=...) (multi-timeframe) is not supported in v1`);
    }
    const args = named(STUDY_SIG.params, bound, new Set(['resolution', 'resolution_gaps']));
    if (!bound[0]) args.unshift({ name: 'title', value: { k: 'str', value: 'Pine script', ...pos(e) }, ...pos(e) });
    return { ...e, callee: ident('indicator', e.callee), args };
  }

  /** v4 plot(): re-bound by v4 position; `transp` (visual only) is dropped. */
  private plot(e: CallExpr): Expr {
    // A missing series is reported by the shared analysis of the rebuilt call (once), not here as well.
    const bound = bindArgs('plot', { ...PLOT_SIG_V4, required: 0 }, e.args, pos(e), this.errors);
    return { ...e, args: named(PLOT_SIG_V4.params, bound, new Set(['transp'])) };
  }

  /** `x = input(defval, title, type=input.integer, …)` -> `x = input.int(defval, title, …)`. */
  private input(e: CallExpr): Expr {
    const issues: Issue[] = [];
    const bound = bindArgs('input', INPUT_SIG_V4, e.args, pos(e), issues);
    this.errors.push(...issues);
    const [defval, , typeArg] = bound;
    if (!defval || issues.length > 0) return ident('na', e);
    let kind: 'int' | 'float' | 'bool' | 'source' | undefined;
    if (typeArg) {
      const t = dottedName(typeArg);
      const member = t?.startsWith('input.') ? t.slice('input.'.length) : undefined;
      kind = member === undefined ? undefined : V4_INPUT_TYPES.get(member);
      if (!kind) {
        this.error(typeArg, member !== undefined && V4_OTHER_INPUT_TYPES.has(member)
          ? `input(type=input.${member}) is not supported in v1 (use input.integer, input.float, input.bool or input.source)`
          : 'input type must be input.integer, input.float, input.bool or input.source');
        return ident('na', e);
      }
    } else if (defval.k === 'bool') kind = 'bool';
    else if (literalNumber(defval) !== null) kind = Number.isInteger(literalNumber(defval)) ? 'int' : 'float';
    else if (defval.k === 'ident' && SOURCE_DEFAULTS.has(defval.name)) {
      kind = 'source';
      this.warnings.push({ ...pos(defval), message: `input(${defval.name}) without type=input.source: compiled as a source input (add type=input.source to be explicit)` });
    } else {
      this.error(defval, 'input() default must be a number, true/false or a price source such as close (string and other inputs are not supported in v1)');
      return ident('na', e);
    }
    const allowed = INPUT_PARAMS.get(kind)!;
    INPUT_SIG_V4.params.forEach((p, i) => {
      const a = bound[i];
      if (a && p !== 'type' && !allowed.has(p)) this.error(a, `input(type=input.${V4_TYPE_NAME.get(kind!)}) does not take "${p}"`);
    });
    return { ...e, callee: dotted('input', kind, e.callee), args: named(INPUT_SIG_V4.params, bound, new Set(['type'])) };
  }
}

/** Normalises a parsed Pine v4 script to the v5 AST. */
export function normalizeV4(program: Stmt[]): V4Result {
  const n = new V4Normalizer();
  return { program: n.stmts(program, true), errors: n.errors, warnings: n.warnings };
}
