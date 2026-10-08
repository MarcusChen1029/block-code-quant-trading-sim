import { exprDepth, type Arg, type Expr, type Name, type Pos, type Stmt } from './ast';
import { PineSyntaxError } from './diagnostics';
import { lex, type Token } from './lexer';

const QUALIFIERS = new Set(['const', 'simple', 'series']);
const TYPE_NAMES = new Set(['int', 'float', 'bool', 'string', 'color']);
const COLLECTION_TYPES = new Set(['array', 'matrix', 'map']);
const PLURAL: Record<string, string> = { array: 'arrays', matrix: 'matrices', map: 'maps' };
const DRAWING_TYPES = new Set(['label', 'line', 'box', 'table', 'linefill', 'polyline']);
const ASSIGN_OPS = new Set([':=', '+=', '-=', '*=', '/=', '%=']);
const COMPARISON = new Set(['<', '<=', '>', '>=']);

/** Messages for keywords the v1 subset rejects at statement level. */
const UNSUPPORTED_KEYWORDS: Record<string, string> = {
  while: '"while" loops are not supported in v1 (use a for loop)',
  switch: '"switch" is not supported in v1 (use if / else if)',
  import: '"import" (libraries) is not supported in v1',
  export: '"export" (libraries) is not supported in v1',
  type: 'user-defined types ("type") are not supported in v1',
  method: '"method" declarations are not supported in v1',
};
Object.setPrototypeOf(UNSUPPORTED_KEYWORDS, null);

const pos = (t: Pos): Pos => ({ line: t.line, col: t.col });

/** Deepest expression tree accepted (`a + b + c ...` counts one level per operator). Keeps later passes' recursion bounded. */
export const MAX_EXPRESSION_DEPTH = 256;
/** Deepest nesting of if / for / function bodies. */
export const MAX_BLOCK_DEPTH = 32;

class Parser {
  private i = 0;
  private depth = 0;
  private blockDepth = 0;

  constructor(private readonly tokens: Token[]) {}

  program(): Stmt[] {
    const out: Stmt[] = [];
    while (!this.at('eof')) {
      if (this.at('newline')) {
        this.i++;
        continue;
      }
      if (this.at('indent')) this.fail(this.peek(), 'unexpected indentation');
      out.push(this.statement(true));
    }
    return out;
  }

  // ---- token helpers -------------------------------------------------------------------------------

  private peek(k = 0): Token {
    return this.tokens[Math.min(this.i + k, this.tokens.length - 1)];
  }

  private next(): Token {
    const t = this.peek();
    if (t.kind !== 'eof') this.i++;
    return t;
  }

  private at(kind: Token['kind'], value?: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === kind && (value === undefined || t.value === value);
  }

  private isOp(value: string, k = 0): boolean {
    return this.at('op', value, k);
  }

  private fail(t: Pos, message: string): never {
    throw new PineSyntaxError(t.line, t.col, message);
  }

  private describe(t: Token): string {
    switch (t.kind) {
      case 'newline':
        return 'end of line';
      case 'eof':
        return 'end of script';
      case 'indent':
        return 'indentation';
      case 'dedent':
        return 'end of block';
      case 'str':
        return 'a string';
      default:
        return `"${t.value}"`;
    }
  }

  private expectOp(value: string, what = `"${value}"`): Token {
    if (!this.isOp(value)) this.fail(this.peek(), `expected ${what}, found ${this.describe(this.peek())}`);
    return this.next();
  }

  private expectIdent(what: string): Token {
    if (!this.at('ident')) this.fail(this.peek(), `expected ${what}, found ${this.describe(this.peek())}`);
    return this.next();
  }

  private endOfStatement(): void {
    if (this.at('newline')) this.i++;
    else if (!this.at('eof') && !this.at('dedent')) this.fail(this.peek(), `expected end of line, found ${this.describe(this.peek())}`);
  }

  /** NEWLINE INDENT statement+ DEDENT */
  private block(owner: string): Stmt[] {
    if (this.blockDepth >= MAX_BLOCK_DEPTH) this.fail(this.peek(), `blocks are nested too deeply (limit ${MAX_BLOCK_DEPTH} levels)`);
    this.blockDepth++;
    try {
      return this.blockBody(owner);
    } finally {
      this.blockDepth--;
    }
  }

  private blockBody(owner: string): Stmt[] {
    if (!this.at('newline')) this.fail(this.peek(), `expected a new line after ${owner}`);
    this.i++;
    if (!this.at('indent')) this.fail(this.peek(), `the body of ${owner} must be indented by 4 spaces`);
    this.i++;
    const out: Stmt[] = [];
    while (!this.at('dedent') && !this.at('eof')) {
      if (this.at('newline')) {
        this.i++;
        continue;
      }
      out.push(this.statement(false));
    }
    if (this.at('dedent')) this.i++;
    return out;
  }

  // ---- statements ----------------------------------------------------------------------------------

  private statement(topLevel: boolean): Stmt {
    const t = this.peek();
    if (t.kind === 'kw') {
      if (UNSUPPORTED_KEYWORDS[t.value]) this.fail(t, UNSUPPORTED_KEYWORDS[t.value]);
      switch (t.value) {
        case 'if':
          return this.ifStatement();
        case 'for':
          return this.forStatement();
        case 'break':
        case 'continue':
          this.next();
          this.endOfStatement();
          return { k: t.value, ...pos(t) };
        case 'var':
        case 'varip': {
          this.next();
          const typed = this.typePrefixLength();
          const type = typed > 0 ? this.declaredType(typed) : undefined;
          const name = this.typedName();
          return this.declaration(name, 'var', t, type);
        }
        default:
          break;
      }
    }
    if (t.kind === 'ident') {
      const typed = this.typePrefixLength();
      if (typed > 0) {
        const type = this.declaredType(typed);
        this.i += typed;
        const name = this.expectIdent('a variable name');
        return this.declaration(name, 'plain', t, type);
      }
      if (this.isOp('(', 1) && this.isFunctionDef()) {
        if (!topLevel) this.fail(t, 'functions must be defined at the top level of the script');
        return this.functionDef();
      }
      if (this.isOp('=', 1)) {
        this.next();
        return this.declaration(t, 'plain', t);
      }
      if (this.peek(1).kind === 'op' && ASSIGN_OPS.has(this.peek(1).value)) {
        this.next();
        const op = this.next().value;
        const value = this.expression();
        this.endOfStatement();
        return { k: 'assign', name: t.value, op, value, ...pos(t) };
      }
    }
    if (this.isOp('[') && this.isTupleDecl()) return this.tupleDeclaration();
    const expr = this.expression();
    if (this.isOp('=')) this.fail(this.peek(), 'only a plain name can be declared with "=" here');
    if (this.peek().kind === 'op' && ASSIGN_OPS.has(this.peek().value)) this.fail(this.peek(), `only a variable name can be reassigned with "${this.peek().value}"`);
    this.endOfStatement();
    return { k: 'expr', expr, ...pos(t) };
  }

  /** After `var`: optional qualifier/type, then the name. */
  private typedName(): Token {
    const typed = this.typePrefixLength();
    if (typed > 0) this.i += typed;
    else this.rejectCollectionType(this.peek());
    return this.expectIdent('a variable name after "var"');
  }

  /**
   * Number of tokens of a `[qualifier] type` prefix before `name =`, or 0. Throws for array / map / matrix /
   * drawing types.
   */
  private typePrefixLength(): number {
    let k = 0;
    if (this.at('ident') && QUALIFIERS.has(this.peek().value) && this.at('ident', undefined, 1)) k++;
    const t = this.peek(k);
    if (t.kind !== 'ident') return 0;
    const declaresName = (j: number) => this.at('ident', undefined, j) && (this.isOp('=', j + 1));
    if (COLLECTION_TYPES.has(t.value) && (this.isOp('<', k + 1) || declaresName(k + 1))) this.rejectCollectionType(t);
    if (TYPE_NAMES.has(t.value) || DRAWING_TYPES.has(t.value)) {
      if (this.isOp('[', k + 1) && this.isOp(']', k + 2)) this.fail(t, 'arrays are not supported in v1');
      if (declaresName(k + 1)) {
        if (t.value === 'label') this.fail(t, 'label objects beyond label.new at the current bar are not supported (a label cannot be stored in a variable)');
        if (DRAWING_TYPES.has(t.value)) this.fail(t, `drawing objects (${t.value}) are not supported in v1`);
        return k + 1;
      }
    }
    return k > 0 && declaresName(k) ? k : 0;
  }

  /** The type name among the next `count` tokens of a `[qualifier] type` prefix, if there is one. */
  private declaredType(count: number): string | undefined {
    for (let k = count - 1; k >= 0; k--) {
      const t = this.peek(k);
      if (t.kind === 'ident' && TYPE_NAMES.has(t.value)) return t.value;
    }
    return undefined;
  }

  private rejectCollectionType(t: Token): void {
    if (t.kind === 'ident' && COLLECTION_TYPES.has(t.value)) this.fail(t, `${PLURAL[t.value]} are not supported in v1`);
  }

  private declaration(name: Token, mode: 'plain' | 'var', start: Token, type?: string): Stmt {
    if (this.isOp(':=')) this.fail(this.peek(), `"${name.value}" is being declared: use "=" (":=" reassigns an existing variable)`);
    this.expectOp('=');
    const init = this.expression();
    this.endOfStatement();
    return { k: 'decl', name: name.value, mode, init, ...pos(start), ...(type === undefined ? {} : { type }) };
  }

  private isTupleDecl(): boolean {
    let k = 1;
    for (;;) {
      if (!this.at('ident', undefined, k)) return false;
      k++;
      if (this.isOp(',', k)) {
        k++;
        continue;
      }
      return this.isOp(']', k) && this.isOp('=', k + 1);
    }
  }

  private tupleDeclaration(): Stmt {
    const start = this.next();
    const names: Name[] = [];
    do {
      const t = this.expectIdent('a variable name');
      names.push({ name: t.value, ...pos(t) });
    } while (this.isOp(',') && this.next());
    this.expectOp(']');
    this.expectOp('=');
    const init = this.expression();
    this.endOfStatement();
    return { k: 'tupleDecl', names, init, ...pos(start) };
  }

  /** ident ( ... ) => */
  private isFunctionDef(): boolean {
    let depth = 0;
    for (let k = 1; ; k++) {
      const t = this.peek(k);
      if (t.kind === 'eof' || t.kind === 'newline') return false;
      if (t.kind === 'op' && (t.value === '(' || t.value === '[')) depth++;
      if (t.kind === 'op' && (t.value === ')' || t.value === ']')) {
        depth--;
        if (depth === 0) return this.isOp('=>', k + 1);
      }
    }
  }

  private functionDef(): Stmt {
    const nameTok = this.next();
    this.expectOp('(');
    const params: Name[] = [];
    if (!this.isOp(')')) {
      do {
        if (this.at('ident') && (TYPE_NAMES.has(this.peek().value) || QUALIFIERS.has(this.peek().value)) && this.at('ident', undefined, 1)) {
          this.next();
          if (this.at('ident') && TYPE_NAMES.has(this.peek().value) && this.at('ident', undefined, 1)) this.next();
        }
        const p = this.expectIdent('a parameter name');
        if (this.isOp('=')) this.fail(this.peek(), 'default parameter values are not supported in v1');
        params.push({ name: p.value, ...pos(p) });
      } while (this.isOp(',') && this.next());
    }
    this.expectOp(')');
    this.expectOp('=>');
    let body: Stmt[];
    if (this.at('newline')) {
      body = this.block(`function "${nameTok.value}"`);
    } else {
      const start = this.peek();
      const expr = this.expression();
      this.endOfStatement();
      body = [{ k: 'expr', expr, ...pos(start) }];
    }
    return { k: 'func', name: nameTok.value, params, body, ...pos(nameTok) };
  }

  private ifStatement(): Stmt {
    const start = this.next();
    const cond = this.expression();
    const then = this.block('"if"');
    let elseBody: Stmt[] | null = null;
    if (this.at('kw', 'else')) {
      this.next();
      elseBody = this.at('kw', 'if') ? [this.ifStatement()] : this.block('"else"');
    }
    return { k: 'if', cond, then, else: elseBody, ...pos(start) };
  }

  private forStatement(): Stmt {
    const start = this.next();
    if (this.isOp('[') || (this.at('ident') && this.at('kw', 'in', 1))) this.fail(start, '"for … in" loops are not supported in v1 (use for i = a to b)');
    const name = this.expectIdent('a loop variable');
    if (this.at('kw', 'in')) this.fail(start, '"for … in" loops are not supported in v1 (use for i = a to b)');
    this.expectOp('=');
    const from = this.expression();
    if (!this.at('kw', 'to')) this.fail(this.peek(), `expected "to", found ${this.describe(this.peek())}`);
    this.next();
    const to = this.expression();
    let by: Expr | null = null;
    if (this.at('kw', 'by')) {
      this.next();
      by = this.expression();
    }
    const body = this.block('"for"');
    return { k: 'for', name: name.value, from, to, by, body, ...pos(start) };
  }

  // ---- expressions ---------------------------------------------------------------------------------

  expression(): Expr {
    if (++this.depth > MAX_EXPRESSION_DEPTH) this.fail(this.peek(), `expression is nested too deeply (limit ${MAX_EXPRESSION_DEPTH} levels)`);
    try {
      const e = this.ternary();
      // Operator / postfix chains are parsed iteratively but build deep trees: bound them here, once per expression.
      if (this.depth === 1 && exprDepth(e) > MAX_EXPRESSION_DEPTH) {
        this.fail(e, `expression is nested too deeply (limit ${MAX_EXPRESSION_DEPTH} levels): split it into several variables`);
      }
      return e;
    } finally {
      this.depth--;
    }
  }

  private ternary(): Expr {
    const cond = this.orExpr();
    if (!this.isOp('?')) return cond;
    const q = this.next();
    const then = this.expression();
    this.expectOp(':', '":" of the ?: operator');
    const otherwise = this.expression();
    return { k: 'ternary', cond, then, else: otherwise, ...pos(q) };
  }

  private orExpr(): Expr {
    let left = this.andExpr();
    while (this.at('kw', 'or')) {
      const t = this.next();
      left = { k: 'binary', op: 'or', left, right: this.andExpr(), ...pos(t) };
    }
    return left;
  }

  private andExpr(): Expr {
    let left = this.equality();
    while (this.at('kw', 'and')) {
      const t = this.next();
      left = { k: 'binary', op: 'and', left, right: this.equality(), ...pos(t) };
    }
    return left;
  }

  private equality(): Expr {
    let left = this.comparison();
    while (this.isOp('==') || this.isOp('!=')) {
      const t = this.next();
      left = { k: 'binary', op: t.value, left, right: this.comparison(), ...pos(t) };
    }
    return left;
  }

  private comparison(): Expr {
    let left = this.additive();
    while (this.peek().kind === 'op' && COMPARISON.has(this.peek().value)) {
      const t = this.next();
      left = { k: 'binary', op: t.value, left, right: this.additive(), ...pos(t) };
    }
    return left;
  }

  private additive(): Expr {
    let left = this.multiplicative();
    while (this.isOp('+') || this.isOp('-')) {
      const t = this.next();
      left = { k: 'binary', op: t.value, left, right: this.multiplicative(), ...pos(t) };
    }
    return left;
  }

  private multiplicative(): Expr {
    let left = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const t = this.next();
      left = { k: 'binary', op: t.value, left, right: this.unary(), ...pos(t) };
    }
    return left;
  }

  private unary(): Expr {
    if (this.isOp('-') || this.isOp('+') || this.at('kw', 'not')) {
      const t = this.next();
      if (++this.depth > MAX_EXPRESSION_DEPTH) this.fail(t, `expression is nested too deeply (limit ${MAX_EXPRESSION_DEPTH} levels)`);
      try {
        return { k: 'unary', op: t.value as '-' | '+' | 'not', operand: this.unary(), ...pos(t) };
      } finally {
        this.depth--;
      }
    }
    return this.postfix();
  }

  private postfix(): Expr {
    let e = this.primary();
    for (;;) {
      if (this.isOp('(')) {
        this.next();
        e = { k: 'call', callee: e, args: this.args(), line: e.line, col: e.col };
      } else if (this.isOp('[')) {
        const t = this.next();
        const index = this.expression();
        this.expectOp(']');
        e = { k: 'index', object: e, index, ...pos(t) };
      } else if (this.isOp('.')) {
        this.next();
        const t = this.peek();
        if (t.kind !== 'ident' && t.kind !== 'kw') this.fail(t, `expected a name after ".", found ${this.describe(t)}`);
        this.next();
        if (this.isOp('<') && e.k === 'ident' && COLLECTION_TYPES.has(e.name)) this.fail(e, `${PLURAL[e.name]} are not supported in v1`);
        e = { k: 'member', object: e, name: t.value, line: e.line, col: e.col };
      } else {
        return e;
      }
    }
  }

  private args(): Arg[] {
    const out: Arg[] = [];
    if (this.isOp(')')) {
      this.next();
      return out;
    }
    do {
      const t = this.peek();
      // `type` is a keyword (user-defined types) but also the name of Pine v4's input(type=...) argument.
      if ((t.kind === 'ident' || (t.kind === 'kw' && t.value === 'type')) && this.isOp('=', 1)) {
        this.i += 2;
        out.push({ name: t.value, value: this.expression(), ...pos(t) });
      } else {
        if (out.some((a) => a.name !== undefined)) this.fail(t, 'positional arguments must come before named ones');
        out.push({ value: this.expression(), ...pos(t) });
      }
    } while (this.isOp(',') && this.next());
    this.expectOp(')', '")" or ","');
    return out;
  }

  private primary(): Expr {
    const t = this.peek();
    switch (t.kind) {
      case 'num':
        this.next();
        // `1.0` / `1e3` are float literals although their value is integral (it decides int / int division).
        return { k: 'num', value: t.num!, ...(Number.isInteger(t.num!) && /[.eE]/.test(t.value) ? { float: true } : {}), ...pos(t) };
      case 'str':
        this.next();
        return { k: 'str', value: t.value, ...pos(t) };
      case 'color':
        this.next();
        return { k: 'color', value: t.value, ...pos(t) };
      case 'ident':
        this.next();
        return { k: 'ident', name: t.value, ...pos(t) };
      case 'kw':
        if (t.value === 'true' || t.value === 'false') {
          this.next();
          return { k: 'bool', value: t.value === 'true', ...pos(t) };
        }
        if (t.value === 'if' || t.value === 'switch' || t.value === 'for' || t.value === 'while') {
          this.fail(t, `"${t.value}" used as a value is not supported in v1 (assign inside the block with :=)`);
        }
        break;
      case 'op':
        if (t.value === '(') {
          this.next();
          const e = this.expression();
          this.expectOp(')');
          return e;
        }
        if (t.value === '[') {
          this.next();
          const items: Expr[] = [];
          if (!this.isOp(']')) {
            do items.push(this.expression());
            while (this.isOp(',') && this.next());
          }
          this.expectOp(']');
          return { k: 'tuple', items, ...pos(t) };
        }
        break;
      default:
        break;
    }
    return this.fail(t, `expected a value, found ${this.describe(t)}`);
  }
}

/** Pine source -> statements. Throws PineSyntaxError on the first syntax error. */
export function parse(source: string): Stmt[] {
  return new Parser(lex(source)).program();
}
