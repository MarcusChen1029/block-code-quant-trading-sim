import { childBlocks, dottedName, stmtExprs, walkExpr, type Expr, type Pos, type Stmt } from './ast';
import { literalNumber } from './analyze';
import { BUILTIN_SERIES, type Issue } from './builtins';
import type { PineVersion } from './version';

/**
 * Pine v6 rules that need types: numbers are no longer implicitly cast to bool, and bool can no longer be na.
 * Types come from a light, conservative inference (also used by every version for `int / int`). A variable gets a
 * type only when every declaration and assignment of that name agrees, so an "unknown" result never produces an
 * error. That keeps valid scripts free of false errors.
 */
export type PineType = 'int' | 'float' | 'bool' | 'string' | 'color' | 'unknown';
/**
 * `na` fits any type, so it never decides one. `cycle` is a reference to a name whose type is being computed
 * (`x := x + 1`): it is neutral, so the other sources decide (it never leaves the inference).
 */
type Inferred = PineType | 'na' | 'cycle';

export interface V6Result {
  errors: Issue[];
  /** `x[n]` expressions whose value is a bool (their history before the first bar is false in v6). */
  boolHistory: Set<Expr>;
}

type FuncStmt = Extract<Stmt, { k: 'func' }>;
type DeclStmt = Extract<Stmt, { k: 'decl' }>;

const DECLARED = new Set<string>(['int', 'float', 'bool', 'string', 'color']);
const isNumeric = (t: Inferred): t is 'int' | 'float' => t === 'int' || t === 'float';
const COMPARISONS = new Set(['<', '<=', '>', '>=', '==', '!=']);
const ARITH = new Set(['+', '-', '*', '/', '%']);
const NUMERIC_TA = new Set(['sma', 'ema', 'rma', 'wma', 'rsi', 'stdev', 'atr', 'stoch', 'highest', 'lowest', 'tr']);
/** Conversion functions (all versions): int(), float(), bool(). */
export const CONVERSIONS = new Map<string, 'int' | 'float' | 'bool'>([['int', 'int'], ['float', 'float'], ['bool', 'bool']]);

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
  const real = types.filter((t) => t !== 'na' && t !== 'cycle');
  if (real.length === 0) return types.includes('na') ? 'na' : types.includes('cycle') ? 'cycle' : 'unknown';
  if (real.every((t) => t === real[0])) return real[0];
  return real.every(isNumeric) ? 'float' : 'unknown';
}

class TypeInference {
  /** Every way each name gets a value: an expression, or a fixed type. */
  private readonly sources = new Map<string, Array<Expr | PineType>>();
  /** Names with at least one declaration that has no explicit type. */
  private readonly untyped = new Set<string>();
  /** Names with an explicitly typed declaration (`float x = …`, `var bool b = …`). */
  private readonly typed = new Set<string>();
  /** Declarations of each name (for v5 "const" detection). */
  private readonly decls = new Map<string, DeclStmt[]>();
  /** User functions by name (null: defined more than once, so unknown). */
  private readonly funcs = new Map<string, FuncStmt | null>();
  private readonly nameTypes = new Map<string, Inferred>();
  private readonly funcTypes = new Map<string, Inferred>();
  /** Names being computed (innermost last) and whether each frame read a name still in progress below it. */
  private readonly stack: Array<{ name: string; tainted: boolean }> = [];
  private readonly funcStack = new Set<string>();
  private readonly constStack = new Set<string>();

  constructor(program: Stmt[], readonly version: PineVersion) {
    const add = (name: string, src: Expr | PineType) => {
      const list = this.sources.get(name);
      if (list) list.push(src);
      else this.sources.set(name, [src]);
    };
    const collect = (list: Stmt[]) => {
      for (const s of list) {
        if (s.k === 'decl') {
          const d = this.decls.get(s.name);
          if (d) d.push(s);
          else this.decls.set(s.name, [s]);
        }
        if (s.k === 'decl' && s.type !== undefined && DECLARED.has(s.type)) {
          add(s.name, s.type as PineType);
          this.typed.add(s.name);
        } else if (s.k === 'decl') {
          add(s.name, s.init);
          this.untyped.add(s.name);
        } else if (s.k === 'assign') {
          // `x += v` is `x := x + v` (same rule for -= *= /= %=).
          const op = s.op === ':=' ? null : s.op.slice(0, -1);
          add(s.name, op === null ? s.value : op !== null && ARITH.has(op)
            ? { k: 'binary', op, left: { k: 'ident', name: s.name, line: s.line, col: s.col }, right: s.value, line: s.line, col: s.col }
            : 'unknown');
        } else if (s.k === 'for') add(s.name, 'int');
        else if (s.k === 'tupleDecl') for (const n of s.names) add(n.name, 'unknown');
        else if (s.k === 'func') {
          for (const p of s.params) add(p.name, 'unknown');
          this.funcs.set(s.name, this.funcs.has(s.name) ? null : s);
        }
        // Loop variables, tuple names and parameters are declarations without an explicit type too.
        if (s.k === 'for') this.untyped.add(s.name);
        if (s.k === 'tupleDecl') for (const n of s.names) this.untyped.add(n.name);
        if (s.k === 'func') for (const p of s.params) this.untyped.add(p.name);
        for (const b of childBlocks(s)) collect(b);
      }
    };
    collect(program);
  }

  /** The type of `e`, never 'cycle' ('unknown' when not sure). */
  typeOf(e: Expr): PineType | 'na' {
    const t = this.type(e);
    return t === 'cycle' ? 'unknown' : t;
  }

  /** True for a user-defined function name (it wins over built-in names such as int / float / bool). */
  isUserFunction(name: string): boolean {
    return this.funcs.has(name);
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
    const at = this.stack.findIndex((f) => f.name === name);
    if (at >= 0) {
      // Frames above `name` depend on its unfinished type: their results are partial, so they are not cached.
      for (let i = at + 1; i < this.stack.length; i++) this.stack[i].tainted = true;
      return 'cycle';
    }
    const frame = { name, tainted: false };
    this.stack.push(frame);
    let t: Inferred;
    try {
      t = join(all.map((s) => (typeof s === 'string' ? s : this.type(s))));
    } finally {
      this.stack.pop();
    }
    // A tainted frame (every frame between a cycle's origin and the top) returns its partial type, `cycle` included,
    // to the origin and is not cached; an untainted one is final.
    if (frame.tainted) return t;
    if (t === 'cycle') t = 'unknown';
    this.nameTypes.set(name, t);
    return t;
  }

  /**
   * Pine v5 "const": number literals, arithmetic on them, and names with a single plain (not `var`) declaration
   * from such an expression that are never reassigned. Anything else (inputs, series, parameters) is not const.
   */
  private isConst(e: Expr): boolean {
    switch (e.k) {
      case 'num':
        return true;
      case 'unary':
        return (e.op === '-' || e.op === '+') && this.isConst(e.operand);
      case 'binary':
        return ARITH.has(e.op) && this.isConst(e.left) && this.isConst(e.right);
      case 'ident': {
        const src = this.sources.get(e.name);
        const decls = this.decls.get(e.name);
        if (!src || src.length !== 1 || !decls || decls.length !== 1) return false;
        const d = decls[0];
        if (d.mode !== 'plain' || (d.type !== undefined && d.type !== 'int' && d.type !== 'float') || this.constStack.has(e.name)) return false;
        this.constStack.add(e.name);
        try {
          return this.isConst(d.init);
        } finally {
          this.constStack.delete(e.name);
        }
      }
      default:
        return false;
    }
  }

  private funcType(name: string): Inferred {
    const known = this.funcTypes.get(name);
    if (known !== undefined) return known;
    const fn = this.funcs.get(name);
    if (!fn || this.funcStack.has(name) || fn.body.length === 0) return 'unknown';
    this.funcStack.add(name);
    let t: Inferred;
    try {
      const last = fn.body[fn.body.length - 1];
      if (last.k === 'expr') t = last.expr.k === 'tuple' ? 'unknown' : this.type(last.expr);
      else if (last.k === 'decl' || last.k === 'assign') t = this.nameType(last.name);
      else t = 'unknown';
    } finally {
      this.funcStack.delete(name);
    }
    // A function returning na (or only itself) has no usable type.
    if (t === 'na' || t === 'cycle') t = 'unknown';
    if (this.stack.length === 0) this.funcTypes.set(name, t);
    return t;
  }

  type(e: Expr): Inferred {
    switch (e.k) {
      case 'num':
        return Number.isInteger(e.value) && !e.float ? 'int' : 'float';
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
        return isNumeric(t) || t === 'cycle' ? t : 'unknown';
      }
      case 'binary': {
        if (e.op === 'and' || e.op === 'or' || COMPARISONS.has(e.op)) return 'bool';
        let [a, b] = [this.type(e.left), this.type(e.right)];
        // A name still being computed takes the other operand's type (`x := x + 1` keeps x an int).
        if (a === 'cycle') a = b;
        if (b === 'cycle') b = a;
        if (a === 'cycle') return 'cycle';
        if (e.op === '+' && (a === 'string' || b === 'string')) return 'string';
        if ((isNumeric(a) || a === 'na') && (isNumeric(b) || b === 'na')) {
          if (a !== 'int' || b !== 'int') return 'float';
          return e.op === '/' && !this.intDivision(e) ? 'float' : 'int';
        }
        return 'unknown';
      }
      case 'ternary':
        return join([this.type(e.then), this.type(e.else)]);
      default:
        return 'unknown';
    }
  }

  /**
   * `int / int` (both operands already known to be int) is integer division in v4 (any int [O4]) and in v5 when
   * both operands are "const" [M6]; v6 always divides fractionally [M6].
   */
  private intDivision(e: Extract<Expr, { k: 'binary' }>): boolean {
    if (this.version === 4) return true;
    if (this.version === 5) return this.isConst(e.left) && this.isConst(e.right);
    return false;
  }

  private callType(e: Extract<Expr, { k: 'call' }>): Inferred {
    const name = dottedName(e.callee) ?? '';
    const arg = (i: number) => e.args.filter((a) => a.name === undefined)[i]?.value;
    if (name === 'na') return 'bool';
    if (name === 'nz') {
      const x = arg(0);
      return x ? this.type(x) : 'unknown';
    }
    if (this.funcs.has(name)) return this.funcType(name);
    const conv = CONVERSIONS.get(name);
    if (conv) return conv;
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
      return t === 'na' || t === 'cycle' ? 'unknown' : t;
    }
    return 'unknown';
  }
}

class V6Checker {
  readonly errors: Issue[] = [];
  readonly boolHistory = new Set<Expr>();
  private readonly types: TypeInference;

  constructor(private readonly program: Stmt[]) {
    this.types = new TypeInference(program, 6);
  }

  run(): V6Result {
    this.visit(this.program);
    return { errors: this.errors, boolHistory: this.boolHistory };
  }

  private error(at: Pos, message: string): void {
    this.errors.push({ line: at.line, col: at.col, message });
  }

  private type(e: Expr): PineType | 'na' {
    return this.types.typeOf(e);
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
        if (name !== null && this.types.isUserFunction(name)) return;
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
      // [M6] "A variable declared as bool can no longer be assigned na as its default value." Only declarations are
      // named; a later `b := na` is accepted and stores false (codegen), as bool expressions that were na in v5 are.
      if (s.k === 'decl' && s.init.k === 'ident' && s.init.name === 'na' && this.type({ k: 'ident', name: s.name, line: s.line, col: s.col }) === 'bool') {
        this.error(s.init, `Pine v6: a bool variable cannot be na; initialise "${s.name}" with true or false`);
      }
      for (const e of stmtExprs(s)) this.checkExpr(e);
      for (const b of childBlocks(s)) this.visit(b);
    }
  }
}

/**
 * The light, conservative type inference behind the v6 rules and integer division, for any version's (v5-shaped)
 * AST: 'unknown' when not sure, so callers only act on a definite type.
 */
export function exprTyper(program: Stmt[], version: PineVersion = 6): (e: Expr) => PineType | 'na' {
  const types = new TypeInference(program, version);
  return (e) => types.typeOf(e);
}

/** Pine v6 type rules over the (v5-shaped) AST. */
export function checkV6(program: Stmt[]): V6Result {
  return new V6Checker(program).run();
}
