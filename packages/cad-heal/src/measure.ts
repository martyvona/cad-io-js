// How a coedge's p-curve given by the source stands against its edge's curve, measured on cad-geom's queries
// (sampled, not bounded: SAMPLES parameters across the edge's range). In the order the pass needs them, each step only
// where the one before fails: the same parameter (the p-curve at t through the surface against the curve at t, the
// model's rule: brep-reference.md, "coedge"); an affine map of the edge's range onto the p-curve's own; the image
// (each way: the p-curve's points from the curve, the curve's from the p-curve's points). The tolerance the edge is
// judged by is tolerance.h's rule, as the face API's.

import { type BrepData, rowCount } from 'cad-brep';
import type { Geometry } from 'cad-geom';

/** Parameters sampled across a range (both ends included). */
export const SAMPLES = 33;

/** tolerance.h's rule: the largest of the part's uncertainty (1e-5 mm where it gives none), the row's own and 1e-9 x
 * the part's size (its vertices' box diagonal). */
export function tolerances(d: BrepData) {
  const nv = rowCount(d, 'vertex'), p = d.vertex.point;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < 3 * nv; i++) lo[i % 3] = Math.min(lo[i % 3]!, p[i]!), hi[i % 3] = Math.max(hi[i % 3]!, p[i]!);
  const size = nv ? Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!) : 0;
  const unc = d.part.uncertainty[0]!, part = Math.max(Number.isFinite(unc) ? unc : 1e-5, 1e-9 * size);
  const widen = (t: number) => Number.isFinite(t) && t > part ? t : part;
  return { part, size, lo, hi, edge: (e: number) => widen(d.edge.tolerance[e]!),
    vertex: (v: number) => widen(d.vertex.tolerance[v]!) };
}

/** The edge's curve parameters at its start and end as the face API derives them (cad-geom's edgeParams, so the
 * pass and every consumer of the face API agree on them), or undefined. */
export function edgeRange(g: Geometry, e: number): [number, number] | undefined {
  const r = g.edgeParams(e);
  return r.status === 'ok' && Number.isFinite(r.t0) && Number.isFinite(r.t1) && r.t0 !== r.t1 ? [r.t0, r.t1]
    : undefined;
}

const dist = (a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) =>
  Math.hypot(a[i]! - b[j]!, a[i + 1]! - b[j + 1]!, a[i + 2]! - b[j + 2]!);

function segDist(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number) {
  const k = j + 3, dx = b[k]! - b[j]!, dy = b[k + 1]! - b[j + 1]!, dz = b[k + 2]! - b[j + 2]!;
  const px = a[i]! - b[j]!, py = a[i + 1]! - b[j + 1]!, pz = a[i + 2]! - b[j + 2]!;
  const l2 = dx * dx + dy * dy + dz * dz, t = l2 > 0 ? Math.max(0, Math.min(1, (px * dx + py * dy + pz * dz) / l2)) : 0;
  return Math.hypot(px - t * dx, py - t * dy, pz - t * dz);
}

/**
 * A coedge's p-curve (its own row) through its face's surface at the parameters `s`, (u, v) taken onto the row's
 * domain where rounding puts them past and wrapped by the face's periods where further: x, y, z triples, or undefined
 * where an evaluation fails.
 */
export function pcurveImage(g: Geometry, d: BrepData, c: number, surface: number, s: number[],
  periodsOf: () => [number, number] = () => [0, 0]): Float64Array | undefined {
  return imageOf(g, d.coedge.pcurve[c]!, surface, periodsOf)(s);
}

function imageOf(g: Geometry, pc: number, surface: number, periodsOf: () => [number, number]) {
  const own = g.curveInfo(pc), si = g.surfaceInfo(surface);
  const near = (x: number, lo: number, hi: number) => {
    const sl = Number.isFinite(hi - lo) ? 1e-9 * (hi - lo) : 0;
    return x < lo && x >= lo - sl ? lo : x > hi && x <= hi + sl ? hi : x;
  };
  const wrap = (x: number, [lo, hi]: [number, number], period: number) => period > 0 && (x < lo || x > hi)
    ? x - period * Math.floor((x - lo) / period) : near(x, lo, hi);
  return (s: number[]) => {
    const p = g.evalCurve(pc, s.map((x) => near(x, own.lo, own.hi)), 0);
    if (p.status !== 'ok' || p.statuses.some((x) => x !== 0)) return undefined;
    // The face's periods only where a point is past the row's domain by more than rounding.
    const uv: number[] = [];
    let outside = false;
    for (let i = 0; i < s.length; i++) {
      const u = near(p.values[3 * i]!, ...si.u), v = near(p.values[3 * i + 1]!, ...si.v);
      outside ||= u < si.u[0] || u > si.u[1] || v < si.v[0] || v > si.v[1];
      uv.push(u, v);
    }
    if (outside) {
      const [pu, pv] = periodsOf();
      for (let i = 0; i < uv.length; i += 2) uv[i] = wrap(uv[i]!, si.u, pu), uv[i + 1] = wrap(uv[i + 1]!, si.v, pv);
    }
    const q = g.evalSurface(surface, uv, 0);
    return q.status === 'ok' && !q.statuses.some((x) => x !== 0) ? q.values : undefined;
  };
}

export type GivenFit =
  /** Within tol at the same parameter. */
  | { kind: 'same'; deviation: number }
  /** Within tol where the p-curve's parameter is s = a t + b. */
  | { kind: 'affine'; a: number; b: number; deviation: number }
  /** Neither: `deviation` the image's, the larger of the two ways (NaN where it couldn't be measured); `ends` the
   * p-curve's ends from the edge's vertices (its points nearest them, as the face API's range takes them). */
  | { kind: 'off'; deviation: number; ends: number }
  | { kind: 'unmeasured'; why: string };

/**
 * A coedge's given p-curve against its edge's curve over `range` (the edge's parameters at start and end),
 * `travelsOf` candidates for the p-curve's own parameters at the use's ends (the image measured on the last), `surface`
 * its face's surface row, `periodsOf` its face's (u, v) periods as the face API finds them (0: none); both asked only
 * where needed.
 */
export function measureGiven(g: Geometry, d: BrepData, c: number, surface: number, range: [number, number],
  travelsOf: () => Iterable<[number, number]>, tol: number, periodsOf: () => [number, number] = () => [0, 0]):
  GivenFit {
  const e = d.coedge.edge[c]!, ci = d.edge.curve[e]!;
  const [t0, t1] = range, ts = Array.from({ length: SAMPLES }, (_, i) => t0 + (t1 - t0) * i / (SAMPLES - 1));
  const C = g.evalCurve(ci, ts, 0);
  if (C.status !== 'ok' || C.statuses.some((s) => s !== 0)) return { kind: 'unmeasured', why: 'curve' };
  // The p-curve's own row, evaluated whether or not the face API takes the face (it refuses faces whose p-curves'
  // ranges it can't place: often these).
  const image = imageOf(g, d.coedge.pcurve[c]!, surface, periodsOf);
  const against = (Q: Float64Array | undefined) => {
    if (!Q) return NaN;
    let w = 0;
    for (let i = 0; i < SAMPLES; i++) w = Math.max(w, dist(Q, 3 * i, C.values, 3 * i));
    return w;
  };
  const same = against(image(ts));
  if (same <= tol) return { kind: 'same', deviation: same };
  // The use's ends' parameters, by the candidates in order (the next asked only where the one before doesn't fit:
  // a candidate can cost a projection); the use's travel runs either way along the edge: both maps tried, the
  // nearer kept.
  let travel: [number, number] | undefined;
  for (const cand of travelsOf()) {
    travel = cand;
    let best: GivenFit | undefined;
    for (const [s0, s1] of [cand, [cand[1], cand[0]] as [number, number]]) {
      const a = (s1 - s0) / (t1 - t0), b = s0 - a * t0;
      const dev = against(image(ts.map((t) => a * t + b)));
      if (dev <= tol && !(best && best.kind === 'affine' && best.deviation <= dev)) {
        best = { kind: 'affine', a, b, deviation: dev };
      }
    }
    if (best) return best;
  }
  if (!travel) return { kind: 'unmeasured', why: 'no range on the p-curve' };
  // The image, both ways, over the p-curve's travel.
  const ss = Array.from({ length: SAMPLES }, (_, i) => travel[0] + (travel[1] - travel[0]) * i / (SAMPLES - 1));
  const P = image(ss);
  if (!P) return { kind: 'unmeasured', why: 'p-curve' };
  const lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  const inv = g.invertCurve(ci, P, lo, hi, tol);
  let forward = 0;
  for (const x of inv.distance) forward = Math.max(forward, Number.isFinite(x) ? x : Infinity);
  let back = 0;
  for (let i = 0; i < SAMPLES; i++) {
    let near = Infinity;
    for (let j = 0; j + 1 < SAMPLES; j++) near = Math.min(near, segDist(C.values, 3 * i, P, 3 * j));
    back = Math.max(back, near);
  }
  // The polyline's own error: its chords' midpoints off the image.
  const mids = image(ss.slice(1).map((s, i) => (s + ss[i]!) / 2));
  let chord = 0;
  if (mids) for (let j = 0; j + 1 < SAMPLES; j++) chord = Math.max(chord, segDist(mids, 3 * j, P, 3 * j));
  back = Math.max(0, back - chord);
  const vs = [d.edge.start[e]!, d.edge.end[e]!];
  let ends = NaN;
  if (vs[0]! >= 0 && vs[1]! >= 0) {
    const n = 3 * (SAMPLES - 1), pt = d.vertex.point, A = 3 * vs[0]!, B = 3 * vs[1]!;
    ends = Math.min(Math.max(dist(P, 0, pt, A), dist(P, n, pt, B)), Math.max(dist(P, 0, pt, B), dist(P, n, pt, A)));
  }
  return { kind: 'off', deviation: Math.max(forward, back), ends };
}
