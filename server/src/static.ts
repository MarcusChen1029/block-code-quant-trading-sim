import { readFile, realpath, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.cur': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serves the built frontend (`dist/`): GET/HEAD only, files strictly inside the root (no traversal, no dotfiles,
 * symlinks resolved and re-checked), `/` -> index.html. Hashed assets are cached for a year, the rest revalidated.
 */
export async function serveStatic(req: IncomingMessage, res: ServerResponse, root: string, pathname: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }
  const notFound = () => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('not found');
  };
  let rel: string;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return notFound();
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('\0') || rel.split(/[\\/]/).some((part) => part === '..' || part.startsWith('.'))) return notFound();
  const base = resolve(root);
  const file = resolve(join(base, rel));
  if (!file.startsWith(base + sep)) return notFound();
  let real: string;
  try {
    real = await realpath(file);
    const realBase = await realpath(base);
    if (!real.startsWith(realBase + sep)) return notFound();
    const info = await stat(real);
    if (!info.isFile()) return notFound();
  } catch {
    return notFound();
  }
  const body = await readFile(real);
  const immutable = rel.startsWith('/assets/');
  res.writeHead(200, {
    'Content-Type': TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}
