// Faces' outlines from the STEP file itself (the user, 2026-10-28): where a face failed to mesh, or a whole part did
// (an error, or a timeout, whatever the backend), a viewer can still show where its faces are, drawn from their
// edges. Each face's bounds (FACE_BOUND, FACE_OUTER_BOUND) give its loops: an EDGE_LOOP's edges (EDGE_CURVE, through
// ORIENTED_EDGE), each a polyline along its curve between its vertices, or a POLY_LOOP's polygon. Curves by ISO
// 10303-42's definitions: lines; circles and ellipses (an AXIS2_PLACEMENT_3D's x and y, the point at angle t
// x cos t + y sin t, scaled by the semi-axes); B-splines with knots, rational or not (de Boor's algorithm, Piegl and
// Tiller), and Bezier curves; polylines; a surface curve's or seam curve's 3D curve, a trimmed curve's basis. Anything
// else is a straight segment between the edge's vertices. Approximate: these are for finding a face, not meshing it.

import { math, placement, point, type Reader, type Vec3 } from 'step-parser';

export interface OutlineOptions {
  /** Maximum distance between a polyline and its curve, in the part's units (conics; B-splines are sampled). */
  linearDeflection: number;
  /** Maximum angle a polyline's segment turns through on a conic, radians. */
  angularDeflection: number;
}

export interface FaceOutlines {
  /** Polylines, minus the part's origin, all concatenated. */
  positions: Float32Array;
  /** One per edge (or polygon) of a face: the face's id, and its points in `positions`. */
  outlines: { source: number; start: number; count: number }[];
}

const { dot, sub } = math;
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const times = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** At most this many points a curve. */
const MAX_POINTS = 512;

/** A VERTEX_POINT's position. */
function vertex(r: Reader, v: number): Vec3 | undefined {
  return point(r, r.ref(v, 'vertex_geometry'));
}

/** Points along a conic (circle, ellipse) from s to e, in its parametric sense or against it; full if s is e. */
function conic(r: Reader, c: number, s: Vec3, e: Vec3, forward: boolean, o: OutlineOptions): Vec3[] | undefined {
  const m = placement(r, r.ref(c, 'position'));
  const a = r.num(c, r.is(c, 'CIRCLE') ? 'radius' : 'semi_axis_1');
  const b = r.num(c, r.is(c, 'CIRCLE') ? 'radius' : 'semi_axis_2');
  if (!m || !a || !b || a <= 0 || b <= 0) return undefined;
  const x: Vec3 = [m[0]!, m[1]!, m[2]!], y: Vec3 = [m[4]!, m[5]!, m[6]!], c0: Vec3 = [m[12]!, m[13]!, m[14]!];
  const angle = (p: Vec3) => Math.atan2(dot(sub(p, c0), y) / b, dot(sub(p, c0), x) / a);
  const t0 = angle(s), t1 = angle(e);
  const turn = (d: number) => { const t = d % (2 * Math.PI); return t <= 1e-9 ? t + 2 * Math.PI : t; };
  // The edge runs from s to e increasing t when forward, decreasing otherwise; a closed edge goes all the way round.
  const closed = dist(s, e) <= 1e-9 * Math.max(a, b);
  const span = closed ? (forward ? 2 * Math.PI : -2 * Math.PI) : forward ? turn(t1 - t0) : -turn(t0 - t1);
  const big = Math.max(a, b);
  const step = Math.min(o.angularDeflection, o.linearDeflection < big ? 2 * Math.acos(1 - o.linearDeflection / big)
    : Math.PI / 2);
  const n = Math.min(MAX_POINTS, Math.max(2, Math.ceil(Math.abs(span) / step)));
  const out: Vec3[] = [];
  for (let k = 0; k <= n; k++) {
    const t = t0 + span * k / n;
    out.push(add(c0, add(times(x, a * Math.cos(t)), times(y, b * Math.sin(t)))));
  }
  out[0] = s;
  out[n] = e;
  return out;
}

/** A B-spline's evaluator: control points, weights (1 if not rational), the full knot vector, its degree. */
function bspline(r: Reader, c: number): { at: (t: number) => Vec3; lo: number; hi: number; poles: Vec3[] } |
  undefined {
  const p = r.num(c, 'degree');
  const poles = r.refs(c, 'control_points_list').map((q) => point(r, q));
  if (p === undefined || p < 1 || poles.length < p + 1 || poles.some((q) => !q)) return undefined;
  const P = poles as Vec3[];
  let knots: number[];
  if (r.is(c, 'B_SPLINE_CURVE_WITH_KNOTS')) {
    const mults = numbers(r, c, 'knot_multiplicities'), ks = numbers(r, c, 'knots');
    if (!mults || !ks || mults.length !== ks.length) return undefined;
    knots = ks.flatMap((k, i) => Array<number>(mults[i]!).fill(k));
  } else if (r.is(c, 'BEZIER_CURVE')) {
    knots = [...Array<number>(p + 1).fill(0), ...Array<number>(p + 1).fill(1)];
  } else return undefined;
  if (knots.length !== P.length + p + 1) return undefined;
  const w = r.is(c, 'RATIONAL_B_SPLINE_CURVE') ? numbers(r, c, 'weights_data') : undefined;
  const W = w && w.length === P.length ? w : P.map(() => 1);
  const lo = knots[p]!, hi = knots[P.length]!;
  const at = (t: number): Vec3 => {
    // The span holding t, then de Boor's triangle on homogeneous points.
    let k = p;
    while (k < P.length - 1 && t >= knots[k + 1]!) k++;
    const d = Array.from({ length: p + 1 }, (_, j) => { const q = P[k - p + j]!, wt = W[k - p + j]!;
      return [q[0] * wt, q[1] * wt, q[2] * wt, wt]; });
    for (let level = 1; level <= p; level++) {
      for (let j = p; j >= level; j--) {
        const i = k - p + j;
        const den = knots[i + p + 1 - level]! - knots[i]!;
        const al = den === 0 ? 0 : (t - knots[i]!) / den;
        d[j] = d[j]!.map((v, n) => (1 - al) * d[j - 1]![n]! + al * v);
      }
    }
    const h = d[p]!;
    return [h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!];
  };
  return { at, lo, hi, poles: P };
}

function numbers(r: Reader, p: number, name: string): number[] | undefined {
  const v = r.attr(p, name);
  if (!v) return undefined;
  if (v.k === 'reals' || v.k === 'ints') return Array.from(v.v as ArrayLike<number>);
  if (v.k !== 'list') return undefined;
  const out: number[] = [];
  for (const e of v.v) {
    let x: typeof e | undefined = e;
    while (x?.k === 'typed') x = x.v;
    if (x?.k === 'real') out.push(x.v);
    else if (x?.k === 'int') out.push(Number(x.v));
    else return undefined;
  }
  return out;
}

/** Points along a B-spline from s to e (each found as the nearest of dense samples), in its sense or against it. */
function spline(r: Reader, c: number, s: Vec3, e: Vec3, forward: boolean): Vec3[] | undefined {
  const b = bspline(r, c);
  if (!b) return undefined;
  const samples = Math.min(4096, Math.max(64, b.poles.length * 16));
  const ts = Array.from({ length: samples + 1 }, (_, k) => b.lo + (b.hi - b.lo) * k / samples);
  const pts = ts.map(b.at);
  const nearest = (q: Vec3) => {
    let best = 0;
    for (let k = 1; k < pts.length; k++) if (dist(pts[k]!, q) < dist(pts[best]!, q)) best = k;
    return best;
  };
  // Along the curve's own sense from where the edge's curve-wise start is to its end: from e to s against it.
  const [from, to] = forward ? [nearest(s), nearest(e)] : [nearest(e), nearest(s)];
  const closed = dist(b.poles[0]!, b.poles.at(-1)!) <= 1e-9 * Math.max(1, dist(b.poles[0]!, b.poles[1]!));
  const run: number[] = [];
  if (to > from) for (let k = from; k <= to; k++) run.push(k);
  else if (closed) {
    // Round past the curve's end (a whole loop when the edge's ends coincide).
    for (let k = from; k <= samples; k++) run.push(k);
    for (let k = 1; k <= (to === from ? from : to); k++) run.push(k);
  } else for (let k = from; k >= to; k--) run.push(k);
  // Thinned to at most MAX_POINTS, keeping the ends.
  const keep = Math.max(1, Math.ceil(run.length / MAX_POINTS));
  const out = run.filter((_, i) => i % keep === 0 || i === run.length - 1).map((k) => pts[k]!);
  if (!forward) out.reverse();
  out[0] = s;
  out[out.length - 1] = e;
  return out;
}

/** An edge's points from its start vertex to its end along its curve. */
function curvePoints(r: Reader, c: number, s: Vec3, e: Vec3, forward: boolean, o: OutlineOptions, depth = 0):
  Vec3[] {
  if (depth < 4 && r.is(c, 'SURFACE_CURVE')) return curvePoints(r, r.ref(c, 'curve_3d'), s, e, forward, o, depth + 1);
  if (depth < 4 && r.is(c, 'TRIMMED_CURVE')) return curvePoints(r, r.ref(c, 'basis_curve'), s, e, forward, o,
    depth + 1);
  if (r.is(c, 'CIRCLE') || r.is(c, 'ELLIPSE')) return conic(r, c, s, e, forward, o) ?? [s, e];
  if (r.is(c, 'B_SPLINE_CURVE')) return spline(r, c, s, e, forward) ?? [s, e];
  if (r.is(c, 'POLYLINE')) {
    const pts = r.refs(c, 'points').map((q) => point(r, q));
    if (pts.length >= 2 && pts.every((q) => q)) return forward ? pts as Vec3[] : (pts as Vec3[]).reverse();
  }
  return [s, e];
}

/**
 * The outlines of the faces among `faces` (positions in the bound model) whose ids `only` holds (all if absent), in
 * the part's coordinates minus its origin.
 */
export function faceOutlines(r: Reader, faces: readonly number[], origin: Vec3, o: OutlineOptions,
  only?: ReadonlySet<number>): FaceOutlines {
  const flat: number[] = [];
  const outlines: FaceOutlines['outlines'] = [];
  const push = (source: number, pts: readonly Vec3[]) => {
    if (pts.length < 2) return;
    outlines.push({ source, start: flat.length / 3, count: pts.length });
    for (const q of pts) flat.push(q[0] - origin[0], q[1] - origin[1], q[2] - origin[2]);
  };
  for (const f of faces) {
    const id = r.id(f);
    if (only && !only.has(id)) continue;
    const seen = new Set<number>();
    for (const bound of r.refs(f, 'bounds')) {
      const loop = r.ref(bound, 'bound');
      if (r.is(loop, 'POLY_LOOP')) {
        const pts = r.refs(loop, 'polygon').map((q) => point(r, q));
        if (pts.length >= 2 && pts.every((q) => q)) push(id, [...pts as Vec3[], pts[0]!]);
        continue;
      }
      if (!r.is(loop, 'EDGE_LOOP')) continue;
      for (const oe of r.refs(loop, 'edge_list')) {
        const edge = r.is(oe, 'ORIENTED_EDGE') ? r.ref(oe, 'edge_element') : oe;
        if (edge < 0 || seen.has(edge) || !r.is(edge, 'EDGE_CURVE')) continue;
        seen.add(edge);
        const s = vertex(r, r.ref(edge, 'edge_start')), e = vertex(r, r.ref(edge, 'edge_end'));
        if (!s || !e) continue;
        const sense = r.attr(edge, 'same_sense');
        const forward = !(sense?.k === 'enum' && sense.v === 'F');
        push(id, curvePoints(r, r.ref(edge, 'edge_geometry'), s, e, forward, o));
      }
    }
  }
  return { positions: Float32Array.from(flat), outlines };
}
