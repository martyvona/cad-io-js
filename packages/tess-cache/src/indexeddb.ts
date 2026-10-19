// A store in IndexedDB (browsers): entries' bytes in one object store, their sizes and last use in another, so that
// opening reads only the small records. Pages of one origin can share a database: each keeps its own count of the
// bytes held, from the records when it opens, so the total can run over while several write at once.

import type { CacheStore } from './cache.ts';
import { Lru } from './lru.ts';

export const DEFAULT_INDEXEDDB_BYTES = 256 * 2 ** 20;

export interface IndexedDbStoreOptions {
  /** The database's name. Default 'cad-io-js-tess-cache'. */
  name?: string;
  /** Default 256 MiB; 0 disables the store, which then doesn't open the database. */
  maxBytes?: number;
}

interface Meta {
  size: number;
  used: number;
}

const DATA = 'data', META = 'meta';

const done = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const finished = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('transaction aborted')); });

export class IndexedDbStore implements CacheStore {
  readonly maxBytes: number;
  readonly name: string;
  private lru: Lru;
  private db?: Promise<IDBDatabase>;

  constructor(opts: IndexedDbStoreOptions = {}) {
    this.name = opts.name ?? 'cad-io-js-tess-cache';
    this.maxBytes = opts.maxBytes ?? DEFAULT_INDEXEDDB_BYTES;
    this.lru = new Lru(this.maxBytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.maxBytes <= 0) return undefined;
    const db = await this.open();
    const bytes = (await done(db.transaction(DATA).objectStore(DATA).get(key))) as Uint8Array | undefined;
    if (!bytes) {
      this.lru.remove(key);
      return undefined;
    }
    const tx = db.transaction([DATA, META], 'readwrite');
    // Written by another page since this one opened.
    if (!this.lru.has(key)) this.evict(tx, this.lru.add(key, bytes.length));
    if (this.lru.has(key)) {
      this.lru.touch(key);
      tx.objectStore(META).put({ size: bytes.length, used: Date.now() } satisfies Meta, key);
    }
    await finished(tx);
    return bytes;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    if (value.length > this.maxBytes) return;
    const db = await this.open();
    const tx = db.transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).put(value, key);
    tx.objectStore(META).put({ size: value.length, used: Date.now() } satisfies Meta, key);
    const evicted = this.lru.add(key, value.length);
    this.evict(tx, evicted);
    try {
      await finished(tx);
    } catch (e) {
      this.lru.remove(key);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    this.lru.remove(key);
    if (this.maxBytes <= 0) return;
    const tx = (await this.open()).transaction([DATA, META], 'readwrite');
    this.evict(tx, [key]);
    await finished(tx);
  }

  async deleteWhere(drop: (key: string) => boolean): Promise<void> {
    if (this.maxBytes <= 0) return;
    const tx = (await this.open()).transaction([DATA, META], 'readwrite');
    const keys = (await done(tx.objectStore(META).getAllKeys())).map(String).filter(drop);
    this.evict(tx, keys);
    await finished(tx);
    for (const k of keys) this.lru.remove(k);
  }

  async clear(): Promise<void> {
    this.lru.clear();
    if (this.maxBytes <= 0) return;
    const tx = (await this.open()).transaction([DATA, META], 'readwrite');
    tx.objectStore(DATA).clear();
    tx.objectStore(META).clear();
    await finished(tx);
  }

  async size(): Promise<number> {
    if (this.maxBytes <= 0) return 0;
    await this.open();
    return this.lru.total;
  }

  /** Closes the database (a later call opens it again). */
  close(): void {
    const db = this.db;
    this.db = undefined;
    this.lru.clear();
    void db?.then((d) => d.close(), () => {});
  }

  private evict(tx: IDBTransaction, keys: string[]): void {
    for (const k of keys) {
      tx.objectStore(DATA).delete(k);
      tx.objectStore(META).delete(k);
    }
  }

  private open(): Promise<IDBDatabase> {
    return (this.db ??= (async () => {
      const r = indexedDB.open(this.name, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore(DATA);
        r.result.createObjectStore(META);
      };
      const db = await done(r);
      const tx = db.transaction([DATA, META], 'readwrite');
      const meta = tx.objectStore(META);
      const [keys, records] = await Promise.all([done(meta.getAllKeys()), done(meta.getAll())]);
      const entries = keys.map((k, i) => ({ key: String(k), ...(records[i] as Meta) })).sort((a, b) => a.used - b.used);
      for (const e of entries) this.evict(tx, this.lru.add(e.key, e.size));
      await finished(tx);
      return db;
    })().catch((e: unknown) => {
      this.db = undefined;
      this.lru.clear();
      throw e;
    }));
  }
}
