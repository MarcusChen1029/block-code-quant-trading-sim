import { constants, DatabaseSync } from 'node:sqlite';
import { CANDLE_CACHE_MAX_BARS, mergeRanges, type BarRange, type CandleCache } from '../../src/data/candleCache';
import type { Candle } from '../../src/data/types';
import { mergeRecords, parseSessionRecord, type LiveSessionRecord } from '../../src/live/session';
import type { PutOptions, SessionStore } from '../../src/live/store';

/** Bumped with every schema change; `migrate` brings older files forward. */
export const SCHEMA_VERSION = 1;

/**
 * Opens (creating if needed) the server's SQLite file: WAL (readers never block the writer; workers open their
 * own connections for the candle cache), a busy timeout for those concurrent writers, and the current schema.
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    denyFileAttach(db);
    migrate(db);
  } catch (err) {
    db.close();
    throw err;
  }
  return db;
}

/**
 * SQLite can write files that Node's permission model does not see: `ATTACH DATABASE '<path>'` and
 * `VACUUM INTO '<path>'` (which SQLite authorizes as an ATTACH). Deny both on every connection — the server and the
 * workers only ever read/write their one file — so even a would-be SQL injection or a sandbox escape that reached a
 * DB handle cannot create a file outside the data directory. Extension loading stays off (the default).
 */
function denyFileAttach(db: DatabaseSync): void {
  db.setAuthorizer((action) => (action === constants.SQLITE_ATTACH || action === constants.SQLITE_DETACH ? constants.SQLITE_DENY : constants.SQLITE_OK));
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const version = row.user_version;
  if (version > SCHEMA_VERSION) throw new Error(`database schema ${version} is newer than this server (${SCHEMA_VERSION}); update the server`);
  if (version === SCHEMA_VERSION) return;
  transaction(db, () => {
    if (version < 1) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS candle_series (k TEXT PRIMARY KEY, step INTEGER NOT NULL, ranges TEXT NOT NULL, count INTEGER NOT NULL, used_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS candle_bars (k TEXT NOT NULL, t INTEGER NOT NULL, o REAL NOT NULL, h REAL NOT NULL, l REAL NOT NULL, c REAL NOT NULL, v REAL NOT NULL, PRIMARY KEY (k, t)) WITHOUT ROWID;
      `);
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

/** Runs `fn` in an IMMEDIATE transaction (takes the write lock up front, so read-modify-write is atomic). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMeta(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

const parseStored = (json: string): LiveSessionRecord | null => {
  try {
    return parseSessionRecord(JSON.parse(json));
  } catch {
    return null;
  }
};

/** Session records in SQLite, with the browser store's merge-on-write rules (a stop is final, progress never moves back). */
export class SqliteSessionStore implements SessionStore {
  readonly persistent = true;

  constructor(private readonly db: DatabaseSync) {}

  async list(): Promise<LiveSessionRecord[]> {
    const rows = this.db.prepare('SELECT record FROM sessions ORDER BY created_at DESC').all() as Array<{ record: string }>;
    return rows.map((r) => parseStored(r.record)).filter((r): r is LiveSessionRecord => r !== null);
  }

  async get(id: string): Promise<LiveSessionRecord | null> {
    const row = this.db.prepare('SELECT record FROM sessions WHERE id = ?').get(id) as { record: string } | undefined;
    return row ? parseStored(row.record) : null;
  }

  async put(record: LiveSessionRecord, options: PutOptions = {}): Promise<LiveSessionRecord | null> {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT record FROM sessions WHERE id = ?').get(record.id) as { record: string } | undefined;
      const existing = row ? parseStored(row.record) : null;
      if (existing === null && options.onlyIfExists) return null;
      const merged = mergeRecords(existing, structuredClone(record));
      this.db.prepare('INSERT INTO sessions (id, created_at, record) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record')
        .run(merged.id, merged.createdAt, JSON.stringify(merged));
      return structuredClone(merged);
    });
  }

  async delete(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }
}

interface SeriesRow { k: string; step: number; ranges: string; count: number; used_at: number }
interface BarRow { t: number; o: number; h: number; l: number; c: number; v: number }

const finiteBar = (c: Candle) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite);

function parseRanges(json: string): BarRange[] {
  try {
    const raw = JSON.parse(json) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.filter((r): r is BarRange => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]));
  } catch {
    return [];
  }
}

/**
 * The closed-candle cache (same contract as the browser's IndexedDB one, see CandleCache): only REST bars, covered
 * ranges never refetched, bounded to `maxBars` over all series (least recently used series go first, then the
 * oldest bars of the series being written).
 */
export class SqliteCandleCache implements CandleCache {
  constructor(
    private readonly db: DatabaseSync,
    private readonly maxBars = CANDLE_CACHE_MAX_BARS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private series(key: string): SeriesRow | undefined {
    return this.db.prepare('SELECT * FROM candle_series WHERE k = ?').get(key) as SeriesRow | undefined;
  }

  async read(key: string, from: number, to: number): Promise<{ bars: Candle[]; covered: BarRange[] }> {
    return transaction(this.db, () => {
      const meta = this.series(key);
      if (!meta) return { bars: [], covered: [] };
      const covered = parseRanges(meta.ranges).filter(([a, b]) => b >= from && a <= to).map(([a, b]): BarRange => [Math.max(a, from), Math.min(b, to)]);
      const rows = covered.length > 0
        ? (this.db.prepare('SELECT t, o, h, l, c, v FROM candle_bars WHERE k = ? AND t >= ? AND t <= ? ORDER BY t').all(key, from, to) as BarRow[])
        : [];
      this.db.prepare('UPDATE candle_series SET used_at = ? WHERE k = ?').run(this.now(), key);
      const inCover = (t: number) => covered.some(([a, b]) => t >= a && t <= b);
      return {
        bars: rows.filter((r) => inCover(r.t)).map((r) => ({ time: r.t, open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v })),
        covered,
      };
    });
  }

  async write(key: string, step: number, bars: readonly Candle[], covered: BarRange): Promise<void> {
    if (covered[1] < covered[0]) return;
    const good = bars.filter((c) => finiteBar(c) && c.time >= covered[0] && c.time <= covered[1]);
    transaction(this.db, () => {
      const insert = this.db.prepare('INSERT OR REPLACE INTO candle_bars (k, t, o, h, l, c, v) VALUES (?, ?, ?, ?, ?, ?, ?)');
      for (const c of good) insert.run(key, c.time, c.open, c.high, c.low, c.close, c.volume);
      const meta = this.series(key);
      const ranges = mergeRanges([...(meta && meta.step === step ? parseRanges(meta.ranges) : []), covered], step);
      const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM candle_bars WHERE k = ?').get(key) as { n: number };
      this.db.prepare('INSERT OR REPLACE INTO candle_series (k, step, ranges, count, used_at) VALUES (?, ?, ?, ?, ?)')
        .run(key, step, JSON.stringify(ranges), n, this.now());
      this.evict(key);
    });
  }

  /** Over budget: drop least recently used series (never `current`), then the oldest bars of `current`. */
  private evict(current: string): void {
    const metas = this.db.prepare('SELECT * FROM candle_series ORDER BY used_at ASC').all() as unknown as SeriesRow[];
    let total = metas.reduce((n, m) => n + m.count, 0);
    for (const m of metas) {
      if (total <= this.maxBars) break;
      if (m.k === current) continue;
      this.db.prepare('DELETE FROM candle_bars WHERE k = ?').run(m.k);
      this.db.prepare('DELETE FROM candle_series WHERE k = ?').run(m.k);
      total -= m.count;
    }
    const mine = metas.find((m) => m.k === current);
    if (total > this.maxBars && mine) {
      const excess = total - this.maxBars;
      const cutRow = this.db.prepare('SELECT t FROM candle_bars WHERE k = ? ORDER BY t ASC LIMIT 1 OFFSET ?').get(current, excess - 1) as { t: number } | undefined;
      if (cutRow) {
        const cut = cutRow.t;
        const removed = this.db.prepare('DELETE FROM candle_bars WHERE k = ? AND t <= ?').run(current, cut);
        const ranges = parseRanges(mine.ranges).filter(([, b]) => b > cut).map(([a, b]): BarRange => [Math.max(a, cut + mine.step), b]);
        this.db.prepare('UPDATE candle_series SET ranges = ?, count = ? WHERE k = ?')
          .run(JSON.stringify(ranges), Math.max(0, mine.count - Number(removed.changes)), current);
      }
    }
  }
}
