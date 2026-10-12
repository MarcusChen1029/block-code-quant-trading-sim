import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app';
import { storedPasswordHash } from './auth';
import { loadConfig } from './config';
import { openDatabase } from './db';
import { clientFactory, threadWorker } from './worker/factories';

// Built layout: <app>/server/dist/main.js next to worker.js; the frontend in <app>/dist.
const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');
const workerScript = join(here, 'worker.js');

const log = (message: string) => process.stdout.write(`${new Date().toISOString()} ${message}\n`);

async function main(): Promise<void> {
  const config = loadConfig(process.env, appDir);
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  if (storedPasswordHash(db) === null) log('WARNING: no password is set; nobody can log in. Run `npm run server:set-password`.');
  if (!existsSync(join(config.distDir, 'index.html'))) log(`WARNING: no built frontend in ${config.distDir} (run \`npm run build\`); only the API is served.`);
  if (!['127.0.0.1', '::1', 'localhost'].includes(config.host)) log(`WARNING: listening on ${config.host}, not loopback: put HTTPS (Caddy) in front of it.`);

  const app = await createApp({
    db,
    distDir: existsSync(config.distDir) ? config.distDir : null,
    createClient: clientFactory(() => threadWorker(workerScript, { dbPath: config.dbPath, cacheMaxBars: config.cacheMaxBars })),
    secureCookies: config.secureCookies,
    allowedOrigins: config.allowedOrigins,
    manager: { maxRunning: config.maxRunning },
  });
  const port = await app.listen(config.port, config.host);
  const running = app.manager.list().filter((s) => s.status === 'running').length;
  log(`quant-sim server on http://${config.host}:${port} (data: ${config.dbPath}; ${running} running session(s) resumed)`);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal}: stopping workers and flushing the database`);
    const force = setTimeout(() => {
      log('shutdown took too long; exiting');
      process.exit(1);
    }, 10_000);
    void app.close().then(() => {
      db.close();
      clearTimeout(force);
      log('stopped');
      process.exit(0);
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  process.stderr.write(`quant-sim server failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
