// Areas and volumes of a model's faces by quadrature over the evaluators (geometry.ts), to check the reference facts
// with: the iterated boundary integral (Green's theorem in (u, v)), the integral over a face of g(u, v) du dv being
// the loop integral of G dv with G(u, v) the integral of g from a fixed u0 to u. With g = |S_u x S_v| that is the
// face's area, signed by the way its loops run (positive where they run counter-clockwise in (u, v), as a face whose
// sense is true has them); with g = S . (S_u x S_v) / 3 it is the face's share of its solid's volume, the face's sense
// included by the same sign. Each boundary piece is a coedge's p-curve over its range or, without one, its edge's
// curve mapped into (u, v) by the surface's closed-form inverse; a face with no loops is its domain's rectangle.

import type { BrepData } from '../../src/data.ts';
import * as dec from '../../src/decode.ts';
import { curveEvaluator, edgeParams, surfaceEvaluator, type SurfaceEvaluator } from '../../src/geometry.ts';
import { cross, dot, norm, type V } from './vec.ts';

/** Gauss-Legendre nodes and weights on [-1, 1], n points (Newton on the Legendre polynomial). */
function gauss(n: number): { x: number[]; w: number[] } {
  const x: number[] = [], w: number[] = [];
  for (let i = 0; i < n; i++) {
    let z = Math.cos(Math.PI * (i + 0.75) / (n + 0.5)), dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let k = 2; k <= n; k++) [p0, p1] = [p1, ((2 * k - 1) * z * p1 - (k - 1) * p0) / k];
      dp = n * (z * p1 - p0) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-16) break;
    }
    x.push(z);
    w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}

const G = gauss(12);

/** The integral of f over [a, b] cut at `cuts` (sorted, inside) and into `pieces` equal parts between them. */
export function quad(f: (t: number) => number, a: number, b: number, pieces = 16, cuts: number[] = []): number {
  const ends = [a, ...cuts.filter((c) => (c - a) * (c - b) < 0).sort((p, q) => (a < b ? p - q : q - p)), b];
  let sum = 0;
  for (let k = 0; k + 1 < ends.length; k++) {
    const lo = ends[k]!, hi = ends[k + 1]!, h = (hi - lo) / pieces;
    for (let j = 0; j < pieces; j++) {
      const m = lo + (j + 0.5) * h;
      for (let i = 0; i < G.x.length; i++) sum += G.w[i]! * f(m + G.x[i]! * h / 2) * h / 2;
    }
  }
  return sum;
}

/** A boundary piece in (u, v): its point and derivative at t over [a, b], and where it is less smooth. */
interface Piece {
  uv(t: number): [number, number, number, number];
  a: number;
  b: number;
  cuts: number[];
}

/** The knots of a B-spline surface in u (its kinks across which the inner integral is cut), else none. */
function uKnots(d: BrepData, s: number): number[] {
  const row = dec.surface(d, s);
  if (row.kind === 'bspline') return row.uKnots;
  if (row.kind === 'offset' || row.kind === 'rectangularTrimmed') return uKnots(d, row.basis);
  return [];
}

/** Where a curve is less smooth: knots, polyline corners, composite joints. */
export function curveCuts(d: BrepData, c: number): number[] {
  const row = dec.curve(d, c);
  if (row.kind === 'bspline') return row.knots;
  if (row.kind === 'polyline') return row.points.map((_, k) => k);
  if (row.kind === 'trimmed' || row.kind === 'offset') return curveCuts(d, row.basis);
  if (row.kind === 'composite') return row.segments.map((_, k) => k);
  return [];
}

/** The pieces of a face's boundary in (u, v), each run as its loop runs it. */
function boundary(d: BrepData, f: number, S: SurfaceEvaluator): Piece[] | undefined {
  const face = dec.face(d, f), out: Piece[] = [];
  if (!face.loops.length) {
    const [u0, u1] = S.u, [v0, v1] = S.v;
    if (![u0, u1, v0, v1].every(Number.isFinite)) return undefined;
    const side = (p: [number, number], q: [number, number]): Piece => ({ a: 0, b: 1, cuts: [],
      uv: (t) => [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1]), q[0] - p[0], q[1] - p[1]] });
    // The surface's own extent, counter-clockwise where the face's sense is true, as a loop would run.
    const ccw = [side([u0, v0], [u1, v0]), side([u1, v0], [u1, v1]), side([u1, v1], [u0, v1]), side([u0, v1],
      [u0, v0])];
    return face.sameSense ? ccw : [side([u0, v0], [u0, v1]), side([u0, v1], [u1, v1]), side([u1, v1], [u1, v0]),
      side([u1, v0], [u0, v0])];
  }
  for (const loop of face.loops) {
    if (loop.kind !== 'edge') continue;
    const first = out.length;
    for (const c of loop.coedges) {
      const e = dec.edge(d, c.edge), back = c.orientation === 'reversed';
      if (c.pcurve !== undefined) {
        const P = curveEvaluator(d, c.pcurve)!, r = c.range ?? e.range;
        if (!r) return undefined;
        const [a, b] = back ? [r[1], r[0]] : r;
        out.push({ a, b, cuts: curveCuts(d, c.pcurve), uv: (t) => {
          const p = P.point(t), q = P.d1(t);
          return [p[0]!, p[1]!, q[0]!, q[1]!];
        } });
        continue;
      }
      if (e.curve === undefined || !S.params) return undefined;
      const C = curveEvaluator(d, e.curve)!, r = edgeParams(d, c.edge, C);
      if (!r) return undefined;
      const [a, b] = back ? [r[1], r[0]] : r;
      // Mapped by the surface's inverse, the derivative by the chain rule: [S_u S_v] (u', v') = C' solved by least
      // squares (a difference quotient of the inverse loses digits far from the origin).
      out.push({ a, b, cuts: curveCuts(d, e.curve), uv: (t) => {
        const [u, v] = S.params!(C.point(t))!, [su, sv] = S.d1(u, v), c1 = C.d1(t);
        const a11 = dot(su, su), a12 = dot(su, sv), a22 = dot(sv, sv), b1 = dot(su, c1), b2 = dot(sv, c1);
        const D = a11 * a22 - a12 * a12;
        return [u, v, (a22 * b1 - a12 * b2) / D, (a11 * b2 - a12 * b1) / D];
      } });
    }
    // A loop that winds once round a period of u without closing in (u, v) bounds the face against a pole (a
    // hemisphere's equator): closed along the seam up to the pole line, where dv is 0, and back down. The pole is on
    // the face's side of the loop: the left of +u is +v.
    const s0 = out[first]?.uv(out[first]!.a), e0 = out.at(-1)?.uv(out.at(-1)!.b);
    if (s0 && e0 && S.uPeriod && Math.abs(Math.abs(e0[0] - s0[0]) - S.uPeriod) < 1e-9 * S.uPeriod
      && Math.abs(e0[1] - s0[1]) < 1e-12 && Number.isFinite(S.v[0]) && Number.isFinite(S.v[1])) {
      const vp = (e0[0] > s0[0]) === face.sameSense ? S.v[1] : S.v[0];
      const side = (u: number, va: number, vb: number): Piece => ({ a: 0, b: 1, cuts: [],
        uv: (t) => [u, va + t * (vb - va), 0, vb - va] });
      out.push(side(e0[0], e0[1], vp), side(s0[0], vp, s0[1]));
    }
  }
  return out;
}

/** The integral over face f of g(u, v) du dv, signed by its loops' direction; undefined where it can't be set up. */
export function faceIntegral(d: BrepData, f: number, g: (S: SurfaceEvaluator, u: number, v: number) => number):
  number | undefined {
  const s = dec.face(d, f).surface, S = surfaceEvaluator(d, s);
  if (!S) return undefined;
  const pieces = boundary(d, f, S);
  if (!pieces) return undefined;
  const ucuts = uKnots(d, s), u0 = Number.isFinite(S.u[0]) ? S.u[0] : 0;
  let sum = 0;
  for (const p of pieces) {
    sum += quad((t) => {
      const [u, v, , dv] = p.uv(t);
      if (dv === 0) return 0;
      return quad((x) => g(S, x, v), u0, u, 4, ucuts) * dv;
    }, p.a, p.b, 16, p.cuts);
  }
  return sum;
}

const areaElement = (S: SurfaceEvaluator, u: number, v: number) => {
  const [su, sv] = S.d1(u, v);
  return norm(cross(su, sv));
};

/** The volume element about the point c (any point: the shell is closed), c near the shape against cancellation. */
const volumeElement = (c: V) => (S: SurfaceEvaluator, u: number, v: number) => {
  const [su, sv] = S.d1(u, v), p = S.point(u, v);
  return dot(p.map((x, k) => x - c[k]!), cross(su, sv)) / 3;
};

/** A face's area (positive where its loops run as its sense says they should, negative where against). */
export function faceArea(d: BrepData, f: number): number | undefined {
  const a = faceIntegral(d, f, areaElement);
  return a === undefined ? undefined : d.face.sameSense[f] ? a : -a;
}

/** A body's volume: its shells' faces' shares (positive where their normals point out of the material). */
export function bodyVolume(d: BrepData, body: number): number | undefined {
  const b = dec.body(d, body);
  // About a point of the body: its first face's surface at the start of its domain (a vertex where that's infinite).
  const S0 = surfaceEvaluator(d, d.face.surface[d.faceUse.face[d.shell.first[b.members[0]!.ref]!]!]!)!;
  const c = Number.isFinite(S0.u[0]) && Number.isFinite(S0.v[0]) ? S0.point(S0.u[0], S0.v[0])
    : d.vertex.point.length ? Array.from(d.vertex.point.subarray(0, 3)) : [0, 0, 0];
  let sum = 0;
  for (const m of b.members) {
    const sh = dec.shell(d, m.ref);
    for (const { face } of sh.faces) {
      const v = faceIntegral(d, face, volumeElement(c));
      if (v === undefined) return undefined;
      sum += v;
    }
  }
  return sum;
}
