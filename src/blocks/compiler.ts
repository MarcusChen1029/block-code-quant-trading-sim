import type { Strategy, StrategyContext } from '../engine/strategy';
import { generateProgram, type CompileIssue, type GeneratedProgram } from './generator';
import { BlockRuntime, DEFAULT_LIMITS, type RuntimeLimits } from './runtime';

/**
 * Globals shadowed (as `undefined` parameters) inside generated code. The code comes only from fixed templates,
 * so it never names these; this is defence in depth so even a generator bug cannot reach the page or network.
 */
const SHADOWED_GLOBALS = [
  'self', 'globalThis', 'window', 'document', 'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'postMessage',
  'importScripts', 'Worker', 'SharedWorker', 'indexedDB', 'localStorage', 'sessionStorage', 'caches', 'navigator',
  'location', 'setTimeout', 'setInterval', 'queueMicrotask', 'Function', 'BroadcastChannel',
];

/** Compile errors as one throwable (worker path). `blockId` is the first error's block. */
export class CompileError extends Error {
  constructor(readonly errors: CompileIssue[]) {
    super(errors.length === 1 ? errors[0].message : `${errors[0].message} (and ${errors.length - 1} more problems)`);
    this.name = 'CompileError';
  }

  get blockId(): string | undefined {
    return this.errors.find((e) => e.blockId)?.blockId;
  }
}

export type CompileResult =
  | { ok: true; program: GeneratedProgram; warnings: CompileIssue[] }
  | { ok: false; errors: CompileIssue[]; warnings: CompileIssue[] };

/** Workspace JSON -> program, or the list of problems (never throws). */
export function compileBlocks(workspace: unknown): CompileResult {
  const result = generateProgram(workspace);
  return result.ok ? { ok: true, program: result.program, warnings: result.program.warnings } : result;
}

interface CompiledProgram {
  init(ctx: StrategyContext): void;
  onBar(ctx: StrategyContext): void;
}

/**
 * Instantiates a fresh, stateful Strategy from generated code (call once per run). Runtime errors are rethrown
 * as StrategyError carrying the id of the block that was executing.
 */
export function strategyFromProgram(program: GeneratedProgram, limits: RuntimeLimits = DEFAULT_LIMITS): Strategy {
  const factory = new Function('rt', ...SHADOWED_GLOBALS, program.source) as (rt: BlockRuntime) => CompiledProgram;
  const rt = new BlockRuntime(program.blockIds, program.maxOffset, limits);
  const compiled = factory(rt);
  return {
    init(ctx) {
      try {
        compiled.init(ctx);
      } catch (err) {
        throw rt.toError(err);
      }
    },
    onBar(ctx) {
      try {
        compiled.onBar(ctx);
      } catch (err) {
        throw rt.toError(err);
      }
    },
  };
}

/** Workspace JSON -> Strategy. Throws CompileError when the workspace has problems. */
export function createBlockStrategy(workspace: unknown, limits: RuntimeLimits = DEFAULT_LIMITS): Strategy {
  const result = compileBlocks(workspace);
  if (!result.ok) throw new CompileError(result.errors);
  return strategyFromProgram(result.program, limits);
}
