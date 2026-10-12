import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(text);
}

export function sendError(res: ServerResponse, status: number, message: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): void {
  sendJson(res, status, { error: message, ...extra }, headers);
}

/** Reads a JSON body of at most `limit` bytes (413 above it, 415 when not JSON, 400 when malformed). */
export function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return Promise.reject(new HttpError(415, 'expected Content-Type: application/json'));
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) return Promise.reject(new HttpError(413, `request body too large (max ${limit} bytes)`));
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null, value?: unknown) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(value);
    };
    req.on('data', (chunk) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        finish(new HttpError(413, `request body too large (max ${limit} bytes)`));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      if (done) return;
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
      } catch {
        finish(new HttpError(400, 'malformed JSON'));
      }
    });
    req.on('error', (err) => finish(err));
  });
}

export function parseCookies(header: string | string[] | undefined): Record<string, string> {
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  const text = Array.isArray(header) ? header.join(';') : header ?? '';
  for (const part of text.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

const isLoopback = (addr: string | undefined) => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/** True when the request came from a reverse proxy on this machine (Caddy) that set X-Forwarded-* headers. */
export function fromLocalProxy(req: IncomingMessage): boolean {
  return isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-for'] !== undefined;
}

/**
 * The client's address for rate limiting: the socket peer, or — only when the peer is a local reverse proxy — the
 * LAST X-Forwarded-For entry (the one the proxy appended; earlier entries are client-controlled).
 */
export function clientAddress(req: IncomingMessage): string {
  if (fromLocalProxy(req)) {
    const xff = String(req.headers['x-forwarded-for']);
    const last = xff.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** HTTPS as seen by the browser: X-Forwarded-Proto is trusted from a local proxy only. */
export function requestIsHttps(req: IncomingMessage): boolean {
  if (req.socket.encrypted) return true;
  return isLoopback(req.socket.remoteAddress) && String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https';
}

export function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
}
