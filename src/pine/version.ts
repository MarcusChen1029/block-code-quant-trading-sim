import type { PineDiagnostic } from './diagnostics';

/** Pine language versions the compiler accepts. */
export type PineVersion = 4 | 5 | 6;

export const SUPPORTED_VERSIONS: readonly PineVersion[] = [4, 5, 6];

export type VersionResult =
  | { ok: true; version: PineVersion; warning?: PineDiagnostic }
  | { ok: false; error: PineDiagnostic };

const VERSION_LINE = /^\s*\/\/\s*@version\s*=\s*(\S*)/;

/**
 * The script's version from its first `//@version=N` line. Missing -> v5 with a warning (the long-standing
 * rule); 1..3, above 6, or not a whole number -> an error on that line.
 */
export function detectVersion(source: string): VersionResult {
  const lines = source.split(/\r\n|\r|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = VERSION_LINE.exec(lines[i]);
    if (!m) continue;
    const line = i + 1;
    const text = m[1].replace(/\/\/.*$/, '');
    if (!/^\d{1,3}$/.test(text)) {
      return { ok: false, error: { line, col: 1, message: `malformed version line "//@version=${text.slice(0, 20)}": write //@version=4, //@version=5 or //@version=6` } };
    }
    const n = Number(text);
    if (n === 4 || n === 5 || n === 6) return { ok: true, version: n };
    const why = n < 4 ? `Pine v${n} is too old` : `Pine v${n} is not supported yet`;
    return { ok: false, error: { line, col: 1, message: `${why} (found //@version=${n}): only versions 4, 5 and 6 are supported` } };
  }
  return { ok: true, version: 5, warning: { line: 1, col: 1, message: 'no //@version=5 line: compiled as Pine v5' } };
}
