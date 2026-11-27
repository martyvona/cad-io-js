// How far a face's mesh may legitimately be over the face's area: its boundary chords' bulge past the boundary curves
// within the surface. Each boundary side (a side of the face's triangles used once, corners welded by position) is a
// chord of one of the face's edge curves; the curve's nearest points to points along the chord are offset from them
// across the chord within the surface (along n x t, n the surface's normal at the middle, t the chord's direction),
// and those offsets integrated along the chord are the segment's area between chord and curve. Only the offset across
// counts: the offset along the normal (the chord's sag into the surface) moves no area past the boundary, and is
// d-sized on any curved edge.

import { type BrepData, type CurveEvaluator, curveEvaluator, LOOP_KIND, nearestParams, normalAt,
  type SurfaceEvaluator, surfaceEvaluator } from 'cad-brep';
import type { Mesh } from './scene.ts';

type V3 = [number, number, number];

/**
 * The bulge (mm^2) of face `source`'s mesh in `mesh` (its ranges, positions plus the mesh's origin in the model's
 * frame), against model `d`'s face of that id; undefined where it can't be measured: no such face, no surface
 * evaluator, an edge of it without a curve or an evaluator, or a boundary side whose middle has no nearest curve
 * point. Pass the same `cache` for a part's faces (its evaluators).
 */
export function chordBulge(d: BrepData, mesh: Mesh, source: number, cache: BulgeCache = newBulgeCache(d)):
  number | undefined {
  const f = cache.rowOf.get(source);
  if (f === undefined) return undefined;
  const S = surfaceEvaluator(d, d.face.surface[f]!, cache.surfaces, cache.curves);
  if (!S) return undefined;
  const curves: CurveEvaluator[] = [];
  for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
    if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
    for (let k = d.loop.first[l]!; k < d.loop.first[l]! + d.loop.count[l]!; k++) {
      const c = d.edge.curve[d.coedge.edge[k]!]!;
      const ev = c >= 0 ? curveEvaluator(d, c, cache.curves) : undefined;
      if (!ev) return undefined;
      curves.push(ev);
    }
  }
  if (!curves.length) return undefined;
  const p = mesh.positions, ix = mesh.indices, o = mesh.origin;
  const ids = new Map<string, number>(), points: V3[] = [];
  const vertex = (i: number) => {
    const key = `${p[3 * i]},${p[3 * i + 1]},${p[3 * i + 2]}`;
    let v = ids.get(key);
    if (v === undefined) {
      v = points.length;
      ids.set(key, v);
      points.push([p[3 * i]! + o[0], p[3 * i + 1]! + o[1], p[3 * i + 2]! + o[2]]);
    }
    return v;
  };
  const sides = new Map<string, [number, number, number]>();
  for (const r of mesh.faces) {
    if (r.source !== source) continue;
    for (let t = r.start; t < r.start + r.count; t += 3) {
      for (let q = 0; q < 3; q++) {
        const a = vertex(ix[t + q]!), b = vertex(ix[t + (q + 1) % 3]!);
        if (a === b) continue;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const s = sides.get(key);
        if (s) s[2]++;
        else sides.set(key, [a, b, 1]);
      }
    }
  }
  let bulge = 0;
  for (const [a, b, uses] of sides.values()) {
    if (uses !== 1) continue;
    const A = points[a]!, B = points[b]!;
    const t: V3 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], L = Math.hypot(...t);
    if (!(L > 0)) continue;
    // The curve's offsets at the chord's quarter and eighth points, integrated by Simpson's rule (0 at the ends):
    // exact for a parabola, within a percent or two for a half circle, which 2/3 L s underestimates by 18%.
    let n: V3 | undefined, area = 0;
    for (let k = 1; k < SAMPLES; k++) {
      const s = k / SAMPLES, m: V3 = [A[0] + s * t[0], A[1] + s * t[1], A[2] + s * t[2]];
      const near = nearest(curves, m);
      if (!near) return undefined;
      if (k === SAMPLES / 2) {
        const uv = S.params?.(near) ?? nearestParams(S, near);
        // (No normal there, a pole or a degenerate spot: the whole offsets, an overestimate.)
        n = (uv && normalAt(S, uv[0], uv[1])) as V3 | undefined;
      }
      offsets[k] = [near[0] - m[0], near[1] - m[1], near[2] - m[2]];
    }
    const across = n && cross(n, t);
    for (let k = 1; k < SAMPLES; k++) {
      const off = offsets[k]!;
      area += (k % 2 ? 4 : 2) * (across ? Math.abs(dot(off, across)) / L : Math.hypot(...off));
    }
    bulge += area * L / (3 * SAMPLES);
  }
  return bulge;
}

/** Intervals along each boundary side (even, for Simpson's rule). */
const SAMPLES = 8;
const offsets: V3[] = new Array(SAMPLES);

/** The nearest point to `m` over `curves`, undefined where none has one. */
function nearest(curves: CurveEvaluator[], m: V3): V3 | undefined {
  let near: V3 | undefined, best = Infinity;
  for (const c of curves) {
    const u = c.param(m);
    if (u === undefined) continue;
    const x = c.point(u) as V3, dist = Math.hypot(x[0] - m[0], x[1] - m[1], x[2] - m[2]);
    if (dist < best) best = dist, near = x;
  }
  return near;
}

/** What a part's faces' chordBulge calls share. */
export interface BulgeCache {
  rowOf: Map<number, number>;
  curves: Map<number, CurveEvaluator | undefined>;
  surfaces: Map<number, SurfaceEvaluator | undefined>;
}

export function newBulgeCache(d: BrepData): BulgeCache {
  const rowOf = new Map<number, number>();
  for (let f = 0; f < d.face.id.length; f++) rowOf.set(d.face.id[f]!, f);
  return { rowOf, curves: new Map(), surfaces: new Map() };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
