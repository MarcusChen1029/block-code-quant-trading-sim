import type { PineVersion } from './version';

/**
 * What differs between Pine versions after parsing. v4 scripts are normalised to the v5 AST first (v4.ts), so
 * only behaviour that the AST cannot express lives here. All tables are Maps/Sets: Object.prototype keys such
 * as `constructor` never resolve.
 */
export interface Dialect {
  version: PineVersion;
  /** v6: `and` / `or` evaluate their right operand only when needed. v4/v5 evaluate both. */
  lazyLogic: boolean;
  /** v6: a for loop re-evaluates its `to` bound before every iteration. v4/v5 evaluate it once. */
  dynamicForBound: boolean;
  /** v6: bool has no na; a bool variable's history before its first bar is false. */
  boolNeverNa: boolean;
  /** v4: `iff(cond, a, b)` exists (both branches evaluated). */
  iff: boolean;
}

export function dialectFor(version: PineVersion): Dialect {
  return { version, lazyLogic: version === 6, dynamicForBound: version === 6, boolNeverNa: version === 6, iff: version === 4 };
}

/** v4 bare function names that became ta.* in v5 (the subset this compiler implements). */
export const V4_TA_FUNCTIONS: ReadonlySet<string> = new Set([
  'sma', 'ema', 'rma', 'wma', 'rsi', 'stdev', 'change', 'highest', 'lowest', 'macd', 'bb', 'atr', 'stoch',
  'crossover', 'crossunder', 'tr',
]);

/** v4 bare function names that became math.* in v5 (the subset this compiler implements). */
export const V4_MATH_FUNCTIONS: ReadonlySet<string> = new Set([
  'abs', 'sqrt', 'log', 'log10', 'exp', 'floor', 'ceil', 'sign', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'todegrees', 'toradians', 'pow', 'round', 'max', 'min', 'avg',
]);

/** v4 input `type=` constants this compiler supports, and the v5 input function each becomes. */
export const V4_INPUT_TYPES = new Map<string, 'int' | 'float' | 'bool' | 'source'>([
  ['integer', 'int'], ['float', 'float'], ['bool', 'bool'], ['source', 'source'],
]);

/** Other v4 input type constants (valid Pine v4, not supported here). */
export const V4_OTHER_INPUT_TYPES: ReadonlySet<string> = new Set(['string', 'symbol', 'resolution', 'session', 'color', 'time', 'price']);

/** v4 functions outside the subset, with the reason shown to the user. */
export const V4_UNSUPPORTED = new Map<string, string>([
  ['security', 'security() (other symbols / timeframes) is not supported in v1'],
  ...['heikinashi', 'renko', 'kagi', 'linebreak', 'pointfigure', 'tickerid'].map(
    (n): [string, string] => [n, `${n}() (other chart types / tickers) is not supported in v1`]),
  ...['financial', 'quandl', 'splits', 'dividends', 'earnings'].map(
    (n): [string, string] => [n, `${n}() (external data) is not supported in v1`]),
]);

/**
 * In a v5/v6 script, a friendlier message for a v4 spelling that would otherwise be "unknown function" /
 * "not declared". `called` = used as a function. Undefined when `name` is not a v4 spelling.
 */
export function v4SpellingHint(name: string, called: boolean): string | undefined {
  if (called) {
    if (name === 'study') return 'study() is Pine v4 syntax: in Pine v5+ use indicator()';
    if (name === 'iff') return 'iff() was removed in Pine v5: use the ternary operator, cond ? a : b';
    if (name === 'security') return 'security() is Pine v4 syntax (request.security in v5+), and other symbols / timeframes are not supported in v1';
    if (V4_TA_FUNCTIONS.has(name)) return `${name}() is Pine v4 syntax: in Pine v5+ use ta.${name}()`;
    if (V4_MATH_FUNCTIONS.has(name)) return `${name}() is Pine v4 syntax: in Pine v5+ use math.${name}()`;
    return undefined;
  }
  if (name === 'tr') return '"tr" is Pine v4 syntax: in Pine v5+ use ta.tr';
  if (name.startsWith('input.')) {
    const type = V4_INPUT_TYPES.get(name.slice('input.'.length));
    if (type) return `${name} is Pine v4 syntax (input type=...): in Pine v5+ use input.${type}()`;
  }
  return undefined;
}
