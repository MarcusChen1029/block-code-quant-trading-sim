import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_PASSWORD_LENGTH, setPassword } from './auth';
import { loadConfig } from './config';
import { openDatabase } from './db';

/**
 * `npm run server:set-password`: asks for the password twice (hidden) on a terminal, or reads ONE line from stdin
 * when piped (`printf '%s\n' "$PW" | npm run server:set-password`). Stores only its scrypt hash and logs every
 * existing login out. The password itself is never printed or logged.
 */
const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, '..', '..');

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(prompt);
    stdin.setRawMode?.(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    let value = '';
    const onData = (chunk: Buffer | string) => {
      for (const ch of String(chunk)) {
        if (ch === '\r' || ch === '\n') {
          stdin.off('data', onData);
          stdin.setRawMode?.(false);
          stdin.pause();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode?.(false);
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function readLine(): Promise<string> {
  return new Promise((resolve) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      text += String(chunk);
    });
    process.stdin.on('end', () => resolve(text.split(/\r?\n/)[0] ?? ''));
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, appDir);
  let password: string;
  if (process.stdin.isTTY) {
    password = await readHidden(`New password (at least ${MIN_PASSWORD_LENGTH} characters): `);
    const again = await readHidden('Repeat it: ');
    if (again !== password) throw new Error('the two passwords differ; nothing was changed');
  } else {
    password = await readLine();
  }
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const db = openDatabase(config.dbPath);
  try {
    await setPassword(db, password);
  } finally {
    db.close();
  }
  process.stdout.write(`Password set in ${config.dbPath}. Existing logins were signed out.\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`set-password failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
