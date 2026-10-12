import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { getMeta, setMeta } from './db';

const PASSWORD_KEY = 'password';
/** scrypt cost (N = 2^15, r = 8, p = 1: ~32 MB, ~50-100 ms per check on a small VPS). */
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LEN = 64;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 1024;
/** Login sessions last this long (sliding is not needed for a single user). */
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LEN, SCRYPT, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$N$r$p$salt$hash` (base64). */
export async function hashPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`the password must have at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH) throw new Error(`the password must have at most ${MAX_PASSWORD_LENGTH} characters`);
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || password.length > MAX_PASSWORD_LENGTH) return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }, (err, k) => (err ? reject(err) : resolve(k)));
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export function storedPasswordHash(db: DatabaseSync): string | null {
  return getMeta(db, PASSWORD_KEY);
}

/** Sets the password and logs every existing session out. */
export async function setPassword(db: DatabaseSync, password: string): Promise<void> {
  const hash = await hashPassword(password);
  setMeta(db, PASSWORD_KEY, hash);
  db.prepare('DELETE FROM auth_sessions').run();
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface AuthSession {
  csrf: string;
  expiresAt: number;
}

/** Login sessions: the cookie carries a random token; only its SHA-256 is stored (a DB leak does not log anyone in). */
export class AuthSessions {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = () => Date.now()) {}

  create(): { token: string; csrf: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(24).toString('base64url');
    const created = this.now();
    const expiresAt = created + SESSION_TTL_MS;
    this.db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(created);
    this.db.prepare('INSERT INTO auth_sessions (token_hash, csrf, created_at, expires_at) VALUES (?, ?, ?, ?)').run(sha256(token), csrf, created, expiresAt);
    return { token, csrf, expiresAt };
  }

  get(token: string | undefined): AuthSession | null {
    if (!token || token.length > 200) return null;
    const row = this.db.prepare('SELECT csrf, expires_at FROM auth_sessions WHERE token_hash = ?').get(sha256(token)) as { csrf: string; expires_at: number } | undefined;
    if (!row || row.expires_at <= this.now()) return null;
    return { csrf: row.csrf, expiresAt: row.expires_at };
  }

  delete(token: string | undefined): void {
    if (token) this.db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
  }
}

/** Constant-time string comparison (CSRF tokens). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
