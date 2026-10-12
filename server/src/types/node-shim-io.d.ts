/* Minimal Node 24 typings, part 2: http, fs, path, os, url, readline. See node-shim.d.ts. */

declare module 'node:http' {
  export interface IncomingHttpHeaders { [name: string]: string | string[] | undefined }
  export class IncomingMessage implements NodeReadable {
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    socket: { remoteAddress?: string; encrypted?: boolean; destroy(): void };
    on(event: 'data', listener: (chunk: Buffer | string) => void): this;
    on(event: 'end' | 'close', listener: () => void): this;
    on(event: 'error', listener: (err: Error) => void): this;
    off(event: string, listener: (...args: never[]) => void): this;
    pipe<T>(dest: T): T;
    destroy(err?: Error): void;
  }
  export class ServerResponse {
    statusCode: number;
    headersSent: boolean;
    writableEnded: boolean;
    setHeader(name: string, value: string | number | readonly string[]): this;
    getHeader(name: string): string | number | string[] | undefined;
    removeHeader(name: string): void;
    writeHead(status: number, headers?: Record<string, string | number | string[]>): this;
    write(chunk: string | Uint8Array): boolean;
    end(chunk?: string | Uint8Array): this;
    flushHeaders(): void;
    on(event: 'close' | 'finish', listener: () => void): this;
  }
  export interface Server {
    listen(port: number, host: string, callback?: () => void): this;
    close(callback?: (err?: Error) => void): this;
    closeAllConnections(): void;
    address(): { port: number; address: string } | string | null;
    on(event: 'error', listener: (err: Error & { code?: string }) => void): this;
    headersTimeout: number;
    requestTimeout: number;
    keepAliveTimeout: number;
    maxHeadersCount: number | null;
  }
  export function createServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Server;
  export function request(url: string | URL, options: { method?: string; headers?: Record<string, string> }, callback?: (res: IncomingMessage & { statusCode?: number }) => void): { write(s: string): void; end(): void; on(event: 'error', l: (e: Error) => void): void; destroy(): void };
}

declare module 'node:fs' {
  export interface Stats { isFile(): boolean; isDirectory(): boolean; size: number; mtimeMs: number }
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string): void;
  export function statSync(path: string): Stats;
  export function realpathSync(path: string): string;
  export function copyFileSync(src: string, dest: string): void;
}

declare module 'node:fs/promises' {
  import type { Stats } from 'node:fs';
  export function stat(path: string): Promise<Stats>;
  export function readFile(path: string): Promise<Buffer>;
  export function realpath(path: string): Promise<string>;
}

declare module 'node:path' {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function extname(p: string): string;
  export function relative(from: string, to: string): string;
  export function isAbsolute(p: string): boolean;
  export function normalize(p: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

declare module 'node:readline' {
  export interface Interface {
    question(query: string, cb: (answer: string) => void): void;
    close(): void;
    on(event: 'line', listener: (line: string) => void): this;
    on(event: 'close', listener: () => void): this;
  }
  export function createInterface(options: { input: unknown; output?: unknown; terminal?: boolean }): Interface;
}
