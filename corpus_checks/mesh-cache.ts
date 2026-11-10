// The mesh cache a round of corpus checks shares (round.ts): when MESH_CACHE names a directory, the checks that only
// consume meshes mesh through a tess-cache file store there, so only the round's first such check meshes the corpus
// and the others read its meshes, timeouts included (a cached timeout answers while the limit is no longer). The
// checks of meshing itself never use it. Without MESH_CACHE a check meshes as it always has. MESH_CACHE_MB caps the
// store (default 32 GiB: the corpus's meshes at the checks' settings must fit, or the store evicts and re-meshes).
import { type Tessellator } from '../packages/cad-scene/src/index.ts';
import { StepTessellator } from '../packages/step-export/src/index.ts';
import { CachedTessellator, FileStore } from '../packages/tess-cache/src/node.ts';

const DEFAULT_MB = 32 * 1024;

/** The directory and size cap the round gave, or undefined outside a round. */
export function meshCacheDir(): { dir: string; mb: number } | undefined {
  const dir = process.env.MESH_CACHE;
  return dir ? { dir, mb: Number(process.env.MESH_CACHE_MB ?? DEFAULT_MB) } : undefined;
}

const made = new WeakMap<Tessellator, Tessellator>();
const caches: CachedTessellator[] = [];

/**
 * What a check meshes a scene through: `pool` behind a StepTessellator, behind the round's cache if there is one
 * (keyed on the model, as stepconv's --cache is, so stepconv's runs and the checks' share entries). One per pool.
 */
export function cachedMesher(pool: Tessellator): Tessellator {
  let t = made.get(pool);
  if (!t) {
    t = new StepTessellator(pool);
    const c = meshCacheDir();
    if (c) {
      // Other versions kept: the round clears the directory, and pruning would scan it in every process.
      const cached = new CachedTessellator(t, new FileStore({ dir: c.dir, maxBytes: c.mb * 2 ** 20 }),
        { keepOtherVersions: true });
      caches.push(cached);
      t = cached;
    }
    made.set(pool, t);
  }
  return t;
}

/** The arguments that give stepconv the round's cache (none outside a round). */
export const stepconvCacheArgs = (): string[] => {
  const c = meshCacheDir();
  return c ? ['--cache', c.dir, '--cache-size', String(c.mb)] : [];
};

/** This process's cache hits and misses on standard error (not in the log, which must not depend on the cache). */
export function reportMeshCache(): void {
  for (const c of caches) {
    const s = c.stats();
    process.stderr.write(`mesh cache (pid ${process.pid}): ${s.hits} hits (${s.failureHits} failures), `
      + `${s.misses} misses, ${s.errors} errors\n`);
  }
}
