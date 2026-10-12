/*
 * Minimal Node 24 typings for the server (the repo has no @types/node and adds no dependencies). Only the APIs
 * the server code uses are declared; extend when using more.
 */

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: ArrayLike<number> | ArrayBuffer): Buffer;
  static concat(list: readonly Uint8Array[], total?: number): Buffer;
  static byteLength(s: string, encoding?: string): number;
  toString(encoding?: string): string;
}

declare var process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode: number | undefined;
  pid: number;
  /** Node permission model (undefined when node was started without --permission). */
  permission?: { has(scope: string, reference?: string): boolean };
  platform: string;
  version: string;
  cwd(): string;
  exit(code?: number): never;
  on(event: 'SIGTERM' | 'SIGINT' | 'SIGHUP', listener: () => void): void;
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): void;
  stdin: NodeReadable & { isTTY?: boolean; setRawMode?(raw: boolean): void; setEncoding(enc: string): void; pause(): void; resume(): void };
  stdout: { write(s: string): boolean; isTTY?: boolean };
  stderr: { write(s: string): boolean };
};

declare function setImmediate(fn: () => void): unknown;

interface NodeReadable {
  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end' | 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  off(event: string, listener: (...args: never[]) => void): this;
  pipe<T>(dest: T): T;
  destroy(err?: Error): void;
}

interface ImportMeta {
  dirname?: string;
  filename?: string;
}

declare module 'node:vm' {
  export interface Context {}
  export const constants: { DONT_CONTEXTIFY: symbol };
  export function createContext(contextObject?: object | symbol, options?: { name?: string; codeGeneration?: { strings?: boolean; wasm?: boolean } }): Context;
  export class Script {
    constructor(code: string, options?: { filename?: string });
    runInContext(context: Context): unknown;
  }
  export function compileFunction(code: string, params?: string[], options?: { parsingContext?: Context; filename?: string }): (...args: unknown[]) => unknown;
  const vm: { constants: typeof constants; createContext: typeof createContext; Script: typeof Script; compileFunction: typeof compileFunction };
  export default vm;
}

declare module 'node:sqlite' {
  export interface StatementSync {
    run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  }
  export class DatabaseSync {
    constructor(path: string, options?: { open?: boolean; readOnly?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}

declare module 'node:crypto' {
  export function randomBytes(size: number): Buffer;
  export function createHash(alg: string): { update(data: string | Uint8Array): { digest(enc: 'hex' | 'base64'): string } };
  export function scrypt(
    password: string | Uint8Array, salt: string | Uint8Array, keylen: number,
    options: { N?: number; r?: number; p?: number; maxmem?: number },
    callback: (err: Error | null, key: Buffer) => void,
  ): void;
  export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;
  export function randomUUID(): string;
}

declare module 'node:worker_threads' {
  export interface ResourceLimits { maxOldGenerationSizeMb?: number; maxYoungGenerationSizeMb?: number; codeRangeSizeMb?: number; stackSizeMb?: number }
  export class Worker {
    constructor(filename: string | URL, options?: { workerData?: unknown; resourceLimits?: ResourceLimits; stdout?: boolean; stderr?: boolean; execArgv?: string[] });
    postMessage(value: unknown): void;
    terminate(): Promise<number>;
    on(event: 'message', listener: (value: never) => void): this;
    on(event: 'messageerror', listener: (err: Error) => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    on(event: 'exit', listener: (code: number) => void): this;
    on(event: 'online', listener: () => void): this;
  }
  export const parentPort: { postMessage(value: unknown): void; on(event: 'message', listener: (value: never) => void): void } | null;
  export const workerData: unknown;
  export const isMainThread: boolean;
}
