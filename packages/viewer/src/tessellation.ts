// Tessellation for our loader: a pool of Web Workers running OCCT, truck, SMLib or our own tessellator (tess-cadio)
// (the viewer's own worker entry, tess-worker.ts, so Vite bundles the backends), behind the IndexedDB cache by
// default (never for tess-cadio's debugging switch, whose meshes the cache can't tell apart); in the model worker (its
// workers nested in it). With a fallback backend, a second pool and cache, for the parts the first fails (cad-scene's
// FallbackTessellator). The pools are made when first needed and kept for later files; changing a backend, the
// cache or the workers' count makes new ones. Cancelling (a new file while one is meshing) terminates the workers,
// which fails the requests still pending. The meshing settings are a profile of the library's (cad-scene's
// profiles.ts), or custom deflections.

import { FallbackTessellator, MESH_PROFILES, meshDeflections, type Deflections, type MeshProfile, type Tessellator }
  from 'cad-scene';
import { FIXES_OFF_BY_DEFAULT, HEAL_BY_DEFAULT, HEAL_FIXES, type HealFix, PCURVE_FIT_TOLERANCE } from
  'cad-heal/options';
import { DEFAULT_MIN_ANGLE_DEGREES, KEEP_FAILING } from 'tess-cadio/options';
import type { DeviceClass } from './device.ts';
import { CachedTessellator, IndexedDbStore, type CacheStats } from 'tess-cache/browser';
import { DEFAULT_TIMEOUT_MS, PoolTessellator, webWorkerHandle } from 'tess-workers/browser';
import { StepTessellator } from 'step-export';

export type Backend = 'occt' | 'truck' | 'smlib' | 'cadio';

/** The backends, in the controls' order. */
export const BACKEND_NAMES: readonly Backend[] = ['occt', 'truck', 'smlib', 'cadio'];

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
  /**
   * Heal B-reps: each model healed (cad-heal) in the pool's workers before it's meshed, the scene's (and exports')
   * models then the healed ones; off, the models as imported.
   */
  heal: boolean;
  /** Under `heal`, each fix on or off (cad-heal's HEAL_FIXES). */
  healFixes: Record<HealFix, boolean>;
  /** Under `heal`, the tolerance (mm) healing's p-curves for bare uses are fitted within (cad-heal's
   * pcurveFitTolerance). */
  healFit: number;
  /**
   * tess-cadio's smallest angle in its triangles, degrees (the request's minAngle; 0 none); only asked where tess-cadio
   * is the backend or the fallback, and its own default (DEFAULT_MIN_ANGLE_DEGREES) not asked at all, so those meshes
   * and cache entries are the ones made without it.
   */
  minAngle: number;
  /**
   * Debugging: tess-cadio keeps the faces it would fail for their mesh (tess-cadio/options' KEEP_FAILING), so a
   * failing face's triangles can be seen (and no fallback meshes it); its meshes never cached.
   */
  keepFailing: boolean;
  /**
   * tess-cadio's most triangles a face may take (init's capCeiling), or its own default (10M): set by the page from its
   * device for each load (capCeilingOf), never in the address or a recording. Meshes are cached under the request, not
   * this, which is the same for every load in one browser.
   */
  capCeiling?: number;
}

/** The fixes as cad-heal has them by default. */
export function defaultFixes(): Record<HealFix, boolean> {
  return Object.fromEntries(HEAL_FIXES.map((f) => [f, !FIXES_OFF_BY_DEFAULT.includes(f)])) as Record<HealFix, boolean>;
}

/** The default timeout, seconds: the pool's. */
export const DEFAULT_TIMEOUT = DEFAULT_TIMEOUT_MS / 1000;

/** A profile's settings: its deflections shown in millimetres and degrees. */
export function profileSettings(profile: MeshProfile): Pick<TessellationSettings, 'profile' | 'linearDeflection' |
  'angularDeflection'> {
  const p = MESH_PROFILES[profile];
  return { profile, linearDeflection: p.linearDeflection, angularDeflection: p.angularDeflection * 180 / Math.PI };
}

/** The defaults: a profile (the device's: device.ts), OCCT with SMLib its fallback, cached, healed or not by cad-heal's
 * HEAL_BY_DEFAULT. */
export function defaultSettings(profile: MeshProfile): TessellationSettings {
  return { backend: 'occt', fallback: 'smlib', ...profileSettings(profile), cache: true, timeout: DEFAULT_TIMEOUT,
    heal: HEAL_BY_DEFAULT, healFixes: defaultFixes(), healFit: PCURVE_FIT_TOLERANCE,
    minAngle: DEFAULT_MIN_ANGLE_DEGREES, keepFailing: false };
}

/** Whether tess-cadio meshes with these settings: as the backend or the fallback. */
export const usesCadio = (s: Pick<TessellationSettings, 'backend' | 'fallback'>) =>
  s.backend === 'cadio' || fallbackOf(s) === 'cadio';

/**
 * The request's minAngle the settings ask (radians), or none: tess-cadio not meshing, the setting absent (an older
 * recording's) or tess-cadio's own default.
 */
export function minAngleOf(s: Pick<TessellationSettings, 'backend' | 'fallback'> & Partial<Pick<TessellationSettings,
  'minAngle'>>): number | undefined {
  if (!usesCadio(s) || s.minAngle === undefined || s.minAngle === DEFAULT_MIN_ANGLE_DEGREES) return undefined;
  return s.minAngle * Math.PI / 180;
}

/** Whether tess-cadio's debugging switch is on and tess-cadio meshes. */
export const keepsFailing = (s: Pick<TessellationSettings, 'backend' | 'fallback'> &
  Partial<Pick<TessellationSettings, 'keepFailing'>>) => !!s.keepFailing && usesCadio(s);

/**
 * The healing the settings ask for, as a key: '' for none (heal off, or an older recording's settings without it),
 * else the fixes on, in HEAL_FIXES's order, then the fit tolerance where it isn't the default (absent in an older
 * recording's).
 */
export function healingOf(s: Partial<Pick<TessellationSettings, 'heal' | 'healFixes' | 'healFit'>>): string {
  if (!s.heal) return '';
  const fixes = { ...defaultFixes(), ...s.healFixes }, fit = s.healFit ?? PCURVE_FIT_TOLERANCE;
  return HEAL_FIXES.filter((f) => fixes[f]).join(',') + (fit === PCURVE_FIT_TOLERANCE ? '' : `;fit=${fit}`);
}

/** The fallback the settings mean: none where it's the backend itself (or absent, as in an older recording). */
export function fallbackOf(s: Pick<TessellationSettings, 'backend' | 'fallback'>): Backend | undefined {
  return !s.fallback || s.fallback === 'none' || s.fallback === s.backend ? undefined : s.fallback;
}

/**
 * The level the settings make, as chooseLod is asked for it: their deflections (radians) and the smallest angle they
 * ask (minAngleOf), where they ask one.
 */
export function wantedOf(s: TessellationSettings): Deflections & { minAngle?: number } {
  const min = minAngleOf(s);
  return { ...meshDeflections(deflectionsOf(s)), ...(min !== undefined ? { minAngle: min } : {}) };
}

/** What tessellateScene takes for the settings: the profile by name, or the custom deflections (in radians). */
export function deflectionsOf(s: TessellationSettings): { profile: MeshProfile } | { linearDeflection: number;
  angularDeflection: number } {
  return s.profile !== 'custom' ? { profile: s.profile } : { linearDeflection: s.linearDeflection,
    angularDeflection: s.angularDeflection * Math.PI / 180 };
}

export const CACHE_NAME = 'cad-viewer';

/** What describe() adds to the backend's name while tess-cadio keeps the faces it would fail. */
export const KEPT_FAILING = '(debugging: tess-cadio keeps the faces it would fail)';

const BACKENDS: Record<Backend, { module: string; export: string }> = {
  occt: { module: 'tess-occt', export: 'OcctTessellator' },
  truck: { module: 'tess-truck', export: 'TruckTessellator' },
  smlib: { module: 'tess-smlib', export: 'SmlibTessellator' },
  cadio: { module: 'tess-cadio', export: 'CadioTessellator' },
};

/**
 * Workers: one less than the cores, at most 8; at most 3 on phones and tablets (device.ts: they have less memory, and
 * each worker holds its own backend heap).
 */
export function workerCount(device: DeviceClass, cores = navigator.hardwareConcurrency || 2): number {
  return Math.max(1, Math.min(cores - 1, device === 'desktop' ? 8 : 3));
}

/** tess-cadio's ceiling on a face's triangles on phones and tablets (they have less memory); desktops its own. */
export const MOBILE_CAP_CEILING = 2e6;

/** The capCeiling the device asks, or none for tess-cadio's default. */
export function capCeilingOf(device: DeviceClass): number | undefined {
  return device === 'desktop' ? undefined : MOBILE_CAP_CEILING;
}

export class Tessellation {
  private current?: { key: string; tess: Tessellator; pool: PoolTessellator; caches: CachedTessellator[];
    debug: boolean };
  /** Pools made so far. */
  private pools = 0;

  /**
   * A tessellator for the settings, ready (its workers started), with `workers` workers (the page's workerCount: this
   * runs in the model worker, which can't see the screen); `pool` the backend's, whose workers also heal.
   */
  async get(s: TessellationSettings, workers: number): Promise<{ tess: Tessellator; workers: number;
    pool: Pick<PoolTessellator, 'run'> }> {
    // (A new pool for another timeout too: a pool's is fixed.)
    const timeout = s.timeout ?? DEFAULT_TIMEOUT;
    const fallback = fallbackOf(s);
    const debug = keepsFailing(s);
    const key = `${s.backend}:${fallback ?? 'none'}:${s.cache}:${workers}:${timeout}:${debug}:${s.capCeiling ?? ''}`;
    if (this.current?.key !== key) {
      this.dispose();
      const store = s.cache ? new IndexedDbStore({ name: CACHE_NAME }) : undefined;
      const caches: CachedTessellator[] = [];
      const make = (b: Backend) => {
        const kept = debug && b === 'cadio';
        const options = b !== 'cadio' ? undefined : { ...(kept ? KEEP_FAILING : {}),
          ...(s.capCeiling !== undefined ? { capCeiling: s.capCeiling } : {}) };
        const pool = new PoolTessellator(
          () => webWorkerHandle(new Worker(new URL('./tess-worker.ts', import.meta.url), { type: 'module' })),
          { backend: { ...BACKENDS[b], ...(options && Object.keys(options).length ? { options } : {}) }, workers,
            timeoutMs: Math.max(0, timeout) * 1000 });
        // (Every backend here takes models, which StepTessellator passes through, adding the open-edge error and the
        // oracle's areas; OCCT's STEP route would get them written as STEP. After the cache, which keys on the model.)
        const step = new StepTessellator(pool);
        const cached = store && !kept ? new CachedTessellator(step, store) : undefined;
        if (cached) caches.push(cached);
        return { pool, tess: cached ?? step };
      };
      const first = make(s.backend);
      const tess = fallback ? new FallbackTessellator(first.tess, make(fallback).tess) : first.tess;
      this.current = { key, tess, pool: first.pool, caches, debug };
      this.pools++;
      try {
        await tess.init();
      } catch (e) {
        this.dispose();
        throw e;
      }
    }
    return { tess: this.current!.tess, workers: this.current!.pool.workers, pool: this.current!.pool };
  }

  /**
   * The backend's name and version (and the fallback's), the cache's counts (if it's on: both backends' summed) and
   * the times new pools were made, once a pool exists.
   */
  describe(): { backend: string; cache?: CacheStats; pools: number } | undefined {
    const c = this.current;
    if (!c) return undefined;
    const backend = `${c.tess.info.name} ${c.tess.info.version}${c.debug ? ` ${KEPT_FAILING}` : ''}`;
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
