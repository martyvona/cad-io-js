// A part's mesh as AP242 tessellated geometry (docs/brep-model.md, decision 12), as step-import's tessellated.ts reads
// it: each source face a TRIANGULATED_FACE (its source id kept where free, ranges of one face together), in a
// TESSELLATED_SOLID where the part is closed, else a TESSELLATED_SHELL; curves a TESSELLATED_CURVE_SET each, points
// one TESSELLATED_POINT_SET each; a TESSELLATED_SHAPE_REPRESENTATION (with accuracy parameters where the level has its
// deflections) in the part's unit. Each face has its own COORDINATES_LIST: one list for a whole part would be one
// instance, so one string, of up to millions of numbers. Positions are the mesh's plus its origin, in double
// precision. Edges aren't written: a reader takes the faces' boundaries (shared and free) where a shell has none.

import type { Lod, Mesh, Part } from 'cad-scene';
import { type Instance, makeList, type Value } from 'step-parser';
import { stepContext, type StepIds } from './geometry.ts';

export interface StepMesh {
  rootId: number;
  instances: Instance[];
  /** The representation's items, its origin placement last. */
  items: number[];
  /** Each written face's id by its source id. */
  faceIds: Map<number, number>;
  contextId: number;
}

const str = (v = ''): Value => ({ k: 'str', v });
const real = (v: number): Value => ({ k: 'real', v });
const int = (v: number): Value => ({ k: 'int', v });
const ref = (v: number): Value => ({ k: 'ref', v });
const list = (vs: Value[]): Value => makeList(vs);
const UNSET: Value = { k: 'unset' };

export interface StepMeshOptions {
  ids: StepIds;
  name?: string;
  /** The representation's id, kept if free: its source's. */
  id?: number;
  /** Faces of a B-rep the mesh is of: each face's geometric link, by its source id. */
  links?: Map<number, number>;
}

/** A level of a part as a tessellated shape representation. */
export function stepMesh(part: Part, lod: Lod, opts: StepMeshOptions): StepMesh {
  const { ids } = opts;
  const mesh: Mesh = lod.mesh;
  const out: Instance[] = [];
  const emit = (id: number, type: string, attrs: Value[]) => { out.push({ id, type, attrs }); return id; };
  const fresh = () => ids.fresh();
  const rootId = opts.id !== undefined ? ids.claim(opts.id) : fresh(), contextId = fresh();
  const o = mesh.origin;
  const coords = (xs: ArrayLike<number>, at: number[]) => emit(fresh(), 'COORDINATES_LIST', [str(), int(at.length),
    list(at.map((v) => list([0, 1, 2].map((k) => real(xs[3 * v + k]! + o[k]!)))))]);

  // Faces: the ranges of each source face together, in the order they first appear.
  const faceIds = new Map<number, number>();
  const ranges = new Map<number | null, { start: number; count: number }[]>();
  const unnamed: { start: number; count: number }[][] = [];
  for (const f of mesh.faces) {
    if (!f.count) continue;
    if (f.source === null) { unnamed.push([f]); continue; }
    ranges.set(f.source, [...ranges.get(f.source) ?? [], f]);
  }
  // Triangles in no face's range (a mesh without faces, from a file that has none) are a face without a source.
  const covered = [...mesh.faces].filter((f) => f.count).sort((a, b) => a.start - b.start);
  let at = 0;
  for (const f of [...covered, { start: mesh.indices.length, count: 0 }]) {
    if (f.start > at) unnamed.push([{ start: at, count: f.start - at }]);
    at = Math.max(at, f.start + f.count);
  }
  const faces: number[] = [];
  const face = (source: number | null, rs: { start: number; count: number }[]) => {
    const local = new Map<number, number>(), used: number[] = [];
    const tris: Value[] = [];
    for (const r of rs) for (let t = r.start; t < r.start + r.count; t += 3) {
      const corner = (v: number) => {
        let k = local.get(v);
        if (k === undefined) { used.push(v); k = used.length; local.set(v, k); }
        return int(k);
      };
      tris.push(list([corner(mesh.indices[t]!), corner(mesh.indices[t + 1]!), corner(mesh.indices[t + 2]!)]));
    }
    const list_ = coords(mesh.positions, used);
    const n = mesh.normals;
    const normals = n ? list(used.map((v) => list([0, 1, 2].map((k) => real(n[3 * v + k]!))))) : list([]);
    const link = source !== null ? opts.links?.get(source) : undefined;
    const id = emit(ids.claim(source ?? undefined), 'TRIANGULATED_FACE', [str(), ref(list_), int(used.length),
      normals, link !== undefined ? ref(link) : UNSET, list([]), list(tris)]);
    if (source !== null && !faceIds.has(source)) faceIds.set(source, id);
    faces.push(id);
  };
  for (const [source, rs] of ranges) face(source, rs);
  for (const rs of unnamed) face(null, rs);

  const items: number[] = [];
  if (faces.length) {
    items.push(part.closed ? emit(fresh(), 'TESSELLATED_SOLID', [str(part.name), list(faces.map(ref)), UNSET])
      : emit(fresh(), 'TESSELLATED_SHELL', [str(part.name), list(faces.map(ref)), UNSET]));
  }
  // Curves and points, one set per source.
  const strips = new Map<number | null, number[][]>();
  for (const c of mesh.curves ?? []) {
    const at = Array.from({ length: c.count }, (_, k) => c.start + k);
    strips.set(c.source, [...strips.get(c.source) ?? [], at]);
  }
  for (const [source, ss] of strips) {
    const flat = ss.flat();
    const l = coords(mesh.curvePositions!, flat);
    let k = 0;
    items.push(emit(ids.claim(source ?? undefined), 'TESSELLATED_CURVE_SET', [str(), ref(l),
      list(ss.map((s) => list(s.map(() => int(++k)))))]));
  }
  const pointsBy = new Map<number | null, number[]>();
  (mesh.pointSources ?? []).forEach((s, v) => pointsBy.set(s, [...pointsBy.get(s) ?? [], v]));
  if (mesh.points && !mesh.pointSources) {
    pointsBy.set(null, Array.from({ length: mesh.points.length / 3 }, (_, v) => v));
  }
  for (const [source, vs] of pointsBy) {
    const l = coords(mesh.points!, vs);
    items.push(emit(ids.claim(source ?? undefined), 'TESSELLATED_POINT_SET', [str(), ref(l),
      list(vs.map((_, k) => int(k + 1)))]));
  }
  const origin = emit(fresh(), 'AXIS2_PLACEMENT_3D', [str('origin'),
    ref(emit(fresh(), 'CARTESIAN_POINT', [str(), list([0, 0, 0].map(real))])),
    ref(emit(fresh(), 'DIRECTION', [str(), list([0, 0, 1].map(real))])),
    ref(emit(fresh(), 'DIRECTION', [str(), list([1, 0, 0].map(real))]))]);
  items.push(origin);
  out.push(...stepContext(ids, contextId, part.unit));
  const accuracy: Value[] = [];
  if (lod.linearDeflection !== undefined) accuracy.push({ k: 'typed', type: 'CHORDAL_DEVIATION',
    v: real(lod.linearDeflection / part.unit) });
  if (lod.angularDeflection !== undefined) accuracy.push({ k: 'typed', type: 'ANGULAR_DEVIATION',
    v: real(lod.angularDeflection) });
  const head = [str(opts.name ?? part.name), list(items.map(ref)), ref(contextId)];
  if (accuracy.length) emit(rootId, 'TESSELLATED_SHAPE_REPRESENTATION_WITH_ACCURACY_PARAMETERS', [...head,
    list(accuracy)]);
  else emit(rootId, 'TESSELLATED_SHAPE_REPRESENTATION', head);
  return { rootId, instances: out, items, faceIds, contextId };
}
