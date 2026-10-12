import type { CandleSubscription, ConnectionState, MarketDataAdapter } from './adapter';
import { timeframeToMs, type Candle, type Timeframe } from './types';

/** Inclusive [first, last] bar open times. */
export type BarRange = [number, number];

/**
 * Closed candles kept across reloads, per series (adapter + symbol + timeframe). A COVERED range [a, b] means every
 * bar the exchange has with an open time in [a, b] is stored (exchange holes stay holes), so a covered range never
 * needs REST again. Only REST bars go in, as the market adapter returned them (it applies the server-clock
 * closure rule); websocket bars never do (unverified against REST).
 */
export interface CandleCache {
  /** Stored bars of [from, to] and the parts of [from, to] that are covered, ascending. Refreshes recency. */
  read(key: string, from: number, to: number): Promise<{ bars: Candle[]; covered: BarRange[] }>;
  /** Stores `bars` (deduplicated by open time) and marks `covered` as complete. */
  write(key: string, step: number, bars: readonly Candle[], covered: BarRange): Promise<void>;
}

export interface CandleCacheOptions {
  name?: string;
  /** Schema version: a different one drops everything (the cache is disposable). */
  version?: number;
  /** Total bars kept over all series (LRU by series, then oldest bars of the series being written). */
  maxBars?: number;
  now?: () => number;
  timeoutMs?: number;
  /** IDBKeyRange of the same implementation as the factory (default: the global one). */
  keyRange?: typeof IDBKeyRange;
}

export const CANDLE_DB_NAME = 'quant-sim-candles';
export const CANDLE_DB_VERSION = 1;
/** ~300k bars: about 7 months of 1m bars, a few tens of MB at most. */
export const CANDLE_CACHE_MAX_BARS = 300_000;
const BARS = 'bars';
const SERIES = 'series';

interface StoredBar { k: string; t: number; o: number; h: number; l: number; c: number; v: number }
interface SeriesMeta { k: string; step: number; ranges: BarRange[]; count: number; usedAt: number }

const toStored = (k: string, c: Candle): StoredBar => ({ k, t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume });
const fromStored = (s: StoredBar): Candle => ({ time: s.t, open: s.o, high: s.h, low: s.l, close: s.c, volume: s.v });
const finiteBar = (c: Candle) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite);

/** Sorted, merged (overlapping or adjacent by `step`) copy of `ranges`. Pure. */
export function mergeRanges(ranges: readonly BarRange[], step: number): BarRange[] {
  const sorted = ranges.filter(([a, b]) => b >= a).map(([a, b]): BarRange => [a, b]).sort((x, y) => x[0] - y[0]);
  const out: BarRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + step) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** Parts of [from, to] (bar open times) not in `covered` (merged), ascending. Pure. */
export function missingRanges(from: number, to: number, covered: readonly BarRange[], step: number): BarRange[] {
  const out: BarRange[] = [];
  let cursor = from;
  for (const [a, b] of covered) {
    if (b < cursor) continue;
    if (a > to) break;
    if (a > cursor) out.push([cursor, Math.min(to, a - step)]);
    cursor = Math.max(cursor, b + step);
    if (cursor > to) break;
  }
  if (cursor <= to) out.push([cursor, to]);
  return out.filter(([a, b]) => b >= a);
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

class IndexedDbCandleCache implements CandleCache {
  constructor(
    private readonly db: IDBDatabase,
    private readonly keyRange: typeof IDBKeyRange,
    private readonly maxBars: number,
    private readonly now: () => number,
  ) {
    // A newer version opened elsewhere (another tab after an update): let it upgrade; this tab falls back to REST.
    db.onversionchange = () => db.close();
  }

  private bounds(k: string, from = -Infinity, to = Infinity): IDBKeyRange {
    return this.keyRange.bound([k, from], [k, to]);
  }

  async read(key: string, from: number, to: number): Promise<{ bars: Candle[]; covered: BarRange[] }> {
    const tx = this.db.transaction([BARS, SERIES], 'readwrite');
    const series = tx.objectStore(SERIES);
    const meta = (await req(series.get(key))) as SeriesMeta | undefined;
    if (!meta) {
      await done(tx);
      return { bars: [], covered: [] };
    }
    const covered = meta.ranges.filter(([a, b]) => b >= from && a <= to).map(([a, b]): BarRange => [Math.max(a, from), Math.min(b, to)]);
    const stored = covered.length > 0 ? ((await req(tx.objectStore(BARS).getAll(this.bounds(key, from, to)))) as StoredBar[]) : [];
    series.put({ ...meta, usedAt: this.now() });
    await done(tx);
    const inCover = (t: number) => covered.some(([a, b]) => t >= a && t <= b);
    return { bars: stored.filter((s) => inCover(s.t)).map(fromStored), covered };
  }

  async write(key: string, step: number, bars: readonly Candle[], covered: BarRange): Promise<void> {
    const good = bars.filter((c) => finiteBar(c) && c.time >= covered[0] && c.time <= covered[1]);
    if (covered[1] < covered[0]) return;
    const tx = this.db.transaction([BARS, SERIES], 'readwrite');
    const barStore = tx.objectStore(BARS);
    const series = tx.objectStore(SERIES);
    for (const c of good) barStore.put(toStored(key, c));
    const meta = (await req(series.get(key))) as SeriesMeta | undefined;
    const ranges = mergeRanges([...(meta && meta.step === step ? meta.ranges : []), covered], step);
    const count = await req(barStore.count(this.bounds(key)));
    series.put({ k: key, step, ranges, count, usedAt: this.now() } satisfies SeriesMeta);
    await done(tx);
    await this.evict(key);
  }

  /** Over budget: drop least recently used series (never `current`), then the oldest bars of `current`. */
  private async evict(current: string): Promise<void> {
    const tx = this.db.transaction([BARS, SERIES], 'readwrite');
    const barStore = tx.objectStore(BARS);
    const series = tx.objectStore(SERIES);
    const metas = ((await req(series.getAll())) as SeriesMeta[]).sort((a, b) => a.usedAt - b.usedAt);
    let total = metas.reduce((n, m) => n + m.count, 0);
    for (const m of metas) {
      if (total <= this.maxBars) break;
      if (m.k === current) continue;
      barStore.delete(this.bounds(m.k));
      series.delete(m.k);
      total -= m.count;
    }
    const mine = metas.find((m) => m.k === current);
    if (total > this.maxBars && mine) {
      const excess = total - this.maxBars;
      const oldest = (await req(barStore.getAllKeys(this.bounds(current), excess))) as Array<[string, number]>;
      if (oldest.length > 0) {
        const cut = oldest[oldest.length - 1][1];
        barStore.delete(this.bounds(current, -Infinity, cut));
        const ranges = mine.ranges.filter(([, b]) => b > cut).map(([a, b]): BarRange => [Math.max(a, cut + mine.step), b]);
        series.put({ ...mine, ranges, count: Math.max(0, mine.count - oldest.length) } satisfies SeriesMeta);
      }
    }
    await done(tx);
  }
}

/**
 * Opens the candle cache, or null when IndexedDB is missing, refused (private mode, blocked storage) or slow: the
 * cache is an optimisation, callers then use REST only.
 */
export function openCandleCache(factory: IDBFactory | undefined = globalThis.indexedDB, options: CandleCacheOptions = {}): Promise<CandleCache | null> {
  const name = options.name ?? CANDLE_DB_NAME;
  const version = options.version ?? CANDLE_DB_VERSION;
  return new Promise((resolve) => {
    if (!factory) {
      resolve(null);
      return;
    }
    let settled = false;
    const finish = (value: CandleCache | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), options.timeoutMs ?? 5000);
    let open: IDBOpenDBRequest;
    try {
      open = factory.open(name, version);
    } catch {
      finish(null);
      return;
    }
    open.onupgradeneeded = () => {
      const db = open.result;
      // Any other schema: drop it all (cached candles can always be fetched again).
      for (const store of Array.from(db.objectStoreNames)) db.deleteObjectStore(store);
      db.createObjectStore(BARS, { keyPath: ['k', 't'] });
      db.createObjectStore(SERIES, { keyPath: 'k' });
    };
    open.onsuccess = () => {
      if (settled) {
        open.result.close();
        return;
      }
      const keyRange = options.keyRange ?? globalThis.IDBKeyRange;
      if (!keyRange) {
        open.result.close();
        finish(null);
        return;
      }
      finish(new IndexedDbCandleCache(open.result, keyRange, options.maxBars ?? CANDLE_CACHE_MAX_BARS, options.now ?? (() => Date.now())));
    };
    open.onerror = () => finish(null);
    open.onblocked = () => finish(null);
  });
}

/**
 * A market-data adapter that serves closed candles from the cache and asks the wrapped adapter only for the bars
 * it does not have; whatever the wrapped adapter returns (closed bars only) is cached. Every cache failure falls
 * back to the wrapped adapter silently; the wrapped adapter's own errors pass through (the runner retries them).
 */
export class CachedMarketData implements MarketDataAdapter {
  readonly name: string;
  private cache: Promise<CandleCache | null> | null = null;
  private broken = false;

  constructor(private readonly inner: MarketDataAdapter, private readonly openCache: () => Promise<CandleCache | null>) {
    this.name = inner.name;
  }

  private key(symbol: string, tf: Timeframe): string {
    return `${this.inner.name}|${symbol}|${tf}`;
  }

  private async usable(): Promise<CandleCache | null> {
    if (this.broken) return null;
    this.cache ??= this.openCache().catch(() => null);
    return this.cache;
  }

  async fetchCandles(symbol: string, tf: Timeframe, startMs: number, endMs: number): Promise<Candle[]> {
    const cache = await this.usable();
    if (!cache) return this.inner.fetchCandles(symbol, tf, startMs, endMs);
    const step = timeframeToMs(tf);
    const key = this.key(symbol, tf);
    // Bar open times inside [startMs, endMs].
    const first = Math.ceil(startMs / step) * step;
    const last = Math.floor(endMs / step) * step;
    let cached: { bars: Candle[]; covered: BarRange[] };
    try {
      cached = await cache.read(key, first, last);
    } catch {
      this.broken = true;
      return this.inner.fetchCandles(symbol, tf, startMs, endMs);
    }
    const out = new Map<number, Candle>(cached.bars.map((c) => [c.time, c]));
    for (const [a, b] of missingRanges(first, last, cached.covered, step)) {
      // A gap before cached bars is fetched one bar past its end: the adapter never trusts the newest row it gets
      // (it may be forming) without a server clock, and that row is then a cached, closed one.
      const tail = b === last;
      const from = a === first ? startMs : a;
      const to = tail ? endMs : b + step;
      const got = await this.inner.fetchCandles(symbol, tf, from, to);
      for (const c of got) if (c.time >= startMs && c.time <= endMs && !out.has(c.time)) out.set(c.time, c);
      if (got.length > 0) {
        const newest = got[got.length - 1].time;
        try {
          await cache.write(key, step, got, [a, Math.max(a, newest)]);
        } catch {
          this.broken = true;
        }
      }
    }
    return [...out.values()].sort((x, y) => x.time - y.time);
  }

  subscribeCandles(
    symbol: string,
    tf: Timeframe,
    onCandle: (candle: Candle, closed: boolean) => void,
    onError?: (error: Error) => void,
    onStatus?: (state: ConnectionState) => void,
  ): CandleSubscription {
    // Websocket bars are NOT cached: a final kline is not verified against REST, and a cached replay must equal a
    // REST-only one. Bars the session took from the socket come from REST (then the cache) on the next reopen.
    return this.inner.subscribeCandles(symbol, tf, onCandle, onError, onStatus);
  }

  serverNow(): number | null {
    return this.inner.serverNow?.() ?? null;
  }

  async syncClock(): Promise<boolean> {
    return (await this.inner.syncClock?.()) ?? false;
  }

  async firstBarAtOrAfter(symbol: string, tf: Timeframe, fromMs: number): Promise<number | null> {
    return (await this.inner.firstBarAtOrAfter?.(symbol, tf, fromMs)) ?? null;
  }
}
