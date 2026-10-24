// Tessellation for our loader: a pool of Web Workers running OCCT or truck (the viewer's own worker entry,
// tess-worker.ts, so Vite bundles the backends), behind the IndexedDB cache by default. The pool is made when first
// needed and kept for later files; changing the backend or the cache makes a new one. Cancelling (a new file while
// one is meshing) terminates the workers, which fails the requests still pending.

import type { Tessellator } from 'cad-scene';
import { CachedTessellator, IndexedDbStore, type CacheStats } from 'tess-cache/browser';
import { PoolTessellator, webWorkerHandle } from 'tess-workers/browser';

export type Backend = 'occt' | 'truck';

export interface TessellationSettings {
  backend: Backend;
  /** Millimetres. */
  linearDeflection: number;
  /** Degrees. */
  angularDeflection: number;
  /** The IndexedDB cache. */
  cache: boolean;
}

/** stepconv's defaults (0.1 mm, 0.5 rad exactly, shown as 28.6 degrees), OCCT, cached. */
export const DEFAULT_SETTINGS: TessellationSettings = { backend: 'occt', linearDeflection: 0.1,
  angularDeflection: 0.5 * 180 / Math.PI, cache: true };

export const CACHE_NAME = 'cad-viewer';

const BACKENDS: Record<Backend, { module: string; export: string }> = {
  occt: { module: 'tess-occt', export: 'OcctTessellator' },
  truck: { module: 'tess-truck', export: 'TruckTessellator' },
};

/**
 * Workers: one less than the cores, at most 8; at most 3 on touch devices (phones and tablets have less memory, and
 * each worker holds its own backend heap).
 */
export function workerCount(cores = navigator.hardwareConcurrency || 2, touch = navigator.maxTouchPoints > 0): number {
  return Math.max(1, Math.min(cores - 1, touch ? 3 : 8));
}

export class Tessellation {
  private current?: { key: string; tess: Tessellator; pool: PoolTessellator };

  /** A tessellator for the settings, ready (its workers started). */
  async get(s: TessellationSettings): Promise<{ tess: Tessellator; workers: number }> {
    const key = `${s.backend}:${s.cache}`;
    if (this.current?.key !== key) {
      this.dispose();
      const pool = new PoolTessellator(
        () => webWorkerHandle(new Worker(new URL('./tess-worker.ts', import.meta.url), { type: 'module' })),
        { backend: BACKENDS[s.backend], workers: workerCount() });
      const tess = s.cache ? new CachedTessellator(pool, new IndexedDbStore({ name: CACHE_NAME })) : pool;
      this.current = { key, tess, pool };
      try {
        await tess.init();
      } catch (e) {
        this.dispose();
        throw e;
      }
    }
    return { tess: this.current!.tess, workers: this.current!.pool.workers };
  }

  /** The backend's name and version, and the cache's counts (if it's on), once a pool exists. */
  describe(): { backend: string; cache?: CacheStats } | undefined {
    const c = this.current;
    if (!c) return undefined;
    const backend = `${c.tess.info.name} ${c.tess.info.version}`;
    return c.tess instanceof CachedTessellator ? { backend, cache: c.tess.stats() } : { backend };
  }

  /** Stops the workers; pending requests fail. */
  dispose(): void {
    this.current?.tess.dispose();
    this.current = undefined;
  }

  /** Empties the IndexedDB cache. */
  async clearCache(): Promise<void> {
    await new IndexedDbStore({ name: CACHE_NAME }).clear();
  }
}
