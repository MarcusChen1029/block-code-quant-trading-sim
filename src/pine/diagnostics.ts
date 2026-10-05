/** A compile error or warning, 1-based line and column in the Pine source. */
export interface PineDiagnostic {
  line: number;
  col: number;
  message: string;
}

/** Thrown by the lexer/parser on the first syntax error (the compiler turns it into a diagnostic). */
export class PineSyntaxError extends Error {
  constructor(readonly line: number, readonly col: number, message: string) {
    super(message);
    this.name = 'PineSyntaxError';
  }

  get diagnostic(): PineDiagnostic {
    return { line: this.line, col: this.col, message: this.message };
  }
}

/** Thrown while a compiled script runs (bad length, loop budget, ...). Carries the source position. */
export class PineRuntimeError extends Error {
  constructor(readonly line: number, readonly col: number, message: string) {
    super(message);
    this.name = 'PineRuntimeError';
  }
}

/** Sorts diagnostics by position (stable for equal positions). */
export function byPosition(a: PineDiagnostic, b: PineDiagnostic): number {
  return a.line - b.line || a.col - b.col;
}
