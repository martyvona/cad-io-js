// A part's levels of detail (CLAUDE.md, "Decisions": the scene model, 2026-10-29): adding one, and choosing the one
// the viewer and the exporters use until they can switch levels themselves.

import { degenerateMessage, dropDegenerate } from './mesh.ts';
import type { Lod, Mesh, Part, Scene } from './scene.ts';

/** The deflections a level is wanted at: millimetres and radians. */
export interface LodWanted {
  linearDeflection?: number;
  angularDeflection?: number;
}

/** Deflections equal up to rounding (a profile's values through degrees and back). */
const same = (a: number | undefined, b: number | undefined) =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b)));

/**
 * Adds a level to a part, finest first: before the first level whose linear deflection is coarser or unstated, else
 * last; a level without one after all those with one (it can't be ranked; so the first level is the finest known,
 * ours where we tessellated). A tessellated level replaces one from the same backend at the same deflections.
 */
export function addLod(part: Part, lod: Lod): void {
  if (lod.from === 'tessellated') {
    const i = part.lods.findIndex((l) => l.from === 'tessellated' && l.backend === lod.backend &&
      same(l.linearDeflection, lod.linearDeflection) && same(l.angularDeflection, lod.angularDeflection));
    if (i >= 0) part.lods.splice(i, 1);
  }
  const d = lod.linearDeflection;
  const at = d === undefined ? -1 : part.lods.findIndex((l) => l.linearDeflection === undefined ||
    l.linearDeflection > d);
  if (at < 0) part.lods.push(lod);
  else part.lods.splice(at, 0, lod);
}

/**
 * The level to use (the user, 2026-10-29): one tessellated at the wanted deflections (the last added, of several
 * backends); else, of those with a linear deflection, the coarsest not coarser than wanted, or if all are coarser the
 * finest of them; else the finest (the first). Undefined for a part with none.
 */
export function chooseLod(part: Part, wanted: LodWanted = {}): Lod | undefined {
  const lods = part.lods;
  if (!lods.length) return undefined;
  const exact = lods.filter((l) => l.from === 'tessellated' && same(l.linearDeflection, wanted.linearDeflection) &&
    same(l.angularDeflection, wanted.angularDeflection));
  if (exact.length && wanted.linearDeflection !== undefined) return exact.at(-1);
  const w = wanted.linearDeflection;
  const known = lods.filter((l) => l.linearDeflection !== undefined);
  if (w !== undefined && known.length) {
    const finer = known.filter((l) => l.linearDeflection! <= w);
    if (finer.length) return finer.reduce((a, b) => (b.linearDeflection! > a.linearDeflection! ? b : a));
    return known.reduce((a, b) => (b.linearDeflection! < a.linearDeflection! ? b : a));
  }
  return lods[0];
}

/**
 * Drops triangles with two corners at one position (dropDegenerate) from every part's levels from the source, as
 * tessellateScene does from its own meshes: the importers' repair of the meshes files give (the user, 2026-10-30;
 * CLAUDE.md, "Decisions"), so every consumer of an imported scene gets it. Such a triangle draws nothing and holds
 * no gap closed; a codec's quantization makes them (GLBs with Draco or meshopt). Each part dropping any gets an info
 * diagnostic in the scene's. Returns the triangles dropped.
 */
export function dropSourceDegenerate(scene: Scene): number {
  // (A mesh shared between levels is repaired once.)
  const done = new Map<Mesh, { mesh: Mesh; dropped: number }>();
  let total = 0;
  for (const part of scene.parts) {
    let n = 0;
    for (const lod of part.lods ?? []) {
      if (lod.from !== 'source') continue;
      let d = done.get(lod.mesh);
      if (!d) { d = dropDegenerate(lod.mesh); done.set(lod.mesh, d); }
      lod.mesh = d.mesh;
      n += d.dropped;
    }
    if (!n) continue;
    total += n;
    const source = part.sources[0];
    scene.diagnostics.push({ severity: 'info', message: degenerateMessage(n), ...(source ? { source } : {}) });
  }
  return total;
}
