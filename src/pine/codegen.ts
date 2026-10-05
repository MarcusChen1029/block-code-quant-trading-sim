import { jsString } from '../blocks/generator';
import { dottedName, type Arg, type CallExpr, type Expr, type Pos, type Stmt } from './ast';
import type { InputInfo } from './analyze';
import {
  BUILTIN_SERIES, bindArgs, COLOR_FUNCTIONS, COLOR_NAMES, IGNORED_CALLS, INPUT_SIGS, isReservedName, type Issue, MATH_CONSTANTS,
  MATH_FUNCTIONS, NA_SIG, NAMESPACES, NZ_SIG, PLOT_SIG, TA_FUNCTIONS, UNSUPPORTED,
} from './builtins';
import { MAX_HISTORY } from './runtime';

/** How an input declaration is wired: a numeric/bool block param (`param` = index into P) or a series source. */
export interface InputBinding {
  info: InputInfo;
  /** Index into the parameter array P (numeric and bool inputs). */
  param?: number;
  /** For sources: true for the first input.source (fed by the block's SOURCE input). */
  primarySource?: boolean;
}

export interface CodegenInput {
  program: Stmt[];
  inputs: Map<Stmt, InputBinding>;
  plotIndex: Map<CallExpr, number>;
  reassigned: Set<string>;
}

export interface CodegenResult {
  /** Body of `new Function('rt', 'P', ...)`; returns `{ step() }`. */
  js: string;
  /** Largest offset of a built-in series (sizes the candle history). */
  maxBarsBack: number;
  errors: Issue[];
  warnings: Issue[];
}

interface Bounds {
  lo: number;
  hi: number;
}

const UNBOUNDED: Bounds = { lo: -Infinity, hi: Infinity };

interface VarSym {
  name: string;
  js: string;
  /** Declared at the top level: factory-level storage, history allowed. */
  global: boolean;
  /** A numeric/bool input: a factory-level constant. */
  constInput: boolean;
  input: boolean;
  param: boolean;
  loopVar: boolean;
  /** The function this symbol belongs to (null for script-level symbols). */
  owner: FuncSym | null;
  /** Largest history offset used on it. */
  history: number;
  histJs?: string;
  /** Code computing its (constant) value at factory level, when it is "simple". */
  simpleJs?: string;
  bounds: Bounds;
}

interface FuncSym {
  name: string;
  js: string;
  arity: number;
  /** Number of values returned (0 = one value). */
  tuple: number;
}

interface Val {
  js: string;
  tuple: number;
}

const ARITHMETIC = new Map([['+', '+'], ['-', '-'], ['*', '*'], ['/', '/'], ['%', '%'], ['==', '==='], ['!=', '!=='], ['<', '<'], ['<=', '<='], ['>', '>'], ['>=', '>=']]);
const COMPOUND = new Map([['+=', '+'], ['-=', '-'], ['*=', '*'], ['/=', '/'], ['%=', '%']]);

/** A JS number literal (finite), negatives parenthesised. */
function jsNum(v: number): string {
  if (Object.is(v, -0) || v === 0) return '0';
  return v < 0 ? `(${v})` : String(v);
}

const mulBound = (a: number, b: number) => (a === 0 || b === 0 ? 0 : a * b);

class Codegen {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];
  private readonly prologue: string[] = [];
  private readonly functions: string[] = [];
  private readonly scopes: Map<string, VarSym>[] = [new Map()];
  private readonly funcs = new Map<string, FuncSym>();
  private readonly historySyms: VarSym[] = [];
  private ids = 0;
  private maxBarsBack = 0;
  private func: FuncSym | null = null;
  private cond = 0;
  private loop = 0;

  constructor(private readonly input: CodegenInput) {}

  run(): CodegenResult {
    const body = this.stmts(this.input.program);
    const histDecls: string[] = [];
    const commits: string[] = [];
    for (const sym of this.historySyms) {
      histDecls.push(`const ${sym.histJs} = rt.history(${sym.history});`);
      commits.push(`${sym.histJs}.push(${sym.js});`);
    }
    const js = [
      '"use strict";',
      ...this.prologue,
      ...histDecls,
      ...this.functions,
      'return {',
      'step() {',
      body,
      ...commits,
      '},',
      '};',
    ].join('\n');
    return { js, maxBarsBack: this.maxBarsBack, errors: this.errors, warnings: this.warnings };
  }

  // ---- bookkeeping ---------------------------------------------------------------------------------

  private error(at: Pos, message: string): void {
    this.errors.push({ line: at.line, col: at.col, message });
  }

  private warn(at: Pos, message: string): void {
    this.warnings.push({ line: at.line, col: at.col, message });
  }

  private id(): number {
    return this.ids++;
  }

  private get topLevel(): boolean {
    return this.scopes.length === 1 && this.func === null;
  }

  private lookup(name: string): VarSym | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const sym = this.scopes[i].get(name);
      if (sym) return sym;
    }
    return undefined;
  }

  /** Validates and registers a new variable in the innermost scope. */
  private declare(name: string, at: Pos, extra: Partial<VarSym> = {}): VarSym {
    if (isReservedName(name)) this.error(at, `"${name}" is a built-in name; choose another name`);
    else if (this.scopes[this.scopes.length - 1].has(name)) this.error(at, `"${name}" is already declared in this scope (use := to change it)`);
    else if (this.funcs.has(name)) this.error(at, `"${name}" is already the name of a function`);
    const sym: VarSym = {
      name, js: `u${this.id()}_${name}`, global: this.topLevel, constInput: false, input: false, param: false, loopVar: false,
      owner: this.func, history: 0, bounds: UNBOUNDED, ...extra,
    };
    this.scopes[this.scopes.length - 1].set(name, sym);
    return sym;
  }

  private withScope<T>(fn: () => T): T {
    this.scopes.push(new Map());
    try {
      return fn();
    } finally {
      this.scopes.pop();
    }
  }

  // ---- statements ----------------------------------------------------------------------------------

  private stmts(list: Stmt[]): string {
    return list.map((s) => this.stmt(s)).filter((c) => c !== '').join('\n');
  }

  private stmt(s: Stmt): string {
    switch (s.k) {
      case 'decl':
        return this.decl(s);
      case 'tupleDecl':
        return this.tupleDecl(s);
      case 'assign':
        return this.assign(s);
      case 'if': {
        const cond = this.scalar(s.cond);
        this.cond++;
        try {
          const then = this.withScope(() => this.stmts(s.then));
          const otherwise = s.else ? this.withScope(() => this.stmts(s.else!)) : null;
          return `if (${cond}) {\n${then}\n}${otherwise === null ? '' : ` else {\n${otherwise}\n}`}`;
        } finally {
          this.cond--;
        }
      }
      case 'for':
        return this.forLoop(s);
      case 'func':
        this.funcDef(s);
        return '';
      case 'break':
      case 'continue':
        if (this.loop === 0) this.error(s, `"${s.k}" can only be used inside a for loop`);
        return `${s.k};`;
      case 'expr':
        return this.exprStmt(s.expr);
    }
  }

  private exprStmt(e: Expr): string {
    if (e.k === 'call') {
      const name = dottedName(e.callee);
      if (name === 'indicator') return '';
      if (name === 'plot') return this.plot(e);
      if (name !== null && IGNORED_CALLS.has(name)) {
        this.warn(e, `${name}() is accepted but ignored in v1 (not drawn)`);
        return '';
      }
    }
    return `${this.expr(e).js};`;
  }

  private plot(call: CallExpr): string {
    const index = this.input.plotIndex.get(call);
    const [series] = bindArgs('plot', PLOT_SIG, call.args, call, []);
    const value = series ? this.scalar(series) : 'NaN';
    return index === undefined ? '' : `rt.out[${index}] = rt.num(${value});`;
  }

  private decl(s: Extract<Stmt, { k: 'decl' }>): string {
    const binding = this.input.inputs.get(s);
    if (binding) return this.inputDecl(s, binding);
    if (s.init.k === 'call' && dottedName(s.init.callee) !== null && INPUT_SIGS.has(dottedName(s.init.callee)!)) {
      this.declare(s.name, s); // misplaced input: already reported by the analysis
      return '';
    }
    if (s.init.k === 'call' && dottedName(s.init.callee) === 'plot') {
      const code = this.plot(s.init);
      const sym = this.declare(s.name, s);
      if (sym.global) this.prologue.push(`let ${sym.js} = NaN;`);
      return sym.global ? code : `${code}\nlet ${sym.js} = NaN;`;
    }
    const persistent = s.mode === 'var';
    if (persistent && this.func) this.error(s, '"var" inside user functions is not supported in v1');
    if (persistent) this.cond++;
    let value: string;
    try {
      value = this.scalar(s.init);
    } finally {
      if (persistent) this.cond--;
    }
    const isSimple = this.topLevel && !persistent && !this.input.reassigned.has(s.name);
    const simpleJs = isSimple ? this.simple(s.init) ?? undefined : undefined;
    const bounds = isSimple ? this.bounds(s.init) : UNBOUNDED;
    const sym = this.declare(s.name, s, { simpleJs, bounds });
    if (persistent) {
      const flag = `z${this.id()}`;
      this.prologue.push(`let ${sym.js} = NaN;`, `let ${flag} = false;`);
      return `if (!${flag}) {\n${flag} = true;\n${sym.js} = ${value};\n}`;
    }
    if (sym.global) {
      this.prologue.push(`let ${sym.js} = NaN;`);
      return `${sym.js} = ${value};`;
    }
    return `let ${sym.js} = ${value};`;
  }

  private inputDecl(s: Extract<Stmt, { k: 'decl' }>, binding: InputBinding): string {
    const { info } = binding;
    if (info.kind === 'source') {
      const sym = this.declare(s.name, s, { input: true });
      this.prologue.push(`let ${sym.js} = NaN;`);
      const field = BUILTIN_SERIES.get(String(info.defval))!.field;
      return `${sym.js} = ${binding.primarySource ? 'rt.src' : `rt.px(${jsString(field)}, 0)`};`;
    }
    const bounds: Bounds = info.kind === 'int' ? { lo: info.min ?? -Infinity, hi: info.max ?? Infinity } : UNBOUNDED;
    const sym = this.declare(s.name, s, { input: true, constInput: true, bounds });
    sym.simpleJs = sym.js;
    this.prologue.push(`const ${sym.js} = ${info.kind === 'bool' ? `P[${binding.param}] !== 0` : `P[${binding.param}]`};`);
    return '';
  }

  private tupleDecl(s: Extract<Stmt, { k: 'tupleDecl' }>): string {
    const v = this.expr(s.init);
    if (v.tuple === 0) this.error(s.init, `the right side returns one value, not ${s.names.length}`);
    else if (v.tuple !== s.names.length) this.error(s, `the right side returns ${v.tuple} values but ${s.names.length} names are given`);
    const syms = s.names.map((n) => this.declare(n.name, n));
    const names = syms.map((sym) => sym.js).join(', ');
    if (this.topLevel) {
      for (const sym of syms) this.prologue.push(`let ${sym.js} = NaN;`);
      return `[${names}] = ${v.js};`;
    }
    return `let [${names}] = ${v.js};`;
  }

  private assign(s: Extract<Stmt, { k: 'assign' }>): string {
    const sym = this.lookup(s.name);
    const value = this.scalar(s.value);
    if (!sym) {
      if (this.funcs.has(s.name)) this.error(s, `"${s.name}" is a function and cannot be assigned`);
      else if (isReservedName(s.name)) this.error(s, `"${s.name}" is a built-in and cannot be assigned`);
      else this.error(s, `cannot assign to undeclared variable "${s.name}" (declare it first with ${s.name} = ...)`);
      return '';
    }
    if (sym.input) this.error(s, `"${s.name}" is an input and cannot be changed`);
    else if (sym.param) this.error(s, `function parameter "${s.name}" cannot be changed`);
    else if (sym.loopVar) this.error(s, `loop variable "${s.name}" cannot be changed`);
    else if (this.func && sym.owner !== this.func) this.error(s, `user functions cannot change the global variable "${s.name}" (Pine rule)`);
    const op = COMPOUND.get(s.op);
    return op ? `${sym.js} = (${sym.js} ${op} ${value});` : `${sym.js} = ${value};`;
  }

  private forLoop(s: Extract<Stmt, { k: 'for' }>): string {
    const from = this.scalar(s.from);
    const to = this.scalar(s.to);
    const by = s.by ? this.scalar(s.by) : null;
    const fb = this.bounds(s.from);
    const tb = this.bounds(s.to);
    const k = this.id();
    const [a, b, st] = [`a${k}`, `b${k}`, `s${k}`];
    this.cond++;
    this.loop++;
    try {
      return this.withScope(() => {
        const v = this.declare(s.name, s, { loopVar: true, bounds: { lo: Math.min(fb.lo, tb.lo), hi: Math.max(fb.hi, tb.hi) } });
        const body = this.stmts(s.body);
        return [
          `{`,
          `const ${a} = rt.num(${from}), ${b} = rt.num(${to}), ${st} = ${by === null ? '1' : `rt.forStep(${by}, ${s.line}, ${s.col})`};`,
          `for (let ${v.js} = ${a}; ${a} <= ${b} ? ${v.js} <= ${b} : ${v.js} >= ${b}; ${v.js} += ${a} <= ${b} ? ${st} : -${st}) {`,
          `rt.loop(${s.line}, ${s.col});`,
          body,
          `}`,
          `}`,
        ].join('\n');
      });
    } finally {
      this.cond--;
      this.loop--;
    }
  }

  private funcDef(s: Extract<Stmt, { k: 'func' }>): void {
    if (isReservedName(s.name)) this.error(s, `"${s.name}" is a built-in name; choose another function name`);
    else if (this.funcs.has(s.name) || this.scopes[0].has(s.name)) this.error(s, `"${s.name}" is already declared`);
    const fn: FuncSym = { name: s.name, js: `f${this.id()}_${s.name}`, arity: s.params.length, tuple: 0 };
    const saved = { cond: this.cond, loop: this.loop };
    this.func = fn;
    this.cond = 0;
    this.loop = 0;
    let code = '';
    try {
      code = this.withScope(() => {
        const seen = new Set<string>();
        const params = s.params.map((p) => {
          if (seen.has(p.name)) this.error(p, `parameter "${p.name}" is listed twice`);
          seen.add(p.name);
          return this.declare(p.name, p, { param: true }).js;
        });
        const body = s.body.slice(0, -1).map((x) => this.stmt(x)).filter((c) => c !== '');
        const last = s.body[s.body.length - 1];
        if (last.k === 'expr') {
          const v = this.expr(last.expr, true);
          fn.tuple = v.tuple;
          body.push(`return ${v.js};`);
        } else if (last.k === 'decl' || last.k === 'assign') {
          body.push(this.stmt(last));
          const sym = this.lookup(last.name);
          body.push(`return ${sym ? sym.js : 'NaN'};`);
        } else {
          this.error(last, 'the last line of a function must be a value (it is what the function returns)');
        }
        return `function ${fn.js}(${params.join(', ')}) {\n${body.join('\n')}\n}`;
      });
    } finally {
      this.func = null;
      this.cond = saved.cond;
      this.loop = saved.loop;
    }
    this.funcs.set(s.name, fn);
    this.functions.push(code);
  }

  // ---- expressions ---------------------------------------------------------------------------------

  /** A single value (tuples are an error here). */
  private scalar(e: Expr): string {
    const v = this.expr(e);
    if (v.tuple > 0) {
      const names = Array.from({ length: v.tuple }, (_, i) => String.fromCharCode(97 + i)).join(', ');
      this.error(e, `this returns ${v.tuple} values: destructure it with [${names}] = ...`);
      return 'NaN';
    }
    return v.js;
  }

  private expr(e: Expr, allowTuple = false): Val {
    const one = (js: string): Val => ({ js, tuple: 0 });
    switch (e.k) {
      case 'num':
        return one(jsNum(e.value));
      case 'str':
        return one(jsString(e.value));
      case 'bool':
        return one(e.value ? 'true' : 'false');
      case 'color':
        return one('"color"');
      case 'ident':
        return one(this.identifier(e));
      case 'member':
        return one(this.member(e));
      case 'call':
        return this.call(e);
      case 'index':
        return one(this.history(e));
      case 'unary': {
        const x = this.scalar(e.operand);
        return one(e.op === 'not' ? `(!${x})` : `(${e.op}${x})`);
      }
      case 'binary': {
        const a = this.scalar(e.left);
        const b = this.scalar(e.right);
        if (e.op === 'and' || e.op === 'or') return one(`rt.${e.op}(${a}, ${b})`);
        return one(`(${a} ${ARITHMETIC.get(e.op)} ${b})`);
      }
      case 'ternary': {
        const c = this.scalar(e.cond);
        this.cond++;
        try {
          return one(`(${c} ? ${this.scalar(e.then)} : ${this.scalar(e.else)})`);
        } finally {
          this.cond--;
        }
      }
      case 'tuple': {
        if (!allowTuple) {
          this.error(e, 'a [a, b] tuple is only allowed as the last line of a function');
          return one('NaN');
        }
        if (e.items.length < 2) this.error(e, 'a tuple needs at least two values');
        return { js: `[${e.items.map((x) => this.scalar(x)).join(', ')}]`, tuple: e.items.length };
      }
    }
  }

  private identifier(e: Extract<Expr, { k: 'ident' }>): string {
    if (e.name === 'na') return 'NaN';
    const series = BUILTIN_SERIES.get(e.name);
    if (series) return series.js;
    const sym = this.lookup(e.name);
    if (sym) return sym.js;
    if (this.funcs.has(e.name)) this.error(e, `"${e.name}" is a function: call it with ${e.name}(...)`);
    else if (UNSUPPORTED.has(e.name)) this.error(e, UNSUPPORTED.get(e.name)!);
    else if (NAMESPACES.has(e.name)) this.error(e, `"${e.name}" is a namespace: use ${e.name}.something`);
    else this.error(e, `"${e.name}" is not declared`);
    return 'NaN';
  }

  private member(e: Extract<Expr, { k: 'member' }>): string {
    const name = dottedName(e);
    if (name === 'ta.tr') return this.ta(e, 'tr', []);
    if (e.object.k === 'ident' && e.object.name === 'math' && MATH_CONSTANTS.has(e.name)) return jsNum(MATH_CONSTANTS.get(e.name)!);
    if (e.object.k === 'ident' && e.object.name === 'color' && COLOR_NAMES.has(e.name)) return '"color"';
    this.memberError(e, name, false);
    return 'NaN';
  }

  /** Explains why `a.b` (or a call of it) is not allowed. */
  private memberError(at: Pos, name: string | null, called: boolean): void {
    const root = name?.split('.')[0];
    if (name === null || root === undefined) {
      this.error(at, called ? 'only named functions can be called' : 'member access is not supported in v1');
    } else if (UNSUPPORTED.has(root)) {
      this.error(at, UNSUPPORTED.get(root)!);
    } else if (NAMESPACES.has(root)) {
      this.error(at, called ? `unknown function ${name}()` : `unknown value ${name}`);
    } else if (this.lookup(root) || BUILTIN_SERIES.has(root) || this.funcs.has(root) || root === 'na') {
      this.error(at, `member access (${name}) is not supported in v1`);
    } else {
      this.error(at, `unknown namespace "${root}"`);
    }
  }

  private call(e: CallExpr): Val {
    const one = (js: string): Val => ({ js, tuple: 0 });
    const name = dottedName(e.callee);
    if (name === null) {
      this.error(e, 'only named functions can be called');
      return one('NaN');
    }
    const dot = name.indexOf('.');
    const root = dot < 0 ? name : name.slice(0, dot);
    const member = dot < 0 ? '' : name.slice(dot + 1);
    if (name === 'indicator' || name === 'plot' || INPUT_SIGS.has(name)) return one('NaN'); // placement reported by the analysis
    if (IGNORED_CALLS.has(name)) {
      this.warn(e, `${name}() is accepted but ignored in v1 (not drawn)`);
      return one('NaN');
    }
    if (UNSUPPORTED.has(name)) {
      this.error(e, UNSUPPORTED.get(name)!);
      return one('NaN');
    }
    if (dot < 0) {
      if (name === 'na' || name === 'nz') {
        const args = bindArgs(name, name === 'na' ? NA_SIG : NZ_SIG, e.args, e, this.errors);
        const x = args[0] ? this.scalar(args[0]) : 'NaN';
        return one(name === 'na' ? `rt.na(${x})` : `rt.nz(${x}, ${args[1] ? this.scalar(args[1]) : '0'})`);
      }
      const fn = this.funcs.get(name);
      if (fn) return this.userCall(e, fn);
      if (this.lookup(name)) this.error(e, `"${name}" is a variable, not a function`);
      else this.error(e, `unknown function "${name}"`);
      return one('NaN');
    }
    if (root === 'ta' && !member.includes('.')) {
      const info = TA_FUNCTIONS.get(member);
      if (!info) {
        this.error(e, `unknown function ta.${member}() (v1 supports ${[...TA_FUNCTIONS.keys()].join(', ')})`);
        return one('NaN');
      }
      return { js: this.ta(e, member, e.args), tuple: info.tuple };
    }
    if (root === 'math' && MATH_FUNCTIONS.has(member)) {
      const info = MATH_FUNCTIONS.get(member)!;
      const args = bindArgs(name, info.sig, e.args, e, this.errors);
      const code = args.filter((a): a is Expr => a !== undefined).map((a) => this.scalar(a));
      return one(`rt.${info.js}(${code.join(', ')})`);
    }
    if (root === 'color' && COLOR_FUNCTIONS.has(member)) {
      const args = bindArgs(name, COLOR_FUNCTIONS.get(member)!, e.args, e, this.errors);
      for (const a of args) if (a) this.scalar(a);
      return one('rt.color()');
    }
    this.memberError(e, name, true);
    return one('NaN');
  }

  private userCall(e: CallExpr, fn: FuncSym): Val {
    if (e.args.some((a) => a.name !== undefined)) this.error(e, `named arguments are not supported for user functions in v1`);
    if (e.args.length !== fn.arity) this.error(e, `${fn.name}() takes ${fn.arity} argument${fn.arity === 1 ? '' : 's'}, got ${e.args.length}`);
    const args = e.args.map((a) => this.scalar(a.value));
    return { js: `${fn.js}(${args.join(', ')})`, tuple: fn.tuple };
  }

  /** One ta.* call site: an instance created once (factory level), updated where the call appears. */
  private ta(at: Pos, fn: string, rawArgs: Arg[]): string {
    const info = TA_FUNCTIONS.get(fn)!;
    if (this.func) {
      this.error(at, 'ta.* inside user functions is not supported in v1 (call it at the top level and pass the result in)');
      return 'NaN';
    }
    if (this.cond > 0) {
      this.warn(at, `ta.${fn} is inside a conditional or loop: its state only updates on bars where this line runs (call it at the top level to update it every bar)`);
    }
    let args = bindArgs(`ta.${fn}`, info.sig, rawArgs, at, this.errors);
    if (info.kind === 'hilo' && rawArgs.length === 1 && rawArgs[0].name === undefined) {
      args = [{ k: 'ident', name: fn === 'highest' ? 'high' : 'low', line: at.line, col: at.col }, rawArgs[0].value];
    }
    const simple = (i: number): string => {
      const a = args[i];
      if (!a) return 'undefined';
      const code = this.simple(a);
      if (code === null) {
        this.error(a, `ta.${fn} ${info.sig.params[i]} must be a constant: a number, an input, or arithmetic on them`);
        return 'NaN';
      }
      return code;
    };
    const series = (i: number) => (args[i] ? `rt.num(${this.scalar(args[i]!)})` : 'NaN');
    const t = `T${this.id()}`;
    const where = `${at.line}, ${at.col}`;
    switch (info.kind) {
      case 'series':
      case 'hilo':
        this.prologue.push(`const ${t} = rt.${info.factory}(${simple(1)}, ${where});`);
        return `${t}.update(${series(0)})`;
      case 'macd':
        this.prologue.push(`const ${t} = rt.macd(${simple(1)}, ${simple(2)}, ${simple(3)}, ${where});`);
        return `${t}.update(${series(0)})`;
      case 'bb':
        this.prologue.push(`const ${t} = rt.bb(${simple(1)}, ${simple(2)}, ${where});`);
        return `${t}.update(${series(0)})`;
      case 'atr':
        this.prologue.push(`const ${t} = rt.atr(${simple(0)}, ${where});`);
        return `${t}.update(rt.bar)`;
      case 'stoch':
        this.prologue.push(`const ${t} = rt.stoch(${simple(3)}, ${where});`);
        return `${t}.update(${series(0)}, ${series(1)}, ${series(2)})`;
      case 'cross':
        this.prologue.push(`const ${t} = rt.${info.factory}();`);
        return `${t}.update(${series(0)}, ${series(1)})`;
      case 'tr': {
        const h = args[0];
        if (h && h.k !== 'bool') this.error(h, 'ta.tr handle_na must be true or false');
        this.prologue.push(`const ${t} = rt.tr(${h?.k === 'bool' && h.value ? 'true' : 'false'});`);
        return `${t}.update(rt.bar)`;
      }
    }
  }

  /** `x[n]`: history of a built-in series or a top-level variable. */
  private history(e: Extract<Expr, { k: 'index' }>): string {
    const offset = this.scalar(e.index);
    const b = this.bounds(e.index);
    const literal = e.index.k === 'num' ? e.index.value : null;
    let ok = true;
    if ((literal !== null && (!Number.isInteger(literal) || literal < 0)) || b.hi < 0) {
      this.error(e.index, 'history offset must be a whole number ≥ 0');
      ok = false;
    } else if (!Number.isFinite(b.hi)) {
      this.error(e.index, 'history offset needs a known maximum: use a number, an input.int with maxval, or a for-loop variable bounded by those');
      ok = false;
    } else if (b.hi > MAX_HISTORY) {
      this.error(e.index, `history offset can be at most ${MAX_HISTORY}`);
      ok = false;
    }
    const max = ok ? Math.max(0, b.hi) : 0;
    if (e.object.k !== 'ident') {
      this.error(e, 'history [] works on variables and built-in series only in v1 (assign the expression to a variable first)');
      return 'NaN';
    }
    const name = e.object.name;
    const series = BUILTIN_SERIES.get(name);
    if (series) {
      this.maxBarsBack = Math.max(this.maxBarsBack, max);
      return series.field === 'bar_index' ? `rt.bi(${offset})` : `rt.px(${jsString(series.field)}, ${offset})`;
    }
    const sym = this.lookup(name);
    if (!sym) return this.identifier(e.object);
    if (sym.constInput) {
      this.error(e, `"${name}" is an input (constant): history [] is not needed`);
      return sym.js;
    }
    if (!sym.global || sym.owner !== null) {
      this.error(e, 'history [] of variables declared inside if / for / functions (or of function parameters) is not supported in v1');
      return 'NaN';
    }
    if (literal === 0) return sym.js;
    if (!sym.histJs) {
      sym.histJs = `H${this.id()}`;
      this.historySyms.push(sym);
    }
    sym.history = Math.max(sym.history, max, 1);
    return `rt.hist(${sym.histJs}, ${sym.js}, ${offset})`;
  }

  // ---- static evaluation ---------------------------------------------------------------------------

  /** Factory-level code for a constant ("simple") expression, or null if it varies per bar. Pure. */
  private simple(e: Expr): string | null {
    switch (e.k) {
      case 'num':
        return jsNum(e.value);
      case 'bool':
        return e.value ? 'true' : 'false';
      case 'ident': {
        if (e.name === 'na') return 'NaN';
        const sym = this.lookup(e.name);
        return sym?.simpleJs !== undefined ? (sym.constInput ? sym.simpleJs : `(${sym.simpleJs})`) : null;
      }
      case 'member':
        return e.object.k === 'ident' && e.object.name === 'math' && MATH_CONSTANTS.has(e.name) ? jsNum(MATH_CONSTANTS.get(e.name)!) : null;
      case 'unary': {
        const x = this.simple(e.operand);
        return x === null ? null : e.op === 'not' ? `(!${x})` : `(${e.op}${x})`;
      }
      case 'binary': {
        const a = this.simple(e.left);
        const b = this.simple(e.right);
        if (a === null || b === null) return null;
        return e.op === 'and' || e.op === 'or' ? `rt.${e.op}(${a}, ${b})` : `(${a} ${ARITHMETIC.get(e.op)} ${b})`;
      }
      case 'ternary': {
        const [c, a, b] = [this.simple(e.cond), this.simple(e.then), this.simple(e.else)];
        return c === null || a === null || b === null ? null : `(${c} ? ${a} : ${b})`;
      }
      case 'call': {
        const name = dottedName(e.callee);
        const info = name?.startsWith('math.') ? MATH_FUNCTIONS.get(name.slice(5)) : undefined;
        if (!info) return null;
        const args = bindArgs(name!, info.sig, e.args, e, []);
        const code = args.filter((a): a is Expr => a !== undefined).map((a) => this.simple(a));
        return code.some((c) => c === null) ? null : `rt.${info.js}(${code.join(', ')})`;
      }
      default:
        return null;
    }
  }

  /** Integer range an expression can take (used to size history buffers). */
  private bounds(e: Expr): Bounds {
    switch (e.k) {
      case 'num':
        return Number.isInteger(e.value) ? { lo: e.value, hi: e.value } : UNBOUNDED;
      case 'ident':
        return this.lookup(e.name)?.bounds ?? UNBOUNDED;
      case 'unary': {
        const x = this.bounds(e.operand);
        if (e.op === '-') return { lo: -x.hi, hi: -x.lo };
        return e.op === '+' ? x : UNBOUNDED;
      }
      case 'binary': {
        const a = this.bounds(e.left);
        const b = this.bounds(e.right);
        if (e.op === '+') return { lo: a.lo + b.lo, hi: a.hi + b.hi };
        if (e.op === '-') return { lo: a.lo - b.hi, hi: a.hi - b.lo };
        if (e.op === '*' && a.lo >= 0 && b.lo >= 0) return { lo: mulBound(a.lo, b.lo), hi: mulBound(a.hi, b.hi) };
        return UNBOUNDED;
      }
      case 'call': {
        const name = dottedName(e.callee);
        if ((name === 'math.min' || name === 'math.max') && e.args.length >= 2 && e.args.every((a) => a.name === undefined)) {
          const bs = e.args.map((a) => this.bounds(a.value));
          return name === 'math.min'
            ? { lo: Math.min(...bs.map((x) => x.lo)), hi: Math.min(...bs.map((x) => x.hi)) }
            : { lo: Math.max(...bs.map((x) => x.lo)), hi: Math.max(...bs.map((x) => x.hi)) };
        }
        return UNBOUNDED;
      }
      default:
        return UNBOUNDED;
    }
  }
}

export function generate(input: CodegenInput): CodegenResult {
  return new Codegen(input).run();
}
