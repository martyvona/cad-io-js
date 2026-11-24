// A mesh face's deviation from its exact surface, sampled: cad-scene's deviation judge (its DeviationJudge, met
// structurally here: cad-geom doesn't depend on cad-scene), set by a host whose FallbackTessellator judges deviation.

import { Geometry, type GeomModule } from './index.ts';

/** What the judge reads of a B-rep model (cad-brep's BrepData): its buffer, and its faces' ids and surface rows. */
export interface JudgedModel {
  readonly buffer: ArrayBuffer;
  readonly face: { readonly id: ArrayLike<number>; readonly surface: ArrayLike<number> };
}

/** What the judge reads of a tessellation result (cad-scene's TessellationResult). */
export interface JudgedMesh {
  readonly origin: readonly [number, number, number] | ArrayLike<number>;
  readonly positions: ArrayLike<number>;
  readonly indices: ArrayLike<number>;
  readonly faces: readonly { readonly entityId: number | null; readonly start: number; readonly count: number }[];
}

/**
 * The judge on `module`: a face's (by id) triangles in a result, each's centroid and sides' middles inverted onto the
 * face's surface over its whole domain, the worst distance found (a lower bound on the face's worst: only those points,
 * and to the untrimmed surface); undefined where the face has no triangles or its surface can't be evaluated. One
 * Geometry kept, for the last model judged.
 */
export function meshDeviationJudge(module: GeomModule): {
  readonly name: string;
  worst(model: JudgedModel, r: JudgedMesh, face: number): number | undefined;
} {
  let last: { buffer: ArrayBuffer; g: Geometry } | undefined;
  const geometry = (model: JudgedModel) => {
    if (last?.buffer !== model.buffer) {
      last?.g.dispose();
      last = { buffer: model.buffer, g: new Geometry(module, model.buffer) };
    }
    return last.g;
  };
  return {
    name: 'cad-geom',
    worst(model, r, face) {
      let row = -1;
      for (let i = 0; i < model.face.id.length && row < 0; i++) if (model.face.id[i] === face) row = i;
      if (row < 0) return undefined;
      const surface = model.face.surface[row]!;
      const g = geometry(model);
      const info = g.surfaceInfo(surface);
      if (info.status !== 'ok') return undefined;
      const p = r.positions, ix = r.indices, o = r.origin;
      const points: number[] = [];
      for (const f of r.faces) {
        if (f.entityId !== face) continue;
        for (let k = f.start; k + 2 < f.start + f.count; k += 3) {
          const c = [ix[k]!, ix[k + 1]!, ix[k + 2]!].map((v) => [p[3 * v]! + o[0]!, p[3 * v + 1]! + o[1]!,
            p[3 * v + 2]! + o[2]!]);
          for (const w of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]])
            for (let a = 0; a < 3; a++) points.push(w[0]! * c[0]![a]! + w[1]! * c[1]![a]! + w[2]! * c[2]![a]!);
        }
      }
      if (!points.length) return undefined;
      const inv = g.invertSurface(surface, points, [info.u[0], info.u[1], info.v[0], info.v[1]], 1e-6);
      let worst: number | undefined;
      for (let i = 0; i < inv.statuses.length; i++)
        if (inv.statuses[i] === 0) worst = Math.max(worst ?? 0, inv.distance[i]!);
      return worst;
    },
  };
}
