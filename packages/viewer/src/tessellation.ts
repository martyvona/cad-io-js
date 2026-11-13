// Tessellation for our loader: a pool of Web Workers running OCCT, truck or SMLib (the viewer's own worker entry,
// tess-worker.ts, so Vite bundles the backends), behind the IndexedDB cache by default; in the import worker (its
// workers nested in it). With a fallback backend, a second pool and cache, for the parts the first fails (cad-scene's
// FallbackTessellator). The pools are made when first needed and kept for later files; changing a backend, the
// cache or the workers' count makes new ones. Cancelling (a new file while one is meshing) terminates the workers,
// which fails the requests still pending. The meshing settings are a profile of the library's (cad-scene's
// profiles.ts), or custom deflections.

import { FallbackTessellator, MESH_PROFILES, type MeshProfile, type Tessellator } from 'cad-scene';
import type { DeviceClass } from './device.ts';
import { CachedTessellator, IndexedDbStore, type CacheStats } from 'tess-cache/browser';
import { DEFAULT_TIMEOUT_MS, PoolTessellator, webWorkerHandle } from 'tess-workers/browser';
import { StepTessellator } from 'step-export';

export type Backend = 'occt' | 'truck' | 'smlib';

export interface TessellationSettings {
  backend: Backend;
  /** Meshes the parts `backend` fails, keeping the result with fewer problems; none, or `backend` itself: none. */
  fallback: Backend | 'none';
  /** A profile (meshed with its values exactly), or the deflections below. */
  profile: MeshProfile | 'custom';
  /** Millimetres: the profile's, or custom. */
  linearDeflection: number;
  /** Degrees: the profile's, or custom. */
  angularDeflection: number;
  /** The IndexedDB cache. */
  cache: boolean;
  /**
   * Seconds a part may take before its worker is stopped and the part counted failed; 0: no limit. The pool's default,
   * 120. A timeout cached answers only while the limit is no longer than the one that ran out, so a longer limit tries
   * the part again.
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

/** The defaults: a profile (the device's: device.ts), OCCT with SMLib its fallback, cached. */
export function defaultSettings(profile: MeshProfile): TessellationSettings {
  return { backend: 'occt', fallback: 'smlib', ...profileSettings(profile), cache: true, timeout: DEFAULT_TIMEOUT };
}

/** The fallback the settings mean: none where it's the backend itself (or absent, as in an older recording). */
export function fallbackOf(s: Pick<TessellationSettings, 'backend' | 'fallback'>): Backend | undefined {
  return !s.fallback || s.fallback === 'none' || s.fallback === s.backend ? undefined : s.fallback;
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
  smlib: { module: 'tess-smlib', export: 'SmlibTessellator' },
};

/**
 * Workers: one less than the cores, at most 8; at most 3 on phones and tablets (device.ts: they have less memory, and
 * each worker holds its own backend heap).
 */
export function workerCount(device: DeviceClass, cores = navigator.hardwareConcurrency || 2): number {
  return Math.max(1, Math.min(cores - 1, device === 'desktop' ? 8 : 3));
}

export class Tessellation {
  private current?: { key: string; tess: Tessellator; pool: PoolTessellator; caches: CachedTessellator[] };
  /** Pools made so far. */
  private pools = 0;

  /**
   * A tessellator for the settings, ready (its workers started), with `workers` workers (the page's workerCount: this
   * runs in the import worker, which can't see the screen).
   */
  async get(s: TessellationSettings, workers: number): Promise<{ tess: Tessellator; workers: number }> {
    // (A new pool for another timeout too: a pool's is fixed.)
    const timeout = s.timeout ?? DEFAULT_TIMEOUT;
    const fallback = fallbackOf(s);
    const key = `${s.backend}:${fallback ?? 'none'}:${s.cache}:${workers}:${timeout}`;
    if (this.current?.key !== key) {
      this.dispose();
      const store = s.cache ? new IndexedDbStore({ name: CACHE_NAME }) : undefined;
      const caches: CachedTessellator[] = [];
      const make = (b: Backend) => {
        const pool = new PoolTessellator(
          () => webWorkerHandle(new Worker(new URL('./tess-worker.ts', import.meta.url), { type: 'module' })),
          { backend: BACKENDS[b], workers, timeoutMs: Math.max(0, timeout) * 1000 });
        // truck reads STEP: each part's B-rep model written as STEP, after the cache (which keys on the model); OCCT
        // and SMLib take models, passed through.
        const step = new StepTessellator(pool);
        const cached = store && new CachedTessellator(step, store);
        if (cached) caches.push(cached);
        return { pool, tess: cached ?? step };
      };
      const first = make(s.backend);
      const tess = fallback ? new FallbackTessellator(first.tess, make(fallback).tess) : first.tess;
      this.current = { key, tess, pool: first.pool, caches };
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

  /**
   * The backend's name and version (and the fallback's), the cache's counts (if it's on: both backends' summed) and
   * the times new pools were made, once a pool exists.
   */
  describe(): { backend: string; cache?: CacheStats; pools: number } | undefined {
    const c = this.current;
    if (!c) return undefined;
    const backend = `${c.tess.info.name} ${c.tess.info.version}`;
    if (!c.caches.length) return { backend, pools: this.pools };
    const all = c.caches.map((t) => t.stats());
    const sum = (k: keyof CacheStats) => all.reduce((n, x) => n + x[k], 0);
    const cache: CacheStats = { hits: sum('hits'), failureHits: sum('failureHits'), misses: sum('misses'),
      errors: sum('errors') };
    return { backend, cache, pools: this.pools };
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
