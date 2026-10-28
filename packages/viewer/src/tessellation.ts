// Tessellation for our loader: a pool of Web Workers running OCCT or truck (the viewer's own worker entry,
// tess-worker.ts, so Vite bundles the backends), behind the IndexedDB cache by default; in the import worker (its
// workers nested in it). The pool is made when first needed and kept for later files; changing the backend, the
// cache or the workers' count makes a new one. Cancelling (a new file while one is meshing) terminates the workers,
// which fails the requests still pending. The meshing settings are a profile of the library's (cad-scene's
// profiles.ts), or custom deflections.

import { MESH_PROFILES, type MeshProfile, type Tessellator } from 'cad-scene';
import type { DeviceClass } from './device.ts';
import { CachedTessellator, IndexedDbStore, type CacheStats } from 'tess-cache/browser';
import { DEFAULT_TIMEOUT_MS, PoolTessellator, webWorkerHandle } from 'tess-workers/browser';

export type Backend = 'occt' | 'truck';

export interface TessellationSettings {
  backend: Backend;
  /** A profile (meshed with its values exactly), or the deflections below. */
  profile: MeshProfile | 'custom';
  /** Millimetres: the profile's, or custom. */
  linearDeflection: number;
  /** Degrees: the profile's, or custom. */
  angularDeflection: number;
  /** The IndexedDB cache. */
  cache: boolean;
  /**
   * Seconds a part may take before its worker is stopped and the part counted failed; 0: no limit (the user,
   * 2026-10-28). The pool's default, 60. A timeout cached answers only while the limit is no longer than the one
   * that ran out, so a longer limit tries the part again.
   */
  timeout: number;
}

/** The default timeout, seconds: the pool's. */
export const DEFAULT_TIMEOUT = DEFAULT_TIMEOUT_MS / 1000;

/** A profile's settings: its deflections shown in millimetres and degrees. */
export function profileSettings(profile: MeshProfile): Pick<TessellationSettings, 'profile' | 'linearDeflection' |
  'angularDeflection'> {
  const p = MESH_PROFILES[profile];
  return { profile, linearDeflection: p.linearDeflection, angularDeflection: p.angularDeflection * 180 / Math.PI };
}

/** The defaults: a profile (the device's: device.ts), OCCT, cached. */
export function defaultSettings(profile: MeshProfile): TessellationSettings {
  return { backend: 'occt', ...profileSettings(profile), cache: true, timeout: DEFAULT_TIMEOUT };
}

/** What tessellateScene takes for the settings: the profile by name, or the custom deflections (in radians). */
export function deflectionsOf(s: TessellationSettings): { profile: MeshProfile } | { linearDeflection: number;
  angularDeflection: number } {
  return s.profile !== 'custom' ? { profile: s.profile } : { linearDeflection: s.linearDeflection,
    angularDeflection: s.angularDeflection * Math.PI / 180 };
}

export const CACHE_NAME = 'cad-viewer';

const BACKENDS: Record<Backend, { module: string; export: string }> = {
  occt: { module: 'tess-occt', export: 'OcctTessellator' },
  truck: { module: 'tess-truck', export: 'TruckTessellator' },
};

/**
 * Workers: one less than the cores, at most 8; at most 3 on phones and tablets (device.ts: they have less memory, and
 * each worker holds its own backend heap).
 */
export function workerCount(device: DeviceClass, cores = navigator.hardwareConcurrency || 2): number {
  return Math.max(1, Math.min(cores - 1, device === 'desktop' ? 8 : 3));
}

export class Tessellation {
  private current?: { key: string; tess: Tessellator; pool: PoolTessellator };
  /** Pools made so far. */
  private pools = 0;

  /**
   * A tessellator for the settings, ready (its workers started), with `workers` workers (the page's workerCount: this
   * runs in the import worker, which can't see the screen).
   */
  async get(s: TessellationSettings, workers: number): Promise<{ tess: Tessellator; workers: number }> {
    // (A new pool for another timeout too: a pool's is fixed.)
    const timeout = s.timeout ?? DEFAULT_TIMEOUT;
    const key = `${s.backend}:${s.cache}:${workers}:${timeout}`;
    if (this.current?.key !== key) {
      this.dispose();
      const pool = new PoolTessellator(
        () => webWorkerHandle(new Worker(new URL('./tess-worker.ts', import.meta.url), { type: 'module' })),
        { backend: BACKENDS[s.backend], workers, timeoutMs: Math.max(0, timeout) * 1000 });
      const tess = s.cache ? new CachedTessellator(pool, new IndexedDbStore({ name: CACHE_NAME })) : pool;
      this.current = { key, tess, pool };
      this.pools++;
      try {
        await tess.init();
      } catch (e) {
        this.dispose();
        throw e;
      }
    }
    return { tess: this.current!.tess, workers: this.current!.pool.workers };
  }

  /** The backend's name and version, the cache's counts (if it's on) and the pools made, once a pool exists. */
  describe(): { backend: string; cache?: CacheStats; pools: number } | undefined {
    const c = this.current;
    if (!c) return undefined;
    const backend = `${c.tess.info.name} ${c.tess.info.version}`;
    return c.tess instanceof CachedTessellator ? { backend, cache: c.tess.stats(), pools: this.pools }
      : { backend, pools: this.pools };
  }

  /** Stops the workers; pending requests fail. */
  dispose(): void {
    this.current?.tess.dispose();
    this.current = undefined;
  }
}

/** Empties the IndexedDB cache. */
export async function clearCache(): Promise<void> {
  await new IndexedDbStore({ name: CACHE_NAME }).clear();
}
