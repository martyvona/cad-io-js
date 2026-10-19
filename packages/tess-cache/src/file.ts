// A store in a directory (Node): one file per entry, `<dir>/<last two characters of the key>/<key>` (the end, since a
// backend's keys share their start), written to a temporary file and renamed into place, so a reader never sees a
// partial entry. Recency is the files' modification time, which a read updates, so it survives across runs. Processes
// can share a directory: each keeps its own count of the bytes held, from a scan of the directory when it starts, so
// the total can run over while several write at once.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CacheStore } from './cache.ts';
import { Lru } from './lru.ts';

export const DEFAULT_FILE_BYTES = 2 ** 30;

export interface FileStoreOptions {
  /** The directory (created if missing). Only entries' files in it are read or removed. */
  dir: string;
  /** Default 1 GiB; 0 disables the store, which then leaves the directory alone. */
  maxBytes?: number;
}

const ENTRY = /^[0-9A-Za-z_-]{3,}$/, SHARD = /^[0-9A-Za-z_-]{2}$/;

export class FileStore implements CacheStore {
  readonly maxBytes: number;
  private readonly dir: string;
  private lru: Lru;
  private ready?: Promise<void>;

  constructor(opts: FileStoreOptions) {
    this.dir = opts.dir;
    this.maxBytes = opts.maxBytes ?? DEFAULT_FILE_BYTES;
    this.lru = new Lru(this.maxBytes);
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (this.maxBytes <= 0) return undefined;
    await this.open();
    const file = this.file(key);
    let bytes: Uint8Array;
    try {
      const buf = await fs.readFile(file);
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      this.lru.remove(key);
      return undefined;
    }
    // Written by another process since the scan.
    if (!this.lru.has(key)) await this.unlink(this.lru.add(key, bytes.length));
    this.lru.touch(key);
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => {});
    return bytes;
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    if (value.length > this.maxBytes) return;
    await this.open();
    const file = this.file(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmp, value);
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
    await this.unlink(this.lru.add(key, value.length));
  }

  async delete(key: string): Promise<void> {
    await this.open();
    this.lru.remove(key);
    await this.unlink([key]);
  }

  async deleteWhere(drop: (key: string) => boolean): Promise<void> {
    if (this.maxBytes <= 0) return;
    await this.open();
    const keys = new Set([...(await this.scan()).map((e) => e.key), ...this.lru.keys()].filter(drop));
    for (const k of keys) this.lru.remove(k);
    await this.unlink([...keys]);
  }

  async clear(): Promise<void> {
    await this.open();
    if (!(await fs.stat(this.dir).catch(() => undefined))) return;
    const keys = (await this.scan()).map((e) => e.key);
    this.lru.clear();
    await this.unlink(keys);
  }

  async size(): Promise<number> {
    if (this.maxBytes <= 0) return 0;
    await this.open();
    return this.lru.total;
  }

  private file(key: string): string {
    if (!ENTRY.test(key)) throw new Error(`FileStore: bad key '${key}'`);
    return path.join(this.dir, key.slice(-2), key);
  }

  private open(): Promise<void> {
    return (this.ready ??= (async () => {
      if (this.maxBytes <= 0) return;
      await fs.mkdir(this.dir, { recursive: true });
      const entries = (await this.scan()).sort((a, b) => a.used - b.used);
      for (const e of entries) await this.unlink(this.lru.add(e.key, e.size));
    })().catch((e: unknown) => {
      this.ready = undefined;
      this.lru.clear();
      throw e;
    }));
  }

  /** The entries' files in the directory (and leftover temporary files, removed). */
  private async scan(): Promise<{ key: string; size: number; used: number }[]> {
    const out: { key: string; size: number; used: number }[] = [];
    for (const shard of await fs.readdir(this.dir)) {
      if (!SHARD.test(shard)) continue;
      let names: string[];
      try {
        names = await fs.readdir(path.join(this.dir, shard));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(this.dir, shard, name);
        if (name.endsWith('.tmp') && name.split('.')[0]!.endsWith(shard)) {
          // Another process's write in progress, or one that died: removed once it's an hour old.
          const st = await fs.stat(file).catch(() => undefined);
          if (st && Date.now() - st.mtimeMs > 3600_000) await fs.rm(file, { force: true });
          continue;
        }
        if (!ENTRY.test(name) || !name.endsWith(shard)) continue;
        const st = await fs.stat(file).catch(() => undefined);
        if (st?.isFile()) out.push({ key: name, size: st.size, used: st.mtimeMs });
      }
    }
    return out;
  }

  private async unlink(keys: string[]): Promise<void> {
    for (const k of keys) await fs.rm(this.file(k), { force: true });
  }
}
