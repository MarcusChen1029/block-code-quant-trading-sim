import { PineSyntaxError } from './diagnostics';

export type TokenKind = 'num' | 'str' | 'color' | 'ident' | 'kw' | 'op' | 'newline' | 'indent' | 'dedent' | 'eof';

export interface Token {
  kind: TokenKind;
  /** Source text (identifier, keyword, operator), the decoded string, or the color literal. */
  value: string;
  /** Parsed value of a 'num' token. */
  num?: number;
  line: number;
  col: number;
}

export const KEYWORDS: ReadonlySet<string> = new Set([
  'and', 'or', 'not', 'if', 'else', 'for', 'to', 'by', 'var', 'varip', 'true', 'false', 'while', 'switch',
  'import', 'export', 'type', 'method', 'in', 'break', 'continue',
]);

/** Longest first so that ':=' wins over ':'. */
const OPERATORS = [
  ':=', '=>', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=',
  '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', '(', ')', '[', ']', ',', '.',
];
const OPENERS: Record<string, string> = { '(': ')', '[': ']' };
Object.setPrototypeOf(OPENERS, null);

const INDENT_UNIT = 4;
const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

/** `//@version=N` from the source, or null when absent. */
export function pineVersion(source: string): { version: number; line: number } | null {
  const lines = source.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*\/\/\s*@version\s*=\s*(\d+)/.exec(lines[i]);
    if (m) return { version: Number(m[1]), line: i + 1 };
  }
  return null;
}

/**
 * Pine source -> tokens with Python-style NEWLINE / INDENT / DEDENT. Blocks are indented by multiples of 4
 * spaces (a tab counts as 4). A line indented by a non-multiple of 4 continues the previous line (Pine's
 * line-wrapping rule), and newlines inside ( ) or [ ] are ignored. Throws PineSyntaxError.
 */
export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  const lines = source.split(/\r\n|\r|\n/);
  const indents = [0];
  const open: Token[] = [];
  let pendingNewline: { line: number; col: number } | null = null;

  const push = (kind: TokenKind, value: string, line: number, col: number, num?: number) => {
    tokens.push(num === undefined ? { kind, value, line, col } : { kind, value, line, col, num });
  };

  for (let li = 0; li < lines.length; li++) {
    const text = lines[li];
    const line = li + 1;
    let i = 0;
    if (open.length === 0) {
      let width = 0;
      while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
        width += text[i] === '\t' ? INDENT_UNIT : 1;
        i++;
      }
      const rest = text.slice(i);
      if (rest.trim() === '' || rest.startsWith('//')) continue;
      const top = indents[indents.length - 1];
      const continuation = pendingNewline !== null && width > top && width % INDENT_UNIT !== 0;
      if (!continuation) {
        if (pendingNewline) {
          push('newline', '', pendingNewline.line, pendingNewline.col);
          pendingNewline = null;
        }
        if (width % INDENT_UNIT !== 0) {
          throw new PineSyntaxError(line, 1, `indentation must be a multiple of ${INDENT_UNIT} spaces (or tabs)`);
        }
        if (width > top) {
          indents.push(width);
          push('indent', '', line, i + 1);
        } else {
          while (width < indents[indents.length - 1]) {
            indents.pop();
            push('dedent', '', line, i + 1);
          }
          if (width !== indents[indents.length - 1]) throw new PineSyntaxError(line, 1, 'this line\'s indentation does not match any outer block');
        }
      } else {
        pendingNewline = null;
      }
    }

    let sawToken = false;
    while (i < text.length) {
      const ch = text[i];
      const col = i + 1;
      if (ch === ' ' || ch === '\t') {
        i++;
        continue;
      }
      if (ch === '/' && text[i + 1] === '/') break;
      sawToken = true;
      if (isDigit(ch) || (ch === '.' && isDigit(text[i + 1] ?? ''))) {
        const m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(i))!;
        const value = Number(m[0]);
        if (!Number.isFinite(value)) throw new PineSyntaxError(line, col, `number ${m[0]} is too large`);
        if (isIdentStart(text[i + m[0].length] ?? '')) throw new PineSyntaxError(line, col, `invalid number "${m[0]}${text[i + m[0].length]}"`);
        push('num', m[0], line, col, value);
        i += m[0].length;
        continue;
      }
      if (isIdentStart(ch)) {
        let j = i + 1;
        while (j < text.length && isIdentPart(text[j])) j++;
        const word = text.slice(i, j);
        push(KEYWORDS.has(word) ? 'kw' : 'ident', word, line, col);
        i = j;
        continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1;
        let value = '';
        for (;;) {
          if (j >= text.length) throw new PineSyntaxError(line, col, 'unterminated string (strings must end on the same line)');
          const c = text[j];
          if (c === ch) break;
          if (c === '\\') {
            const e = text[j + 1];
            if (e === undefined) throw new PineSyntaxError(line, col, 'unterminated string (strings must end on the same line)');
            value += e === 'n' ? '\n' : e === 't' ? '\t' : e;
            j += 2;
          } else {
            value += c;
            j++;
          }
        }
        push('str', value, line, col);
        i = j + 1;
        continue;
      }
      if (ch === '#') {
        const m = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9A-Za-z_])/.exec(text.slice(i));
        if (!m) throw new PineSyntaxError(line, col, 'invalid color literal (expected #RRGGBB or #RRGGBBAA)');
        push('color', m[0], line, col);
        i += m[0].length;
        continue;
      }
      const op = OPERATORS.find((o) => text.startsWith(o, i));
      if (!op) {
        const shown = ch === '`' ? 'backtick' : JSON.stringify(ch);
        throw new PineSyntaxError(line, col, `unexpected character ${shown}`);
      }
      const tok: Token = { kind: 'op', value: op, line, col };
      if (OPENERS[op]) open.push(tok);
      else if (op === ')' || op === ']') {
        const last = open.pop();
        if (!last || OPENERS[last.value] !== op) throw new PineSyntaxError(line, col, `unmatched "${op}"`);
      }
      tokens.push(tok);
      i += op.length;
    }
    if (open.length === 0 && (sawToken || pendingNewline === null) && tokens.length > 0) {
      const last = tokens[tokens.length - 1];
      if (last.kind !== 'newline' && last.kind !== 'indent' && last.kind !== 'dedent') pendingNewline = { line, col: text.length + 1 };
    }
  }
  if (open.length > 0) {
    const first = open[open.length - 1];
    throw new PineSyntaxError(first.line, first.col, `"${first.value}" is never closed`);
  }
  const end = { line: lines.length, col: (lines[lines.length - 1] ?? '').length + 1 };
  if (pendingNewline) push('newline', '', pendingNewline.line, pendingNewline.col);
  while (indents.length > 1) {
    indents.pop();
    push('dedent', '', end.line, end.col);
  }
  push('eof', '', end.line, end.col);
  return tokens;
}
