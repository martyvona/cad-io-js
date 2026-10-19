// A store in memory, for one process or page.

import type { CacheStore } from './cache.ts';
import { Lru } from './lru.ts';

export const DEFAULT_MEMORY_BYTES = 256 * 2 ** 20;

/** Keeps the values it's given (the caller mustn't change them afterwards). */
export class MemoryStore implements CacheStore {
  readonly maxBytes: number;
  private values = new Map<string, Uint8Array>();
  private lru: Lru;

  /** `maxBytes`: default 256 MiB; 0 disables the store. */
  constructor(maxBytes = DEFAULT_MEMORY_BYTES) {
    this.maxBytes = maxBytes;
    this.lru = new Lru(maxBytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const v = this.values.get(key);
    if (v) this.lru.touch(key);
    return v;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    if (value.length > this.maxBytes) return;
    for (const k of this.lru.add(key, value.length)) this.values.delete(k);
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.lru.remove(key);
    this.values.delete(key);
  }

  async deleteWhere(drop: (key: string) => boolean): Promise<void> {
    for (const k of this.lru.keys()) if (drop(k)) await this.delete(k);
  }

  async clear(): Promise<void> {
    this.lru.clear();
    this.values.clear();
  }

  async size(): Promise<number> {
    return this.lru.total;
  }
}
