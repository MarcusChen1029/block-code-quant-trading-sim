import { mergeRecords, parseSessionRecord, type LiveSessionRecord } from './session';

/** Where session records live. Records are copied in and out: callers never share objects with the store. */
export interface SessionStore {
  /** false = in-memory only (lost on reload). */
  readonly persistent: boolean;
  /** Valid records, newest first; malformed ones are skipped. */
  list(): Promise<LiveSessionRecord[]>;
  get(id: string): Promise<LiveSessionRecord | null>;
  /**
   * Merge-on-write (see mergeRecords), read and write in one transaction, so another tab's stop or newer
   * progress is never overwritten. Returns what is stored now; with `onlyIfExists` (updates of a known
   * session) nothing is written and null is returned when the session is gone (deleted in another tab).
   */
  put(record: LiveSessionRecord, options?: PutOptions): Promise<LiveSessionRecord | null>;
  delete(id: string): Promise<void>;
}

export interface PutOptions {
  onlyIfExists?: boolean;
}

const copy = <T>(value: T): T => structuredClone(value);
const newestFirst = (a: LiveSessionRecord, b: LiveSessionRecord) => b.createdAt - a.createdAt;

export class MemorySessionStore implements SessionStore {
  readonly persistent = false;
  private readonly records = new Map<string, LiveSessionRecord>();

  async list(): Promise<LiveSessionRecord[]> {
    return [...this.records.values()].map(copy).sort(newestFirst);
  }

  async get(id: string): Promise<LiveSessionRecord | null> {
    const r = this.records.get(id);
    return r ? copy(r) : null;
  }

  async put(record: LiveSessionRecord, options: PutOptions = {}): Promise<LiveSessionRecord | null> {
    const existing = this.records.get(record.id) ?? null;
    if (existing === null && options.onlyIfExists) return null;
    const merged = mergeRecords(existing, copy(record));
    this.records.set(record.id, merged);
    return copy(merged);
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }
}

export const DB_NAME = 'quant-sim-live';
const DB_VERSION = 1;
const STORE = 'sessions';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

export class IndexedDbSessionStore implements SessionStore {
  readonly persistent = true;

  private constructor(private readonly db: IDBDatabase) {}

  /** Opens (creating if needed) the session database. Rejects when IndexedDB is unusable or blocked. */
  static open(factory: IDBFactory, name = DB_NAME, timeoutMs = 5000): Promise<IndexedDbSessionStore> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('IndexedDB did not open in time')), timeoutMs);
      let req: IDBOpenDBRequest;
      try {
        req = factory.open(name, DB_VERSION);
      } catch (err) {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        clearTimeout(timer);
        resolve(new IndexedDbSessionStore(req.result));
      };
      req.onerror = () => {
        clearTimeout(timer);
        reject(req.error ?? new Error('IndexedDB open failed'));
      };
      req.onblocked = () => {
        clearTimeout(timer);
        reject(new Error('IndexedDB is blocked by another tab'));
      };
    });
  }

  private store(mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  async list(): Promise<LiveSessionRecord[]> {
    const raw = await request(this.store('readonly').getAll());
    return raw.map(parseSessionRecord).filter((r): r is LiveSessionRecord => r !== null).sort(newestFirst);
  }

  async get(id: string): Promise<LiveSessionRecord | null> {
    return parseSessionRecord(await request(this.store('readonly').get(id)));
  }

  async put(record: LiveSessionRecord, options: PutOptions = {}): Promise<LiveSessionRecord | null> {
    const tx = this.db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    let result: LiveSessionRecord | null = null;
    const read = store.get(record.id);
    read.onsuccess = () => {
      const existing = parseSessionRecord(read.result);
      if (existing === null && options.onlyIfExists) return; // deleted elsewhere: do not recreate it
      result = mergeRecords(existing, copy(record));
      store.put(result);
    };
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted (storage full?)'));
    });
    return result;
  }

  async delete(id: string): Promise<void> {
    await request(this.store('readwrite').delete(id));
  }

  close(): void {
    this.db.close();
  }
}

export interface OpenedStore {
  store: SessionStore;
  /** Set when sessions cannot be persisted; show it to the user. */
  notice?: string;
}

/** IndexedDB when it works (private windows and blocked storage often do not); otherwise memory + a notice. */
export async function openSessionStore(factory: IDBFactory | undefined = globalThis.indexedDB, name = DB_NAME): Promise<OpenedStore> {
  try {
    if (!factory) throw new Error('IndexedDB is not available');
    const store = await IndexedDbSessionStore.open(factory, name);
    await store.list(); // a store that opens but cannot be read is no better than none
    return { store };
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    return {
      store: new MemorySessionStore(),
      notice: `Live sessions are kept in memory only (${why}); they are lost when this page is closed or reloaded.`,
    };
  }
}
