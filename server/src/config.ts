import { isAbsolute, join, resolve } from 'node:path';

export interface ServerConfig {
  host: string;
  port: number;
  /** Directory of the SQLite file. */
  dataDir: string;
  dbPath: string;
  /** Built frontend served at `/`. */
  distDir: string;
  secureCookies: boolean;
  allowedOrigins: string[];
  maxRunning: number;
  cacheMaxBars: number | undefined;
}

function int(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${value}"`);
  return n;
}

/**
 * Environment -> configuration. `appDir` is the app's root (the folder holding dist/ and server/dist/); relative
 * paths in the environment are taken from the working directory.
 *   HOST (127.0.0.1)  PORT (8787)  QS_DATA_DIR (<appDir>/data)  QS_DIST_DIR (<appDir>/dist)
 *   QS_SECURE_COOKIES=1  QS_ALLOWED_ORIGINS=http://localhost:5177,...  QS_MAX_RUNNING (5)  QS_CACHE_MAX_BARS
 */
export function loadConfig(env: Record<string, string | undefined>, appDir: string): ServerConfig {
  const path = (value: string | undefined, fallback: string) => (value ? (isAbsolute(value) ? value : resolve(value)) : fallback);
  const dataDir = path(env.QS_DATA_DIR, join(appDir, 'data'));
  const origins = (env.QS_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) if (!/^https?:\/\/[^/\s]+$/.test(o)) throw new Error(`QS_ALLOWED_ORIGINS: "${o}" is not an origin like http://localhost:5177`);
  return {
    host: env.HOST?.trim() || '127.0.0.1',
    port: int(env.PORT, 8787, 1, 65535, 'PORT'),
    dataDir,
    dbPath: join(dataDir, 'quant-sim.sqlite'),
    distDir: path(env.QS_DIST_DIR, join(appDir, 'dist')),
    secureCookies: env.QS_SECURE_COOKIES === '1',
    allowedOrigins: origins,
    maxRunning: int(env.QS_MAX_RUNNING, 5, 1, 50, 'QS_MAX_RUNNING'),
    cacheMaxBars: env.QS_CACHE_MAX_BARS ? int(env.QS_CACHE_MAX_BARS, 300_000, 1000, 50_000_000, 'QS_CACHE_MAX_BARS') : undefined,
  };
}
