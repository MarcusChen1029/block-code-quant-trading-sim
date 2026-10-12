import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(process.cwd());
const guide = readFileSync(join(root, 'docs', 'server.md'), 'utf8');
const caddy = readFileSync(join(root, 'deploy', 'Caddyfile.example'), 'utf8');

describe('deploy guide guards', () => {
  it('never copies the live WAL database with cp (backups use the SQLite online backup)', () => {
    const live = guide.split('\n').filter((l) => /\bcp\b/.test(l) && l.includes('/var/lib/quant-sim/quant-sim.sqlite') && !l.trim().startsWith('#'));
    expect(live).toEqual([]);
    expect(guide).toContain('s.backup(new s.DatabaseSync(');
  });

  it('section 3 works for Lightsail\'s ubuntu user: every privileged command uses sudo', () => {
    const s3 = guide.slice(guide.indexOf('## 3.'), guide.indexOf('## 4.'));
    const block = s3.slice(s3.indexOf('```bash'), s3.indexOf('```', s3.indexOf('```bash') + 7));
    const cmds = block.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('```') && !l.startsWith('ssh '));
    for (const c of cmds) expect(c.startsWith('sudo '), c).toBe(true);
    expect(s3).toContain('ubuntu');
  });

  it('the Caddyfile has no active encode directive (it could buffer Server-Sent Events)', () => {
    const active = caddy.split('\n').filter((l) => /^\s*encode\b/.test(l));
    expect(active).toEqual([]);
    expect(caddy).toContain('flush_interval -1');
  });
});
