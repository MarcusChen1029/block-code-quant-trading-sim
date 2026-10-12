import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CachedMarketData } from '../../src/data/candleCache';
import { FakeMarket, MINUTE, testSession } from '../../src/live/testing';
import { syntheticCandles } from '../../src/engine/syntheticCandles';
import { getMeta, openDatabase, SCHEMA_VERSION, setMeta, SqliteCandleCache, SqliteSessionStore } from './db';

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qs-db-'));
  dirs.push(dir);
  return join(dir, 'test.sqlite');
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('SQLite database', () => {
  it('creates the schema at the current version, in WAL mode, and reopens it', () => {
    const path = tempDb();
    const db = openDatabase(path);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
    setMeta(db, 'k', 'v1');
    setMeta(db, 'k', 'v2');
    db.close();
    const again = openDatabase(path);
    expect(getMeta(again, 'k')).toBe('v2');
    again.close();
  });

  it('refuses a file written by a newer schema', () => {
    const path = tempDb();
    const db = openDatabase(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    expect(() => openDatabase(path)).toThrow(/newer than this server/);
  });
});

describe('SqliteSessionStore', () => {
  it('lists newest first, merges writes like the browser store (a stop is final, progress never moves back)', async () => {
    const db = openDatabase(tempDb());
    const store = new SqliteSessionStore(db);
    await store.put(testSession({ id: 'a', createdAt: 1 }));
    await store.put(testSession({ id: 'b', createdAt: 2 }));
    expect((await store.list()).map((r) => r.id)).toEqual(['b', 'a']);
    await store.put(testSession({ id: 'a', createdAt: 1, lastBarTime: 5 * MINUTE }));
    await store.put(testSession({ id: 'a', createdAt: 1, lastBarTime: 3 * MINUTE }));
    expect((await store.get('a'))?.lastBarTime).toBe(5 * MINUTE);
    await store.put(testSession({ id: 'a', createdAt: 1, status: 'stopped', stoppedAt: 9, lastBarTime: 6 * MINUTE }));
    const stopped = await store.put(testSession({ id: 'a', createdAt: 1, status: 'running', lastBarTime: 8 * MINUTE }));
    expect(stopped?.status).toBe('stopped');
    expect(stopped?.lastBarTime).toBe(6 * MINUTE);
    expect(await store.put(testSession({ id: 'gone' }), { onlyIfExists: true })).toBeNull();
    await store.delete('b');
    expect((await store.list()).map((r) => r.id)).toEqual(['a']);
    db.prepare("INSERT INTO sessions (id, created_at, record) VALUES ('bad', 3, '{not json')").run();
    expect((await store.list()).map((r) => r.id)).toEqual(['a']);
    db.close();
  });
});

describe('SqliteCandleCache', () => {
  const BARS = syntheticCandles(300, 0, MINUTE);
  const KEY = 'fake|BTCUSDT|1m';

  it('returns only covered bars and merges adjacent ranges', async () => {
    const db = openDatabase(tempDb());
    const cache = new SqliteCandleCache(db);
    await cache.write(KEY, MINUTE, BARS.slice(0, 10), [0, 9 * MINUTE]);
    await cache.write(KEY, MINUTE, BARS.slice(10, 20), [10 * MINUTE, 19 * MINUTE]);
    const got = await cache.read(KEY, 5 * MINUTE, 25 * MINUTE);
    expect(got.covered).toEqual([[5 * MINUTE, 19 * MINUTE]]);
    expect(got.bars.map((b) => b.time)).toEqual(BARS.slice(5, 20).map((b) => b.time));
    expect(got.bars[0]).toEqual(BARS[5]);
    db.close();
  });

  it('stays within its bar budget: other series first, then the oldest bars of the series being written', async () => {
    const db = openDatabase(tempDb());
    let now = 0;
    const cache = new SqliteCandleCache(db, 50, () => ++now);
    await cache.write('other', MINUTE, BARS.slice(0, 30), [0, 29 * MINUTE]);
    await cache.write(KEY, MINUTE, BARS.slice(0, 40), [0, 39 * MINUTE]);
    expect((await cache.read('other', 0, 1e9)).covered).toEqual([]);
    await cache.write(KEY, MINUTE, BARS.slice(40, 60), [40 * MINUTE, 59 * MINUTE]);
    const mine = await cache.read(KEY, 0, 1e9);
    expect(mine.bars.length).toBe(50);
    expect(mine.covered).toEqual([[10 * MINUTE, 59 * MINUTE]]);
    db.close();
  });

  it('a cached replay equals a REST-only one (CachedMarketData over SQLite)', async () => {
    const path = tempDb();
    const market = new FakeMarket(BARS, MINUTE, 200 * MINUTE);
    const db = openDatabase(path);
    const cached = new CachedMarketData(market, async () => new SqliteCandleCache(db));
    const first = await cached.fetchCandles('BTCUSDT', '1m', 0, 150 * MINUTE);
    const callsAfterFirst = market.fetchCalls.length;
    const second = await cached.fetchCandles('BTCUSDT', '1m', 0, 150 * MINUTE);
    const rest = await market.fetchCandles('BTCUSDT', '1m', 0, 150 * MINUTE);
    expect(second).toEqual(rest);
    expect(first).toEqual(rest);
    expect(market.fetchCalls.length).toBe(callsAfterFirst + 1); // the second read came from SQLite
    db.close();
  });
});
