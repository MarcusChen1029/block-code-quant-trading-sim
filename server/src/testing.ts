import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BinanceFuturesAdapter } from '../../src/data/binance';
import { fakeBinance, Socket, type FakeBinanceState } from '../../src/live/binanceFake';
import { setPassword } from './auth';
import { createApp, COOKIE, type App, type AppOptions } from './app';
import { openDatabase } from './db';
import { clientFactory, inThreadWorker } from './worker/factories';

export const PASSWORD = 'correct horse battery';

/** A server on a random port over a temp SQLite file, with fake Binance (shared clock `market.serverNow`). */
export interface Harness {
  app: App;
  base: string;
  dbPath: string;
  market: FakeBinanceState;
  sockets: Socket[];
  close(): Promise<void>;
}

export function tempDir(): { dir: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), 'qs-server-'));
  return { dir, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function startHarness(market: FakeBinanceState, dbPath: string, extra: Partial<AppOptions> = {}): Promise<Harness> {
  const db = openDatabase(dbPath);
  const sockets: Socket[] = [];
  const now = () => market.serverNow;
  const adapter = () => new BinanceFuturesAdapter({
    fetchFn: fakeBinance(market).fetchFn,
    now,
    wsFactory: () => {
      const s = new Socket();
      sockets.push(s);
      return s;
    },
    staleAfterMs: 1e12,
  });
  const createClient = clientFactory(() => inThreadWorker({ dbPath }, adapter, { now, yieldFn: () => new Promise((r) => setTimeout(r, 0)) }));
  const app = await createApp({ db, createClient, distDir: null, now, ...extra });
  const port = await app.listen(0, '127.0.0.1');
  return {
    app, base: `http://127.0.0.1:${port}`, dbPath, market, sockets,
    async close() {
      await app.close();
      db.close();
    },
  };
}

export async function ensurePassword(dbPath: string): Promise<void> {
  const db = openDatabase(dbPath);
  await setPassword(db, PASSWORD);
  db.close();
}

export interface Client {
  cookie: string;
  csrf: string;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any; headers: Headers }>;
}

export async function login(base: string, password = PASSWORD): Promise<Client> {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (!cookie.startsWith(`${COOKIE}=`)) throw new Error('no session cookie');
  const { csrf } = (await res.json()) as { csrf: string };
  return {
    cookie,
    csrf,
    async call(method, path, body, headers = {}) {
      const r = await fetch(`${base}${path}`, {
        method,
        headers: { Cookie: cookie, 'x-csrf-token': csrf, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await r.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: r.status, json, headers: r.headers };
    },
  };
}

export interface SseEvent { event: string; data: any }

/** Reads an SSE stream into `events` until close(). */
export function openSse(url: string, cookie: string): { events: SseEvent[]; status: Promise<number>; close(): void } {
  const events: SseEvent[] = [];
  const controller = new AbortController();
  const status = fetch(url, { headers: { Cookie: cookie }, signal: controller.signal }).then(async (res) => {
    const reader = res.body?.getReader();
    if (!reader) return res.status;
    void (async () => {
      const decoder = new TextDecoder();
      let buf = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let cut: number;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            let event = 'message';
            let data = '';
            for (const line of block.split('\n')) {
              if (line.startsWith('event: ')) event = line.slice(7);
              else if (line.startsWith('data: ')) data += line.slice(6);
            }
            if (data) events.push({ event, data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted
      }
    })();
    return res.status;
  }).catch(() => 0);
  return { events, status, close: () => controller.abort() };
}

export async function waitFor<T>(check: () => T | undefined | null | false, timeoutMs = 10_000, what = 'condition'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
