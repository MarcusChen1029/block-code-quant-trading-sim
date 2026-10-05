/** AST of the supported Pine subset. Every node carries its 1-based source position. */
export interface Pos {
  line: number;
  col: number;
}

export interface Arg extends Pos {
  /** Named argument (`title = "x"`), or undefined for positional. */
  name?: string;
  value: Expr;
}

export type Expr =
  | (Pos & { k: 'num'; value: number })
  | (Pos & { k: 'str'; value: string })
  | (Pos & { k: 'bool'; value: boolean })
  | (Pos & { k: 'color'; value: string })
  | (Pos & { k: 'ident'; name: string })
  | (Pos & { k: 'member'; object: Expr; name: string })
  | (Pos & { k: 'call'; callee: Expr; args: Arg[] })
  | (Pos & { k: 'index'; object: Expr; index: Expr })
  | (Pos & { k: 'unary'; op: '-' | '+' | 'not'; operand: Expr })
  | (Pos & { k: 'binary'; op: string; left: Expr; right: Expr })
  | (Pos & { k: 'ternary'; cond: Expr; then: Expr; else: Expr })
  | (Pos & { k: 'tuple'; items: Expr[] });

export type CallExpr = Extract<Expr, { k: 'call' }>;

export interface Name extends Pos {
  name: string;
}

export type Stmt =
  | (Pos & { k: 'decl'; name: string; mode: 'plain' | 'var'; init: Expr })
  | (Pos & { k: 'tupleDecl'; names: Name[]; init: Expr })
  | (Pos & { k: 'assign'; name: string; op: string; value: Expr })
  | (Pos & { k: 'if'; cond: Expr; then: Stmt[]; else: Stmt[] | null })
  | (Pos & { k: 'for'; name: string; from: Expr; to: Expr; by: Expr | null; body: Stmt[] })
  | (Pos & { k: 'func'; name: string; params: Name[]; body: Stmt[] })
  | (Pos & { k: 'expr'; expr: Expr })
  | (Pos & { k: 'break' })
  | (Pos & { k: 'continue' });

/** `ns.fn` / `fn` for a callee or member chain made only of identifiers, else null. */
export function dottedName(e: Expr): string | null {
  if (e.k === 'ident') return e.name;
  if (e.k === 'member') {
    const base = dottedName(e.object);
    return base === null ? null : `${base}.${e.name}`;
  }
  return null;
}

/** Direct sub-expressions of `e`. */
export function exprChildren(e: Expr): Expr[] {
  switch (e.k) {
    case 'member':
      return [e.object];
    case 'call':
      return [e.callee, ...e.args.map((a) => a.value)];
    case 'index':
      return [e.object, e.index];
    case 'unary':
      return [e.operand];
    case 'binary':
      return [e.left, e.right];
    case 'ternary':
      return [e.cond, e.then, e.else];
    case 'tuple':
      return e.items;
    default:
      return [];
  }
}

/** Nesting depth of an expression tree (1 = a leaf), computed without recursion. */
export function exprDepth(root: Expr): number {
  let max = 0;
  const stack: Array<[Expr, number]> = [[root, 1]];
  while (stack.length > 0) {
    const [e, d] = stack.pop()!;
    if (d > max) max = d;
    for (const c of exprChildren(e)) stack.push([c, d + 1]);
  }
  return max;
}

/** Calls `visit` on every expression in `e` (pre-order). */
export function walkExpr(e: Expr, visit: (e: Expr) => void): void {
  visit(e);
  switch (e.k) {
    case 'member':
      walkExpr(e.object, visit);
      break;
    case 'call':
      walkExpr(e.callee, visit);
      for (const a of e.args) walkExpr(a.value, visit);
      break;
    case 'index':
      walkExpr(e.object, visit);
      walkExpr(e.index, visit);
      break;
    case 'unary':
      walkExpr(e.operand, visit);
      break;
    case 'binary':
      walkExpr(e.left, visit);
      walkExpr(e.right, visit);
      break;
    case 'ternary':
      walkExpr(e.cond, visit);
      walkExpr(e.then, visit);
      walkExpr(e.else, visit);
      break;
    case 'tuple':
      for (const item of e.items) walkExpr(item, visit);
      break;
    default:
      break;
  }
}

/** Expressions directly inside a statement (not nested statements). */
export function stmtExprs(s: Stmt): Expr[] {
  switch (s.k) {
    case 'decl':
    case 'tupleDecl':
      return [s.init];
    case 'assign':
      return [s.value];
    case 'if':
      return [s.cond];
    case 'for':
      return s.by ? [s.from, s.to, s.by] : [s.from, s.to];
    case 'expr':
      return [s.expr];
    default:
      return [];
  }
}

/** Nested statement lists of a statement. */
export function childBlocks(s: Stmt): Stmt[][] {
  switch (s.k) {
    case 'if':
      return s.else ? [s.then, s.else] : [s.then];
    case 'for':
    case 'func':
      return [s.body];
    default:
      return [];
  }
}
