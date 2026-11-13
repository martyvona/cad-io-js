// The area oracle: a face's exact area from the B-rep model's own geometry, independent of every mesher and kernel,
// for faces on planes, cylinders, cones, spheres and tori (any edge curve the model's evaluators give: lines, conics,
// B-splines). What it covers, how it works and where it can be wrong: docs/backends.md. Backends' adapters add its
// areas to results with measures (oracleMeasures), which the judge of their meshes uses where it trusts them
// (fallback.ts); corpus_checks/area_oracle.ts runs the same integral on a STEP file's own faces, so the two checked
// against each other check the model's conversion.
//
// The method: Green's theorem in the surface's (u, v) parameters, area = oint P(v) du with dP/dv = -|S_u x S_v|.
// Each edge is sampled on its 3D curve between its vertices, each sample mapped to (u, v) in closed form, u unwrapped
// along the loop; trapezoid sums at N, 2N and 4N samples, Richardson-extrapolated from 2N and 4N.

import { type BrepData, type CurveEvaluator, curveEvaluator, decode, edgeParams, LOOP_KIND, openBrep } from
  'cad-brep';
import type { TessellationResult } from './tessellator.ts';

export type OracleSurface = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus';
/**
 * Why an area may be wrong though computed: `orientation`, the loops' signed sum was negative (loops against Part
 * 42's orientation; the absolute value is reported); `minor-winding`, a torus loop winds the minor circle (P isn't
 * periodic in v, so the seam the face then spans, which no loop runs along, would count); `no-loops`, a face with no
 * edge loops (area 0 reported).
 */
export type OracleFlag = 'orientation' | 'minor-winding' | 'no-loops' | 'off-surface' | 'sphere-side';
export interface OracleArea {
  ok: true;
  /** In the file's length unit squared. */
  area: number;
  /** The difference between the extrapolations from N, 2N and from 2N, 4N samples: a bound on `area`'s error, in
   * practice far larger than it (same unit). */
  error: number;
  /** The loops' length (seam edges twice), extrapolated as `area` is. */
  perimeter: number;
  surface: OracleSurface;
  /** The largest distance of a loop's point from the surface, over the loops' size (their box's diagonal). */
  offSurface: number;
  flags: OracleFlag[];
  /** The kinds of edge curve the face's loops use. */
  curves: string[];
}
export interface OracleUnsupported { ok: false; reason: string }
export type OracleResult = OracleArea | OracleUnsupported;

/**
 * An area to rely on: no flags, and the error estimate within `relative` of the area. (Its type says only that much:
 * an untrusted result is still an area or not, which `false` doesn't tell.)
 */
export function trustedArea(r: OracleResult, relative = 1e-6): r is OracleArea & { flags: [] } {
  return r.ok && !r.flags.length && r.error <= relative * r.area;
}

export type V3 = [number, number, number];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));
export const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const TWO_PI = 2 * Math.PI;
/** An edge's ends closer than this, relative to its curve's size, are one point (else the same vertex instance); a pole
 * or apex is within this of the axis, relative to the radius (or 1 unit). Relative to the size, not to the distance
 * from the origin: a short arc far from the origin is not a full circle. */
export const SAME_POINT = 1e-9;
/** Samples per full turn of a circle or ellipse, and per knot span of a B-spline curve, before doubling. */
export const CONIC_SAMPLES = 256, SPLINE_SPAN_SAMPLES = 64;
/** At least this many samples per curved edge, before doubling: short arcs far from the surface's origin need them. */
export const MIN_CURVED_SAMPLES = 16;
/** At most this many samples per edge, before doubling (pathological knot vectors). */
export const MAX_EDGE_SAMPLES = 200_000;
/** A loop point farther than this from the surface, relative to the loops' size, flags the face (an edge that isn't
 * on it: a file's topology error). */
export const OFF_SURFACE = 1e-2;

/** What the oracle can't compute (its message the reason): thrown inside, returned as OracleUnsupported. */
export class OracleUnsupportedError extends Error {}

export interface Surf {
  kind: OracleSurface;
  /** (u, v); u is NaN where undefined (a cone's apex, a sphere's poles). */
  uv(p: V3): [number, number];
  /** A point's distance from the surface. */
  off(p: V3): number;
  P(v: number): number;
  /** For spheres, 4 pi R^2: the area is known modulo it. */
  modulus: number;
  periodicV: boolean;
  /**
   * Planes: measure from this point (v0), so the sum doesn't cancel large terms; a constant in P adds c oint du,
   * zero on a plane but not where a loop winds around an axis.
   */
  recenter?(p: V3): void;
}

const wrap = (d: number) => d - TWO_PI * Math.round(d / TWO_PI);

/**
 * A surface's (u, v) map and integrand from its frame and numbers (angles in radians): a cylinder's or sphere's radius,
 * a cone's radius and semi-angle, a torus's major and minor radii; shared by the file's oracle and the model's.
 */
export function elementarySurf(kind: OracleSurface, F: { o: V3; x: V3; y: V3; z: V3 }, nums: number[]): Surf {
    const local = (p: V3): V3 => { const q = sub(p, F.o); return [dot(q, F.x), dot(q, F.y), dot(q, F.z)]; };
    const angle = (q: V3) => Math.atan2(q[1], q[0]);
    if (kind === 'plane') {
      let v0 = 0;
      return { kind: 'plane', modulus: 0, periodicV: false, uv: (p) => { const q = local(p); return [q[0], q[1]]; },
        off: (p) => Math.abs(local(p)[2]), P: (v) => -(v - v0), recenter: (p) => { v0 = local(p)[1]; } };
    }
    if (kind === 'cylinder') {
      const r = nums[0]!;
      return { kind: 'cylinder', modulus: 0, periodicV: false,
        uv: (p) => { const q = local(p); return [angle(q), q[2]]; },
        off: (p) => { const q = local(p); return Math.abs(Math.hypot(q[0], q[1]) - r); }, P: (v) => -r * v };
    }
    if (kind === 'cone') {
      // rho(v) = r + v tan(a); dA = |rho| / cos(a) du dv; P = -rho |rho| / (2 sin a), zero at the apex.
      const r = nums[0]!, a = nums[1]!;
      const t = Math.tan(a), s = Math.sin(a);
      if (Math.abs(s) < 1e-15) throw new OracleUnsupportedError('cone with zero semi-angle');
      return { kind: 'cone', modulus: 0, periodicV: false,
        // (The apex where within SAME_POINT of the axis relative to the cone's extent from its origin to its apex: a
        // thin cone's radius at v = 0 is no scale for its points, which miss the apex by its length's last digits.)
        uv: (p) => { const q = local(p);
          return [Math.hypot(q[0], q[1]) < SAME_POINT * (1 + Math.abs(r) + Math.abs(r / t)) ? NaN : angle(q), q[2]]; },
        // Both nappes (rho either sign): the nearer of the two generators in the point's half-plane, z from the apex.
        off: (p) => { const q = local(p), h = Math.hypot(q[0], q[1]), z = q[2] + r / t, c = Math.cos(a);
          return Math.min(Math.abs(h * c - z * s), Math.abs(h * c + z * s)); },
        P: (v) => { const rho = r + v * t; return -(rho * Math.abs(rho)) / (2 * s); } };
    }
    if (kind === 'sphere') {
      // dA = R^2 cos v du dv; P = -R^2 (sin v - 1), zero at the north pole.
      const R = nums[0]!;
      return { kind: 'sphere', modulus: 4 * Math.PI * R * R, periodicV: false,
        uv: (p) => { const q = local(p); const rho = Math.hypot(q[0], q[1]);
          return [rho < SAME_POINT * R ? NaN : angle(q), Math.atan2(q[2], rho)]; },
        off: (p) => Math.abs(Math.hypot(...local(p)) - R), P: (v) => -R * R * (Math.sin(v) - 1) };
    }
    // Torus: dA = r (R + r cos v) du dv; P = -r (R v + r sin v).
    const R = nums[0]!, r = nums[1]!;
    if (r >= R) throw new OracleUnsupportedError('degenerate torus');
    return { kind: 'torus', modulus: 0, periodicV: true,
      uv: (p) => { const q = local(p); return [angle(q), Math.atan2(q[2], Math.hypot(q[0], q[1]) - R)]; },
      off: (p) => { const q = local(p); return Math.abs(Math.hypot(Math.hypot(q[0], q[1]) - R, q[2]) - r); },
      P: (v) => -r * (R * v + r * Math.sin(v)) };
}

/**
 * oint P(v) du over a loop's points (closed: the last joins the first). Through a pole or apex (u undefined) the
 * path runs along it in the parameter plane: P(v_pole) times the jump in u. P is zero at a cone's apex and a sphere's
 * north pole, so the jump's ambiguity by 2 pi matters only at a sphere's south pole, where it changes the sum by
 * 4 pi R^2: the caller reduces spheres modulo that.
 */
function loopIntegral(S: Surf, pts: V3[], flags: Set<OracleFlag>): number {
  const uv = pts.map((p) => S.uv(p));
  const first = uv.findIndex((x) => !Number.isNaN(x[0]));
  if (first < 0) return 0;
  const periodicU = S.kind !== 'plane';
  let sum = 0, windV = 0, pv = uv[first]![1], prev = uv[first]!;
  let pole: number | undefined;
  for (let k = 1; k <= uv.length; k++) {
    const cur = uv[(first + k) % uv.length]!;
    if (Number.isNaN(cur[0])) { pole = cur[1]; continue; }
    const du = periodicU ? wrap(cur[0] - prev[0]) : cur[0] - prev[0];
    if (pole !== undefined) {
      sum += S.P(pole) * du;
      pole = undefined;
      pv = cur[1]; prev = cur;
      continue;
    }
    const dv = S.periodicV ? wrap(cur[1] - prev[1]) : cur[1] - prev[1];
    const nv = pv + dv;
    sum += ((S.P(pv) + S.P(nv)) / 2) * du;
    windV += dv;
    pv = nv; prev = cur;
  }
  if (S.periodicV && Math.abs(windV) > Math.PI) flags.add('minor-winding');
  return sum;
}

export type OracleLoop = { edges: { sample: (n: number) => V3[]; forward: boolean }[]; forward: boolean };

/** A face's area and perimeter from its surface and loops, extrapolated from 1, 2 and 4 times the samples. */
export function faceIntegral(S: Surf, same: boolean, loops: OracleLoop[], curves: Set<string>): OracleArea {
  const flags = new Set<OracleFlag>();
  if (!loops.length) flags.add('no-loops');
  const firstEdge = loops[0]?.edges[0];
  if (S.recenter && firstEdge) S.recenter(firstEdge.sample(1)[0]!);
  let off = 0;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const total = (n: number): [number, number] => {
    let s = 0, len = 0;
    for (const L of loops) {
      let pts: V3[] = [];
      for (const e of L.edges) {
        const p = e.sample(n);
        if (!e.forward) p.reverse();
        for (let i = 0; i < p.length - 1; i++) pts.push(p[i]!);
      }
      if (!L.forward) pts = pts.reverse();
      s += loopIntegral(S, pts, flags);
      for (const p of pts) {
        off = Math.max(off, S.off(p));
        for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i]!, p[i]!); hi[i] = Math.max(hi[i]!, p[i]!); }
      }
      for (let i = 0; i < pts.length; i++) len += dist(pts[i]!, pts[(i + 1) % pts.length]!);
    }
    return [same ? s : -s, len];
  };
  const [a1] = total(1), [a2, l2] = total(2), [a4, l4] = total(4);
  const r12 = (4 * a2 - a1) / 3, r24 = (4 * a4 - a2) / 3;
  let area = r24;
  if (S.modulus) {
    area = ((area % S.modulus) + S.modulus) % S.modulus;
    // A sphere's loops bound a face and its complement alike; reduced modulo the sphere, the area is the face's only
    // where its loops run as Part 42 has them, which nothing here can check (a file's loop the other way gives the
    // complement). Over a hemisphere it's flagged: the smaller side is the more likely face.
    if (area > (S.modulus / 2) * (1 + 1e-9)) flags.add('sphere-side');
  }
  else if (area < 0) { flags.add('orientation'); area = -area; }
  const size = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const offSurface = loops.length ? off / Math.max(size, 1e-300) : 0;
  if (offSurface > OFF_SURFACE) flags.add('off-surface');
  return { ok: true, area, error: Math.abs(r24 - r12), perimeter: (4 * l4 - l2) / 3, surface: S.kind, offSurface,
    flags: [...flags], curves: [...curves].sort() };
}

/** What modelFaceArea keeps between a part's faces, and how densely it samples. */
export interface OracleOptions {
  curves?: Map<number, CurveEvaluator | undefined>;
  params?: Map<number, [number, number] | undefined>;
  /**
   * Scales the samples per curved edge (1, the default: the corpus checks'); fewer are faster, and the error estimate
   * grows with them, so fewer areas are trusted at a given relative error.
   */
  density?: number;
}

/**
 * The area of a face of the B-rep model (face row `f`), or why it can't be computed: the model's surface and edges,
 * sampled through cad-brep's evaluators and `edgeParams` as corpus_checks/area_oracle.ts samples a STEP file's own,
 * then the same integral. On a model converted from a STEP file it gives the file's oracle's area
 * (corpus_checks/area_model.ts), so a difference is the conversion's or the evaluators'. The five elementary surfaces;
 * lines, circles, ellipses, B-splines and trimmed curves of them as edge curves. Rely on an area only if `trustedArea`.
 * For a part's faces, pass the same `opts` maps to each call (they keep what its faces share: curves' evaluators, and
 * edges' parameters at their vertices, by row).
 */
export function modelFaceArea(d: BrepData, f: number, opts: OracleOptions = {}): OracleResult {
  try {
    return modelFace(d, f, opts.curves ?? new Map(), opts.params ?? new Map(), opts.density ?? 1);
  } catch (e) {
    if (e instanceof OracleUnsupportedError) return { ok: false, reason: e.message };
    throw e;
  }
}

function modelFace(d: BrepData, f: number, cache: Map<number, CurveEvaluator | undefined>,
  params: Map<number, [number, number] | undefined>, scale: number): OracleArea {
  const s = decode.surface(d, d.face.surface[f]!);
  if (s.kind !== 'plane' && s.kind !== 'cylinder' && s.kind !== 'cone' && s.kind !== 'sphere' && s.kind !== 'torus') {
    throw new OracleUnsupportedError(s.kind);
  }
  const { origin, axis, xDir } = s.position;
  const F = { o: origin as V3, x: xDir as V3, y: cross(axis as V3, xDir as V3), z: axis as V3 };
  if (s.kind === 'torus' && s.selectOuter !== undefined) throw new OracleUnsupportedError('degenerate torus');
  const S = elementarySurf(s.kind, F, s.kind === 'plane' ? [] : s.kind === 'cone' ? [s.radius, s.semiAngle]
    : s.kind === 'torus' ? [s.majorRadius, s.minorRadius] : [s.radius]);
  const vertex = (v: number): V3 => {
    if (v < 0) throw new OracleUnsupportedError('an edge without vertices');
    return [d.vertex.point[3 * v]!, d.vertex.point[3 * v + 1]!, d.vertex.point[3 * v + 2]!];
  };
  /** The kind of curve an edge is sampled on (a trimmed curve's basis's), as the file's oracle names them. */
  const kindOf = (c: number): string => {
    const x = decode.curve(d, c);
    if (x.kind === 'trimmed') return kindOf(x.basis);
    if (x.kind === 'bspline') return x.weights ? 'rational-bspline' : 'bspline';
    if (x.kind === 'line' || x.kind === 'circle' || x.kind === 'ellipse') return x.kind;
    throw new OracleUnsupportedError(x.kind);
  };
  const density = (c: number, ev: CurveEvaluator): number => {
    const x = decode.curve(d, c);
    if (x.kind === 'trimmed') return density(x.basis, ev);
    if (x.kind === 'bspline') {
      const [lo, hi] = ev.range, spans = Math.max(1, x.knots.filter((k) => k >= lo && k <= hi).length - 1);
      return scale * SPLINE_SPAN_SAMPLES * spans / (hi - lo);
    }
    return scale * CONIC_SAMPLES / TWO_PI;
  };
  const edge = (e: number) => {
    const c = d.edge.curve[e]!;
    if (c < 0) throw new OracleUnsupportedError('an edge without a 3D curve');
    const kind = kindOf(c), ps = vertex(d.edge.start[e]!), pe = vertex(d.edge.end[e]!);
    if (kind === 'line') return { kind, sample: () => [ps, pe] };
    const ev = curveEvaluator(d, c, cache);
    // (Each edge's once: the search for its vertices' parameters is most of the oracle's time.)
    if (ev && !params.has(e)) params.set(e, edgeParams(d, e, ev));
    const r = ev && params.get(e);
    if (!ev || !r) throw new OracleUnsupportedError('an edge not evaluated');
    const [t0, t1] = r, sense = d.edge.sameSense[e] === 1;
    if (!ev.period && (t1 - t0) * (sense ? 1 : -1) < 0) {
      throw new OracleUnsupportedError('vertices against the curve\'s sense');
    }
    const k = density(c, ev);
    return { kind, sample: (n: number) => {
      const m = Math.min(MAX_EDGE_SAMPLES * n,
        Math.max(Math.ceil(scale * MIN_CURVED_SAMPLES) * n, Math.ceil(n * Math.abs(t1 - t0) * k)));
      const out: V3[] = [];
      for (let i = 0; i <= m; i++) out.push(i === 0 ? ps : i === m ? pe : ev.point(t0 + (t1 - t0) * i / m) as V3);
      return out;
    } };
  };
  const curves = new Set<string>();
  const loops: OracleLoop[] = [];
  for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
    if (d.loop.kind[l] === LOOP_KIND.vertex) continue;
    if (d.loop.kind[l] !== LOOP_KIND.edge) throw new OracleUnsupportedError('POLY_LOOP');
    const edges = [];
    for (let k = d.loop.first[l]!; k < d.loop.first[l]! + d.loop.count[l]!; k++) {
      const e = edge(d.coedge.edge[k]!);
      curves.add(e.kind);
      edges.push({ sample: e.sample, forward: d.coedge.orientation[k] !== 1 });
    }
    loops.push({ edges, forward: d.loop.sense[l] === 1 });
  }
  return faceIntegral(S, d.face.sameSense[f] === 1, loops, curves);
}

/**
 * The oracle's sampling density and the error it must be sure of, relative to the area, for judging meshes: far
 * coarser than the corpus checks' (1 and 1e-6), as faceFailures' tolerances are percents, and the oracle's time is
 * added to every part's meshing. At these, its areas were within 2.1e-4 of the full oracle's on every face both trust
 * (11,764 faces of 7 files), for a third of its time.
 */
export const ORACLE_DENSITY = 1 / 8;
export const ORACLE_RELATIVE = 1e-4;
/**
 * A backend's measure further than this from the oracle's area (relative to it) is replaced by the oracle's in a
 * part's measures (tessellateScene): the oracle is the more reliable (docs/backends.md), and OCCT's measures agree
 * with it within 1e-4 on 97 % of faces.
 */
export const ORACLE_DISAGREE = 0.01;

/** A face's area and perimeter, in the model's units. */
export type FaceArea = { area: number; perimeter: number };

/**
 * The model's faces' areas by the area oracle (area-oracle.ts), by face id, where it trusts them (`trustedArea`): faces
 * on planes, cylinders, cones, spheres and tori, independent of any backend. Faces sharing an id are left out.
 */
export function oracleAreas(model: BrepData): Map<number, FaceArea> {
  const out = new Map<number, FaceArea>(), seen = new Set<number>();
  const opts = { curves: new Map<number, CurveEvaluator | undefined>(), params: new Map(), density: ORACLE_DENSITY };
  for (let row = 0; row < model.face.surface.length; row++) {
    const id = model.face.id[row]!;
    if (!id) continue;
    if (seen.has(id)) { out.delete(id); continue; }
    seen.add(id);
    const o = modelFaceArea(model, row, opts);
    if (trustedArea(o, ORACLE_RELATIVE)) out.set(id, { area: o.area, perimeter: o.perimeter });
  }
  return out;
}

/**
 * oracleAreas as a result's `oracle` (a backend's adapter adds it to a result with measures): from the model or its
 * buffer's bytes.
 */
export function oracleMeasures(model: BrepData | Uint8Array): NonNullable<TessellationResult['oracle']> {
  return [...oracleAreas(model instanceof Uint8Array ? openBrep(model) : model)].map(([entityId, a]) =>
    ({ entityId, ...a }));
}
