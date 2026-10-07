import { childBlocks, dottedName, stmtExprs, walkExpr, type Expr, type Pos, type Stmt } from './ast';
import { literalNumber } from './analyze';
import { BUILTIN_SERIES, type Issue } from './builtins';

/**
 * Pine v6 rules that need types: numbers are no longer implicitly cast to bool, and bool can no longer be na.
 * Types come from a light, conservative inference. A variable gets a type only when every declaration and
 * assignment of that name agrees, so an "unknown" result never produces an error. That keeps valid scripts
 * free of false errors.
 */
export type PineType = 'int' | 'float' | 'bool' | 'string' | 'color' | 'unknown';
/** `na` fits any type, so it never decides one. */
type Inferred = PineType | 'na';

export interface V6Result {
  errors: Issue[];
  /** `x[n]` expressions whose value is a bool (their history before the first bar is false in v6). */
  boolHistory: Set<Expr>;
}

const DECLARED = new Set<string>(['int', 'float', 'bool', 'string', 'color']);
const isNumeric = (t: Inferred): t is 'int' | 'float' => t === 'int' || t === 'float';
const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!=']);
const NUMERIC_TA = new Set(['sma', 'ema', 'rma', 'wma', 'rsi', 'stdev', 'atr', 'stoch', 'highest', 'lowest', 'tr']);

/** Leftmost source position of an expression (binary/ternary nodes sit on their operator). */
function startOf(e: Expr): Pos {
  let cur = e;
  for (;;) {
    if (cur.k === 'binary') cur = cur.left;
    else if (cur.k === 'ternary') cur = cur.cond;
    else if (cur.k === 'index') cur = cur.object;
    else return { line: cur.line, col: cur.col };
  }
}

/** One type for several sources: equal types stay, int+float is float, anything else is unknown. */
function join(types: Inferred[]): Inferred {
  const real = types.filter((t) => t !== 'na');
  if (real.length === 0) return types.length > 0 ? 'na' : 'unknown';
  if (real.every((t) => t === real[0])) return real[0];
  return real.every(isNumeric) ? 'float' : 'unknown';
}

class V6Checker {
  readonly errors: Issue[] = [];
  readonly boolHistory = new Set<Expr>();
  /** Every way each name gets a value: an expression, or a fixed type. */
  private readonly sources = new Map<string, Array<Expr | PineType>>();
  /** Names with at least one declaration that has no explicit type. */
  private readonly untyped = new Set<string>();
  /** Names with an explicitly typed declaration (`float x = …`, `var bool b = …`). */
  private readonly typed = new Set<string>();
  private readonly nameTypes = new Map<string, Inferred>();
  private readonly computing = new Set<string>();

  constructor(private readonly program: Stmt[]) {
    const add = (name: string, src: Expr | PineType) => {
      const list = this.sources.get(name);
      if (list) list.push(src);
      else this.sources.set(name, [src]);
    };
    const collect = (list: Stmt[]) => {
      for (const s of list) {
        if (s.k === 'decl' && s.type !== undefined && DECLARED.has(s.type)) {
          add(s.name, s.type as PineType);
          this.typed.add(s.name);
        } else if (s.k === 'decl') {
          add(s.name, s.init);
          this.untyped.add(s.name);
        } else if (s.k === 'assign') add(s.name, s.op === ':=' ? s.value : 'unknown');
        else if (s.k === 'for') add(s.name, 'int');
        else if (s.k === 'tupleDecl') for (const n of s.names) add(n.name, 'unknown');
        else if (s.k === 'func') for (const p of s.params) add(p.name, 'unknown');
        // Loop variables, tuple names and parameters are declarations without an explicit type too.
        if (s.k === 'for') this.untyped.add(s.name);
        if (s.k === 'tupleDecl') for (const n of s.names) this.untyped.add(n.name);
        if (s.k === 'func') for (const p of s.params) this.untyped.add(p.name);
        for (const b of childBlocks(s)) collect(b);
      }
    };
    collect(program);
  }

  run(): V6Result {
    this.visit(this.program);
    return { errors: this.errors, boolHistory: this.boolHistory };
  }

  private error(at: Pos, message: string): void {
    this.errors.push({ line: at.line, col: at.col, message });
  }

  // ---- inference -----------------------------------------------------------------------------------

  inferType(e: Expr): Inferred {
    return this.type(e);
  }

  private nameType(name: string): Inferred {
    const known = this.nameTypes.get(name);
    if (known !== undefined) return known;
    const all = this.sources.get(name) ?? ['unknown'];
    if (this.typed.has(name) && !this.untyped.has(name)) {
      // Only explicitly typed declarations: the declared type is authoritative (Pine checks assignments to it).
      const declared = all.filter((s): s is PineType => typeof s === 'string' && s !== 'unknown');
      const t = declared.every((d) => d === declared[0]) ? declared[0] : 'unknown';
      this.nameTypes.set(name, t);
      return t;
    }
    if (this.computing.has(name)) return 'unknown';
    this.computing.add(name);
    const t = join(all.map((s) => (typeof s === 'string' ? s : this.type(s))));
    this.computing.delete(name);
    this.nameTypes.set(name, t);
    return t;
  }

  private type(e: Expr): Inferred {
    switch (e.k) {
      case 'num':
        return Number.isInteger(e.value) ? 'int' : 'float';
      case 'str':
        return 'string';
      case 'bool':
        return 'bool';
      case 'color':
        return 'color';
      case 'ident': {
        if (e.name === 'na') return 'na';
        if (this.sources.has(e.name)) return this.nameType(e.name);
        const series = BUILTIN_SERIES.get(e.name);
        if (series) return e.name === 'bar_index' || e.name === 'time' ? 'int' : 'float';
        return 'unknown';
      }
      case 'member': {
        const name = dottedName(e) ?? '';
        if (name.startsWith('color.')) return 'color';
        if (name.startsWith('math.') || name === 'ta.tr') return 'float';
        return 'unknown';
      }
      case 'call':
        return this.callType(e);
      case 'index': {
        const t = this.type(e.object);
        return t === 'na' ? 'unknown' : t;
      }
      case 'unary': {
        if (e.op === 'not') return 'bool';
        const t = this.type(e.operand);
        return isNumeric(t) ? t : 'unknown';
      }
      case 'binary': {
        if (e.op === 'and' || e.op === 'or' || COMPARISONS.has(e.op)) return 'bool';
        const [a, b] = [this.type(e.left), this.type(e.right)];
        if (e.op === '+' && (a === 'string' || b === 'string')) return 'string';
        if ((isNumeric(a) || a === 'na') && (isNumeric(b) || b === 'na')) return a === 'int' && b === 'int' && e.op !== '/' ? 'int' : 'float';
        return 'unknown';
      }
      case 'ternary':
        return join([this.type(e.then), this.type(e.else)]);
      default:
        return 'unknown';
    }
  }

  private callType(e: Extract<Expr, { k: 'call' }>): Inferred {
    const name = dottedName(e.callee) ?? '';
    const arg = (i: number) => e.args.filter((a) => a.name === undefined)[i]?.value;
    if (name === 'na') return 'bool';
    if (name === 'nz') {
      const x = arg(0);
      return x ? this.type(x) : 'unknown';
    }
    if (name === 'ta.crossover' || name === 'ta.crossunder') return 'bool';
    if (name === 'ta.change') {
      const src = arg(0);
      const t = src ? this.type(src) : 'unknown';
      return t === 'bool' ? 'bool' : isNumeric(t) ? 'float' : 'unknown';
    }
    if (name.startsWith('ta.') && NUMERIC_TA.has(name.slice(3))) return 'float';
    if (name.startsWith('math.')) return 'float';
    if (name === 'color.new' || name === 'color.rgb') return 'color';
    if (name === 'input.int') return 'int';
    if (name === 'input.float' || name === 'input.source') return 'float';
    if (name === 'input.bool') return 'bool';
    if (name === 'input') {
      const d = arg(0) ?? e.args.find((a) => a.name === 'defval')?.value;
      const t = d ? this.type(d) : 'unknown';
      return t === 'na' ? 'unknown' : t;
    }
    return 'unknown';
  }

  // ---- rules ---------------------------------------------------------------------------------------

  /** `e` is used where Pine needs a bool: in v6 a number there is a compile error. */
  private requireBool(e: Expr, where: string): void {
    const t = this.type(e);
    if (!isNumeric(t)) return;
    const what = e.k === 'ident' ? `"${e.name}" is a number` : 'this is a number';
    const example = e.k === 'ident' ? `${e.name} != 0` : 'x != 0';
    this.error(startOf(e), `Pine v6 does not convert numbers to bool (${where}): ${what}; compare it explicitly, e.g. ${example}`);
  }

  private checkExpr(root: Expr): void {
    walkExpr(root, (e) => {
      if (e.k === 'ternary') this.requireBool(e.cond, 'condition of ?:');
      else if (e.k === 'unary' && e.op === 'not') this.requireBool(e.operand, '"not" operand');
      else if (e.k === 'binary' && (e.op === 'and' || e.op === 'or')) {
        this.requireBool(e.left, `"${e.op}" operand`);
        this.requireBool(e.right, `"${e.op}" operand`);
      } else if (e.k === 'index' && this.type(e.object) === 'bool') {
        this.boolHistory.add(e);
      } else if (e.k === 'call') {
        const name = dottedName(e.callee);
        const first = e.args.find((a) => a.name === undefined || a.name === 'x' || a.name === 'source')?.value;
        if ((name === 'na' || name === 'nz') && first && this.type(first) === 'bool') {
          this.error(e, `Pine v6: bool values cannot be na, so ${name}() does not accept a bool`);
        }
        if (name === 'plotshape' || name === 'plotchar' || name === 'alertcondition') {
          // The series is a bool in v6 (except plotshape/plotchar with location.absolute, where it is a price).
          const pos = e.args.filter((a) => a.name === undefined);
          const series = e.args.find((a) => a.name === 'series' || a.name === 'condition')?.value ?? pos[0]?.value;
          const loc = e.args.find((a) => a.name === 'location')?.value ?? (name === 'alertcondition' ? undefined : pos[3]?.value);
          const absolute = loc !== undefined && dottedName(loc) === 'location.absolute';
          if (series && !absolute) this.requireBool(series, `${name} ${name === 'alertcondition' ? 'condition' : 'series'}`);
        }
        if (name === 'plot' || name === 'hline') {
          // plot(series, title, color, linewidth, …) / hline(price, title, color, linestyle, linewidth, …)
          const positional = e.args.filter((a) => a.name === undefined)[name === 'plot' ? 3 : 4]?.value;
          const lw = e.args.find((a) => a.name === 'linewidth')?.value ?? positional;
          const v = literalNumber(lw);
          if (lw && v !== null && v < 1) this.error(lw, `Pine v6: ${name}() linewidth must be at least 1`);
        }
      }
    });
  }

  private visit(list: Stmt[]): void {
    for (const s of list) {
      if (s.k === 'if') this.requireBool(s.cond, 'condition of "if"');
      if (s.k === 'decl' && s.init.k === 'ident' && s.init.name === 'na' && this.nameType(s.name) === 'bool') {
        this.error(s.init, `Pine v6: a bool variable cannot be na; initialise "${s.name}" with true or false`);
      }
      if (s.k === 'assign' && s.value.k === 'ident' && s.value.name === 'na' && this.nameType(s.name) === 'bool') {
        this.error(s.value, `Pine v6: a bool variable cannot be na; assign true or false to "${s.name}"`);
      }
      for (const e of stmtExprs(s)) this.checkExpr(e);
      for (const b of childBlocks(s)) this.visit(b);
    }
  }
}

/**
 * The light, conservative type inference behind the v6 rules, for any version's (v5-shaped) AST: 'unknown' when
 * not sure, so callers only act on a definite type.
 */
export function exprTyper(program: Stmt[]): (e: Expr) => PineType | 'na' {
  const checker = new V6Checker(program);
  return (e) => checker.inferType(e);
}

/** Pine v6 type rules over the (v5-shaped) AST. */
export function checkV6(program: Stmt[]): V6Result {
  return new V6Checker(program).run();
}
