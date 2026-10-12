import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import type { ClientFactory } from '../../src/live/supervisor';
import { setFactoryLoader } from '../../src/sandbox/codeLoader';
import { AuthSessions, MAX_PASSWORD_LENGTH, sameSecret, storedPasswordHash, verifyPassword, type AuthSession } from './auth';
import { LoginBusyError, LoginThrottle } from './loginThrottle';
import { SqliteSessionStore } from './db';
import { clientAddress, HttpError, parseCookies, readJson, requestIsHttps, sendError, sendJson, setSecurityHeaders } from './http';
import { createVmLoader } from './sandbox/vmLoader';
import { SessionLimitError, SessionManager, type SessionManagerOptions, type SessionMessage } from './sessions';
import { serveStatic } from './static';
import { parseNewSession, ValidationError } from './validate';

export const COOKIE = 'qs_session';
export const CSRF_HEADER = 'x-csrf-token';
/** Lets the browser app tell this server from a static host (Vite dev / file server). */
export const SERVER_HEADER = 'X-Quant-Sim-Server';
const LOGIN_BODY_LIMIT = 4 * 1024;
const SESSION_BODY_LIMIT = 2 * 1024 * 1024;
const MAX_STREAMS = 20;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface AppOptions {
  db: DatabaseSync;
  createClient: ClientFactory;
  /** Built frontend to serve; null = API only. */
  distDir: string | null;
  now?: () => number;
  /** Always mark the cookie Secure (HTTPS terminated elsewhere without X-Forwarded-Proto). */
  secureCookies?: boolean;
  /** Extra origins allowed to call the API with credentials (e.g. a Vite dev server). Default: none. */
  allowedOrigins?: readonly string[];
  manager?: Omit<SessionManagerOptions, 'store' | 'createClient' | 'now'>;
  sseHeartbeatMs?: number;
  loginMaxFailures?: number;
  loginWindowMs?: number;
  /** Password verifications allowed to queue before new logins get 503. */
  loginQueue?: number;
}

export interface App {
  readonly server: Server;
  readonly manager: SessionManager;
  listen(port: number, host: string): Promise<number>;
  close(): Promise<void>;
}

interface Stream {
  res: ServerResponse;
  token: string;
  close(): void;
}

export async function createApp(options: AppOptions): Promise<App> {
  // Session definitions are compiled here too (validation): generated code runs in the vm sandbox on this thread as well.
  setFactoryLoader(createVmLoader());
  const now = options.now ?? (() => Date.now());
  const db = options.db;
  const auth = new AuthSessions(db, now);
  const throttle = new LoginThrottle({ maxPerAddress: options.loginMaxFailures ?? 5, windowMs: options.loginWindowMs ?? 15 * 60_000, maxQueue: options.loginQueue ?? 20, now });
  const manager = new SessionManager({ ...options.manager, store: new SqliteSessionStore(db), createClient: options.createClient, now });
  await manager.init();
  const allowed = new Set(options.allowedOrigins ?? []);
  const streams = new Set<Stream>();
  let closing = false;

  const cookie = (req: IncomingMessage, value: string, maxAgeS: number) => {
    const secure = options.secureCookies || requestIsHttps(req) ? '; Secure' : '';
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure}`;
  };

  const sameOrigin = (req: IncomingMessage, origin: string) => {
    const host = req.headers.host;
    return origin === `http://${host}` || origin === `https://${host}`;
  };

  /** CORS for allow-listed origins only; any other cross-origin caller gets no CORS headers (and no mutations). */
  const cors = (req: IncomingMessage, res: ServerResponse): boolean => {
    const origin = req.headers.origin;
    if (typeof origin !== 'string' || sameOrigin(req, origin)) return true;
    if (!allowed.has(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', SERVER_HEADER);
    res.setHeader('Vary', 'Origin');
    return true;
  };

  const currentSession = (req: IncomingMessage): { token: string; session: AuthSession } | null => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = auth.get(token);
    return session && token ? { token, session } : null;
  };

  const login = async (req: IncomingMessage, res: ServerResponse) => {
    const who = clientAddress(req);
    const gate = throttle.begin(who); // counts the attempt now, before the async password check
    if (!gate.ok || !gate.attempt) {
      sendError(res, gate.status ?? 429, gate.message ?? 'too many failed logins; try again later', { retryAfterMs: gate.retryAfterMs }, { 'Retry-After': String(Math.ceil((gate.retryAfterMs ?? 1000) / 1000)) });
      return;
    }
    const attempt = gate.attempt;
    let body: unknown;
    try {
      body = await readJson(req, LOGIN_BODY_LIMIT);
    } catch (err) {
      attempt.refund(); // a malformed body is not a password guess
      throw err;
    }
    const password = (body as { password?: unknown } | null)?.password;
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      attempt.refund();
      throw new HttpError(400, 'password is required');
    }
    const hash = storedPasswordHash(db);
    if (hash === null) {
      attempt.refund();
      throw new HttpError(503, 'no password is set on the server; run `npm run server:set-password` there');
    }
    let ok: boolean;
    try {
      ok = await attempt.verify(() => verifyPassword(password, hash));
    } catch (err) {
      if (err instanceof LoginBusyError) {
        attempt.refund(); // server busy, not a guess
        sendError(res, 503, err.message, { retryAfterMs: 2000 }, { 'Retry-After': '2' });
        return;
      }
      throw err;
    }
    if (!ok) {
      sendError(res, 401, 'wrong password'); // the attempt stays counted against this address
      return;
    }
    attempt.success();
    const created = auth.create();
    sendJson(res, 200, { csrf: created.csrf, expiresAt: created.expiresAt }, { 'Set-Cookie': cookie(req, created.token, Math.floor((created.expiresAt - now()) / 1000)) });
  };

  const openStream = (req: IncomingMessage, res: ServerResponse, url: URL, token: string) => {
    if (streams.size >= MAX_STREAMS) throw new HttpError(503, 'too many open streams');
    const sessionId = url.searchParams.get('session');
    if (sessionId !== null && !ID.test(sessionId)) throw new HttpError(400, 'bad session id');
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const write = (event: string, data: unknown) => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.write('retry: 3000\n\n');
    const offList = manager.onList((sessions) => write('sessions', { sessions }));
    write('sessions', { sessions: manager.list() });
    let offSession: (() => void) | null = null;
    if (sessionId !== null) {
      offSession = manager.watch(sessionId, (message: SessionMessage) => write('session', message));
      if (offSession === null) write('session', { type: 'deleted', id: sessionId } satisfies SessionMessage);
    }
    const beat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, options.sseHeartbeatMs ?? 15_000);
    const stream: Stream = {
      res,
      token,
      close: () => {
        if (!streams.delete(stream)) return;
        clearInterval(beat);
        offList();
        offSession?.();
        if (!res.writableEnded) res.end();
      },
    };
    streams.add(stream);
    req.on('close', () => stream.close());
  };

  const api = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    res.setHeader(SERVER_HEADER, '1');
    const corsOk = cors(req, res);
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      if (!corsOk) throw new HttpError(403, 'origin not allowed');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE');
      res.setHeader('Access-Control-Allow-Headers', `Content-Type, ${CSRF_HEADER}`);
      res.setHeader('Access-Control-Max-Age', '600');
      res.writeHead(204);
      res.end();
      return;
    }
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && !corsOk) throw new HttpError(403, 'cross-origin request refused');
    const path = url.pathname;
    if (path === '/api/login' && method === 'POST') return login(req, res);
    const current = currentSession(req);
    if (!current) throw new HttpError(401, 'not logged in');
    if (mutating) {
      const header = req.headers[CSRF_HEADER];
      if (typeof header !== 'string' || !sameSecret(header, current.session.csrf)) throw new HttpError(403, 'missing or wrong CSRF token');
    }
    if (path === '/api/me' && method === 'GET') return sendJson(res, 200, { csrf: current.session.csrf, expiresAt: current.session.expiresAt });
    if (path === '/api/logout' && method === 'POST') {
      auth.delete(current.token);
      for (const s of [...streams]) if (s.token === current.token) s.close();
      res.writeHead(204, { 'Set-Cookie': cookie(req, '', 0) });
      res.end();
      return;
    }
    if (path === '/api/stream' && method === 'GET') return openStream(req, res, url, current.token);
    if (path === '/api/sessions') {
      if (method === 'GET') return sendJson(res, 200, { sessions: manager.list() });
      if (method === 'POST') {
        const body = await readJson(req, SESSION_BODY_LIMIT);
        const input = parseNewSession(body, now());
        const session = await manager.create(input);
        return sendJson(res, 201, { session });
      }
      throw new HttpError(405, 'method not allowed');
    }
    const m = /^\/api\/sessions\/([^/]+)(\/stop)?$/.exec(path);
    if (m) {
      const id = m[1];
      if (!ID.test(id)) throw new HttpError(400, 'bad session id');
      if (m[2] && method === 'POST') {
        const session = await manager.stop(id);
        return session ? sendJson(res, 200, { session }) : sendError(res, 404, 'no such session');
      }
      if (!m[2] && method === 'GET') {
        const session = manager.get(id);
        return session ? sendJson(res, 200, { session }) : sendError(res, 404, 'no such session');
      }
      if (!m[2] && method === 'DELETE') {
        if (!(await manager.delete(id))) return sendError(res, 404, 'no such session');
        res.writeHead(204);
        res.end();
        return;
      }
      throw new HttpError(405, 'method not allowed');
    }
    throw new HttpError(404, 'no such API route');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    setSecurityHeaders(res);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return sendError(res, 400, 'bad URL');
    }
    try {
      if (closing) throw new HttpError(503, 'server is shutting down');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) await api(req, res, url);
      else if (options.distDir) await serveStatic(req, res, options.distDir, url.pathname);
      else sendError(res, 404, 'not found');
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) return sendError(res, err.status, err.message, err.extra);
      if (err instanceof ValidationError) return sendError(res, 400, err.message, err.blockId ? { blockId: err.blockId } : {});
      if (err instanceof SessionLimitError) return sendError(res, 409, err.message);
      console.error(`request ${req.method} ${url.pathname} failed:`, err instanceof Error ? err.stack : err);
      sendError(res, 500, 'internal error');
    }
  };

  const server = createServer((req, res) => void handle(req, res));
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 50;

  return {
    server,
    manager,
    listen(port, host) {
      return new Promise((resolveListen, reject) => {
        server.on('error', reject);
        server.listen(port, host, () => {
          const addr = server.address();
          resolveListen(typeof addr === 'object' && addr ? addr.port : port);
        });
      });
    },
    async close() {
      closing = true;
      for (const s of [...streams]) s.close();
      await manager.close();
      await new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      });
    },
  };
}
