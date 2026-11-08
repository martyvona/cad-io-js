// An area oracle independent of every mesher and kernel: a STEP face's exact area from the file's own geometry, for
// faces on planes, cylinders, cones, spheres and tori. What it covers, how it works and where it can be wrong:
// docs/backends.md. Depends on step-parser only, so it can move into a package.
//
// The method: Green's theorem in the surface's (u, v) parameters, area = oint P(v) du with dP/dv = -|S_u x S_v|.
// Each edge is sampled on its 3D curve between its vertices, each sample mapped to (u, v) in closed form, u unwrapped
// along the loop; trapezoid sums at N, 2N and 4N samples, Richardson-extrapolated from 2N and 4N.
import type { StepFile, Value } from '../packages/step-parser/src/index.ts';
import { type BrepData, type CurveEvaluator, curveEvaluator, decode, edgeParams, LOOP_KIND } from
  '../packages/cad-brep/src/index.ts';

export type OracleSurface = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus';
/**
 * Why an area may be wrong though computed: `orientation`, the loops' signed sum was negative (loops against Part
 * 42's orientation; the absolute value is reported); `minor-winding`, a torus loop winds the minor circle (P isn't
 * periodic in v, so the seam the face then spans, which no loop runs along, would count); `no-loops`, a face with no edge loops (area 0 reported).
 */
export type OracleFlag = 'orientation' | 'minor-winding' | 'no-loops' | 'off-surface';
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

/** An area to rely on: no flags, and the error estimate within `relative` of the area. */
export function trusted(r: OracleResult, relative = 1e-6): r is OracleArea {
  return r.ok && !r.flags.length && r.error <= relative * r.area;
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): V3 => scale(a, 1 / Math.hypot(...a));
const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const TWO_PI = 2 * Math.PI;
/** An edge's ends closer than this, relative to its curve's size, are one point (else the same vertex instance); a pole
 * or apex is within this of the axis, relative to the radius (or 1 unit). Relative to the size, not to the distance
 * from the origin: a short arc far from the origin is not a full circle. */
const SAME_POINT = 1e-9;
/** Samples per full turn of a circle or ellipse, and per knot span of a B-spline curve, before doubling. */
const CONIC_SAMPLES = 256, SPLINE_SPAN_SAMPLES = 64;
/** At least this many samples per curved edge, before doubling: short arcs far from the surface's origin need them. */
const MIN_CURVED_SAMPLES = 16;
/** At most this many samples per edge, before doubling (pathological knot vectors). */
const MAX_EDGE_SAMPLES = 200_000;
/** A loop point farther than this from the surface, relative to the loops' size, flags the face (an edge that isn't
 * on it: a file's topology error). */
export const OFF_SURFACE = 1e-2;

class Unsupported extends Error {}
type Record = { type: string; attrs: Value[] };

interface Curve {
  kind: string;
  at(t: number): V3;
  /** Parameter of the point on the curve nearest p. */
  param(p: V3): number;
  /** For closed conics: the period. */
  period?: number;
  lo: number;
  hi: number;
  /** Samples per unit of parameter, before doubling. */
  density: number;
  closed: boolean;
  /** A length typical of the curve (a conic's larger semi-axis, a B-spline's control polygon's extent; 0 for lines). */
  size: number;
}

interface Surf {
  kind: OracleSurface;
  /** (u, v); u is NaN where undefined (a cone's apex, a sphere's poles). */
  uv(p: V3): [number, number];
  /** A point's distance from the surface. */
  off(p: V3): number;
  P(v: number): number;
  /** For spheres, 4 pi R^2: the area is known modulo it. */
  modulus: number;
  periodicV: boolean;
  /** Planes: measure from this point (v0), so the sum doesn't cancel large terms; a constant in P adds c oint du, zero on a
   * plane but not where a loop winds around an axis. */
  recenter?(p: V3): void;
}

const wrap = (d: number) => d - TWO_PI * Math.round(d / TWO_PI);

/** The oracle for one file (or one part's subset): faces by id. */
export class AreaOracle {
  file: StepFile;
  /** Radians per unit of the file's plane angle. */
  angleUnit: number;

  constructor(file: StepFile) {
    this.file = file;
    this.angleUnit = planeAngleUnit(file);
  }

  /** The area of face `id` (an ADVANCED_FACE or FACE_SURFACE), or why it can't be computed. */
  faceArea(id: number): OracleResult {
    try {
      return this.face(id);
    } catch (e) {
      if (e instanceof Unsupported) return { ok: false, reason: e.message };
      throw e;
    }
  }

  // ---- reading ----

  private parts(id: number): Record[] {
    const i = this.file.instance(id);
    if (!i) throw new Unsupported(`missing #${id}`);
    return 'type' in i ? [{ type: i.type, attrs: i.attrs }] : i.parts;
  }
  private one(id: number): Record {
    const p = this.parts(id);
    if (p.length !== 1) throw new Unsupported(`complex ${p.map((x) => x.type).join('+')}`);
    return p[0]!;
  }
  private ref(v: Value | undefined): number {
    if (v?.k !== 'ref') throw new Unsupported('expected a reference');
    return v.v;
  }
  private num(v: Value | undefined): number {
    if (v?.k === 'real') return v.v;
    if (v?.k === 'int') return Number(v.v);
    if (v?.k === 'typed') return this.num(v.v);
    throw new Unsupported('expected a number');
  }
  private list(v: Value | undefined): Value[] {
    if (v?.k === 'list') return v.v;
    if (v?.k === 'refs') return Array.from(v.v as ArrayLike<number>, (x): Value => ({ k: 'ref', v: x }));
    if (v?.k === 'reals') return Array.from(v.v as ArrayLike<number>, (x): Value => ({ k: 'real', v: x }));
    if (v?.k === 'ints') return Array.from(v.v as ArrayLike<number>, (x): Value => ({ k: 'int', v: x }));
    throw new Unsupported('expected a list');
  }
  private bool(v: Value | undefined): boolean {
    return v?.k === 'enum' ? v.v === 'T' : true;
  }
  private point(id: number): V3 {
    const p = this.one(id);
    if (p.type !== 'CARTESIAN_POINT') throw new Unsupported(p.type);
    const c = this.list(p.attrs[1]).map((x) => this.num(x));
    return [c[0] ?? 0, c[1] ?? 0, c[2] ?? 0];
  }
  private direction(id: number): V3 {
    const p = this.one(id);
    if (p.type !== 'DIRECTION') throw new Unsupported(p.type);
    const c = this.list(p.attrs[1]).map((x) => this.num(x));
    return norm([c[0] ?? 0, c[1] ?? 0, c[2] ?? 0]);
  }
  /** AXIS2_PLACEMENT_3D as an origin and orthonormal axes (Part 42's build_axes). */
  private frame(id: number): { o: V3; x: V3; y: V3; z: V3 } {
    const p = this.one(id);
    if (p.type !== 'AXIS2_PLACEMENT_3D') throw new Unsupported(p.type);
    const o = this.point(this.ref(p.attrs[1]));
    const z: V3 = p.attrs[2]?.k === 'ref' ? this.direction(p.attrs[2].v) : [0, 0, 1];
    const fallback: V3 = Math.abs(z[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    let a: V3 = p.attrs[3]?.k === 'ref' ? this.direction(p.attrs[3].v) : fallback;
    a = sub(a, scale(z, dot(a, z)));
    if (Math.hypot(...a) < 1e-12) a = sub(fallback, scale(z, dot(fallback, z)));
    const x = norm(a);
    return { o, x, y: cross(z, x), z };
  }

  // ---- curves ----

  private curve(id: number): Curve {
    const parts = this.parts(id);
    if (parts.length === 1) {
      const { type, attrs } = parts[0]!;
      if (type === 'SURFACE_CURVE' || type === 'SEAM_CURVE' || type === 'INTERSECTION_CURVE'
        || type === 'BOUNDED_SURFACE_CURVE') return this.curve(this.ref(attrs[1]));
      if (type === 'LINE') {
        const o = this.point(this.ref(attrs[1]));
        const d = this.direction(this.ref(this.one(this.ref(attrs[2])).attrs[1]));
        return { kind: 'line', at: (t) => [o[0] + t * d[0], o[1] + t * d[1], o[2] + t * d[2]],
          param: (p) => dot(sub(p, o), d), lo: -Infinity, hi: Infinity, density: 0, closed: false, size: 0 };
      }
      if (type === 'CIRCLE' || type === 'ELLIPSE') {
        const F = this.frame(this.ref(attrs[1]));
        const a = this.num(attrs[2]), b = type === 'CIRCLE' ? a : this.num(attrs[3]);
        return { kind: type.toLowerCase(), period: TWO_PI, lo: 0, hi: TWO_PI, density: CONIC_SAMPLES / TWO_PI,
          closed: true, size: Math.max(Math.abs(a), Math.abs(b)),
          at: (t) => { const c = a * Math.cos(t), s = b * Math.sin(t);
            return [F.o[0] + c * F.x[0] + s * F.y[0], F.o[1] + c * F.x[1] + s * F.y[1], F.o[2] + c * F.x[2] + s * F.y[2]]; },
          param: (p) => { const q = sub(p, F.o); const t = Math.atan2(dot(q, F.y) / b, dot(q, F.x) / a);
            return t < 0 ? t + TWO_PI : t; } };
      }
      if (type === 'B_SPLINE_CURVE_WITH_KNOTS') {
        return splineCurve(this.num(attrs[1]), this.list(attrs[2]).map((x) => this.point(this.ref(x))), null,
          this.list(attrs[6]).map((x) => this.num(x)), this.list(attrs[7]).map((x) => this.num(x)));
      }
      if (type === 'TRIMMED_CURVE') return this.curve(this.ref(attrs[1]));
      throw new Unsupported(type);
    }
    const bs = parts.find((p) => p.type === 'B_SPLINE_CURVE');
    const wk = parts.find((p) => p.type === 'B_SPLINE_CURVE_WITH_KNOTS');
    const ra = parts.find((p) => p.type === 'RATIONAL_B_SPLINE_CURVE');
    if (bs && wk) {
      return splineCurve(this.num(bs.attrs[0]), this.list(bs.attrs[1]).map((x) => this.point(this.ref(x))),
        ra ? this.list(ra.attrs[0]).map((x) => this.num(x)) : null,
        this.list(wk.attrs[0]).map((x) => this.num(x)), this.list(wk.attrs[1]).map((x) => this.num(x)));
    }
    throw new Unsupported(`complex ${parts.map((p) => p.type).join('+')}`);
  }

  /** An edge's points from its start vertex to its end (the curve's sense applied), for a sampling level n. */
  private edge(edgeId: number): { kind: string; sample: (n: number) => V3[] } {
    const e = this.one(edgeId);
    if (e.type !== 'EDGE_CURVE') throw new Unsupported(e.type);
    const vertex = (id: number) => {
      const v = this.one(id);
      if (v.type !== 'VERTEX_POINT') throw new Unsupported(v.type);
      return this.point(this.ref(v.attrs[1]));
    };
    const vs = this.ref(e.attrs[1]), ve = this.ref(e.attrs[2]);
    const ps = vertex(vs), pe = vertex(ve);
    const sense = this.bool(e.attrs[4]);
    const c = this.curve(this.ref(e.attrs[3]));
    if (c.kind === 'line') return { kind: c.kind, sample: () => [ps, pe] };
    const closedEdge = vs === ve || dist(ps, pe) < SAME_POINT * c.size;
    let t0 = c.param(ps), t1 = c.param(pe);
    if (c.period) {
      const P = c.period;
      if (closedEdge) t1 = t0 + (sense ? P : -P);
      else if (sense) { while (t1 <= t0) t1 += P; while (t1 - t0 > P) t1 -= P; }
      else { while (t1 >= t0) t1 -= P; while (t0 - t1 > P) t1 += P; }
    } else {
      if (closedEdge && c.closed) { t0 = sense ? c.lo : c.hi; t1 = sense ? c.hi : c.lo; }
      if ((t1 - t0) * (sense ? 1 : -1) < 0) throw new Unsupported('vertices against the curve\'s sense');
    }
    return { kind: c.kind, sample: (n) => {
      const m = Math.min(MAX_EDGE_SAMPLES * n, Math.max(MIN_CURVED_SAMPLES * n, Math.ceil(n * Math.abs(t1 - t0) * c.density)));
      const out: V3[] = [];
      for (let i = 0; i <= m; i++) out.push(i === 0 ? ps : i === m ? pe : c.at(t0 + ((t1 - t0) * i) / m));
      return out;
    } };
  }

  // ---- surfaces ----

  private surface(id: number): Surf {
    const { type, attrs } = this.one(id);
    const kind = SURFACE_TYPES[type];
    if (!kind) throw new Unsupported(type);
    const F = this.frame(this.ref(attrs[1]));
    const nums = kind === 'plane' ? [] : kind === 'cone' ? [this.num(attrs[2]), this.num(attrs[3]) * this.angleUnit]
      : kind === 'torus' ? [Math.abs(this.num(attrs[2])), Math.abs(this.num(attrs[3]))] : [this.num(attrs[2])];
    return elementarySurf(kind, F, nums);
  }

  // ---- the integral ----

  private face(id: number): OracleArea {
    const f = this.one(id);
    if (f.type !== 'ADVANCED_FACE' && f.type !== 'FACE_SURFACE') throw new Unsupported(f.type);
    const S = this.surface(this.ref(f.attrs[2]));
    const same = this.bool(f.attrs[3]);
    const curves = new Set<string>();
    const loops: OracleLoop[] = [];
    for (const b of this.list(f.attrs[1])) {
      const bound = this.one(this.ref(b));
      if (bound.type !== 'FACE_BOUND' && bound.type !== 'FACE_OUTER_BOUND') throw new Unsupported(bound.type);
      const loop = this.one(this.ref(bound.attrs[1]));
      if (loop.type === 'VERTEX_LOOP') continue;
      if (loop.type !== 'EDGE_LOOP') throw new Unsupported(loop.type);
      const edges = this.list(loop.attrs[1]).map((x) => {
        const oe = this.one(this.ref(x));
        if (oe.type !== 'ORIENTED_EDGE') throw new Unsupported(oe.type);
        const e = this.edge(this.ref(oe.attrs[3]));
        curves.add(e.kind);
        return { sample: e.sample, forward: this.bool(oe.attrs[4]) };
      });
      loops.push({ edges, forward: this.bool(bound.attrs[2]) });
    }
    return faceIntegral(S, same, loops, curves);
  }
}

const SURFACE_TYPES: { [type: string]: OracleSurface } = { PLANE: 'plane', CYLINDRICAL_SURFACE: 'cylinder',
  CONICAL_SURFACE: 'cone', SPHERICAL_SURFACE: 'sphere', TOROIDAL_SURFACE: 'torus' };

/**
 * A surface's (u, v) map and integrand from its frame and numbers (angles in radians): a cylinder's or sphere's radius,
 * a cone's radius and semi-angle, a torus's major and minor radii; shared by the file's oracle and the model's.
 */
function elementarySurf(kind: OracleSurface, F: { o: V3; x: V3; y: V3; z: V3 }, nums: number[]): Surf {
    const local = (p: V3): V3 => { const q = sub(p, F.o); return [dot(q, F.x), dot(q, F.y), dot(q, F.z)]; };
    const angle = (q: V3) => Math.atan2(q[1], q[0]);
    if (kind === 'plane') {
      let v0 = 0;
      return { kind: 'plane', modulus: 0, periodicV: false, uv: (p) => { const q = local(p); return [q[0], q[1]]; },
        off: (p) => Math.abs(local(p)[2]), P: (v) => -(v - v0), recenter: (p) => { v0 = local(p)[1]; } };
    }
    if (kind === 'cylinder') {
      const r = nums[0]!;
      return { kind: 'cylinder', modulus: 0, periodicV: false, uv: (p) => { const q = local(p); return [angle(q), q[2]]; },
        off: (p) => { const q = local(p); return Math.abs(Math.hypot(q[0], q[1]) - r); }, P: (v) => -r * v };
    }
    if (kind === 'cone') {
      // rho(v) = r + v tan(a); dA = |rho| / cos(a) du dv; P = -rho |rho| / (2 sin a), zero at the apex.
      const r = nums[0]!, a = nums[1]!;
      const t = Math.tan(a), s = Math.sin(a);
      if (Math.abs(s) < 1e-15) throw new Unsupported('cone with zero semi-angle');
      return { kind: 'cone', modulus: 0, periodicV: false,
        uv: (p) => { const q = local(p);
          return [Math.hypot(q[0], q[1]) < SAME_POINT * (1 + Math.abs(r)) ? NaN : angle(q), q[2]]; },
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
    if (r >= R) throw new Unsupported('degenerate torus');
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

type OracleLoop = { edges: { sample: (n: number) => V3[]; forward: boolean }[]; forward: boolean };

/** A face's area and perimeter from its surface and loops, extrapolated from 1, 2 and 4 times the samples. */
function faceIntegral(S: Surf, same: boolean, loops: OracleLoop[], curves: Set<string>): OracleArea {
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
  if (S.modulus) area = ((area % S.modulus) + S.modulus) % S.modulus;
  else if (area < 0) { flags.add('orientation'); area = -area; }
  const size = Math.hypot(hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!);
  const offSurface = loops.length ? off / Math.max(size, 1e-300) : 0;
  if (offSurface > OFF_SURFACE) flags.add('off-surface');
  return { ok: true, area, error: Math.abs(r24 - r12), perimeter: (4 * l4 - l2) / 3, surface: S.kind, offSurface,
    flags: [...flags], curves: [...curves].sort() };
}

function splineCurve(degree: number, cps: V3[], weights: number[] | null, mults: number[], ks: number[]): Curve {
  const knots: number[] = [];
  mults.forEach((m, i) => { for (let j = 0; j < m; j++) knots.push(ks[i]!); });
  if (knots.length !== cps.length + degree + 1) throw new Unsupported('B-spline knot count');
  if (weights && weights.length !== cps.length) throw new Unsupported('B-spline weight count');
  const n = cps.length, lo = knots[degree]!, hi = knots[n]!;
  const at = (t: number): V3 => {
    t = Math.min(Math.max(t, lo), hi);
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]!) k++;
    const d: number[][] = [];
    for (let j = 0; j <= degree; j++) {
      const c = cps[k - degree + j]!, w = weights ? weights[k - degree + j]! : 1;
      d.push([c[0] * w, c[1] * w, c[2] * w, w]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j, den = knots[i + degree - r + 1]! - knots[i]!;
        const a = den === 0 ? 0 : (t - knots[i]!) / den;
        for (let c = 0; c < 4; c++) d[j]![c] = (1 - a) * d[j - 1]![c]! + a * d[j]![c]!;
      }
    }
    const h = d[degree]!;
    return [h[0]! / h[3]!, h[1]! / h[3]!, h[2]! / h[3]!];
  };
  const spans = Math.max(1, new Set(ks.filter((k) => k >= lo && k <= hi)).size - 1);
  const p0 = at(lo);
  let size = 0;
  for (const c of cps) size = Math.max(size, dist(c, cps[0]!));
  return { kind: weights ? 'rational-bspline' : 'bspline', at, lo, hi, density: (SPLINE_SPAN_SAMPLES * spans) / (hi - lo),
    closed: dist(p0, at(hi)) < SAME_POINT * size, size,
    param: (p) => nearestParam(at, lo, hi, p, SPLINE_SPAN_SAMPLES * spans * 4) };
}

/** The parameter of the point nearest p: a dense scan, then golden-section search in the bracketing interval. */
function nearestParam(at: (t: number) => V3, lo: number, hi: number, p: V3, samples: number): number {
  let best = lo, bd = Infinity;
  for (let i = 0; i <= samples; i++) {
    const t = lo + ((hi - lo) * i) / samples, d = dist(at(t), p);
    if (d < bd) { bd = d; best = t; }
  }
  let a = Math.max(lo, best - (hi - lo) / samples), b = Math.min(hi, best + (hi - lo) / samples);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 80; it++) {
    const c = b - g * (b - a), e = a + g * (b - a);
    if (dist(at(c), p) < dist(at(e), p)) b = e; else a = c;
  }
  return (a + b) / 2;
}

/**
 * The plane angle unit, in radians, of the file's first geometric context with global units (1 for radians or none).
 * Not any angle unit in the file: PMI often uses degrees where the geometry uses radians.
 */
export function planeAngleUnit(file: StepFile): number {
  const radians = (id: number, depth = 0): number | undefined => {
    const u = file.instance(id);
    if (!u || 'type' in u || depth > 4) return undefined;
    if (!u.parts.some((p) => p.type === 'PLANE_ANGLE_UNIT')) return undefined;
    const cb = u.parts.find((p) => p.type === 'CONVERSION_BASED_UNIT');
    if (!cb) return 1;
    const m = cb.attrs[1]?.k === 'ref' ? file.instance(cb.attrs[1].v) : undefined;
    if (!m || !('type' in m)) return undefined;
    const v = m.attrs[0], x = v?.k === 'typed' ? v.v : v;
    if (x?.k !== 'real' && x?.k !== 'int') return undefined;
    const base = m.attrs[1]?.k === 'ref' ? radians(m.attrs[1].v, depth + 1) : 1;
    return Number(x.v) * (base ?? 1);
  };
  for (const inst of file.instances()) {
    if ('type' in inst) continue;
    if (!inst.parts.some((p) => p.type === 'GEOMETRIC_REPRESENTATION_CONTEXT')) continue;
    const g = inst.parts.find((p) => p.type === 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    const us = g?.attrs[0];
    const ids = us?.k === 'refs' ? Array.from(us.v as ArrayLike<number>)
      : us?.k === 'list' ? us.v.flatMap((x) => (x.k === 'ref' ? [x.v] : [])) : [];
    for (const id of ids) {
      const r = radians(id);
      if (r !== undefined) return r;
    }
  }
  return 1;
}

/**
 * The same oracle on a face of the B-rep model (cad-brep; face row `f`): the model's surface and edges, sampled through
 * cad-brep's evaluators and `edgeParams` as the file's oracle samples its own, then the same integral. On a model
 * converted from a STEP file it gives the file's oracle's area (corpus_checks/area_model.ts), so a difference is the
 * conversion's or the evaluators'. Supports what the file's oracle does (the five elementary surfaces; lines, circles,
 * ellipses, B-splines and trimmed curves of them as edge curves).
 */
export function modelFaceArea(d: BrepData, f: number, curves = new Map<number, CurveEvaluator | undefined>()):
  OracleResult {
  try {
    return modelFace(d, f, curves);
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    throw e;
  }
}

function modelFace(d: BrepData, f: number, cache: Map<number, CurveEvaluator | undefined>): OracleArea {
  const s = decode.surface(d, d.face.surface[f]!);
  if (s.kind !== 'plane' && s.kind !== 'cylinder' && s.kind !== 'cone' && s.kind !== 'sphere' && s.kind !== 'torus') {
    throw new Unsupported(s.kind);
  }
  const { origin, axis, xDir } = s.position;
  const F = { o: origin as V3, x: xDir as V3, y: cross(axis as V3, xDir as V3), z: axis as V3 };
  if (s.kind === 'torus' && s.selectOuter !== undefined) throw new Unsupported('degenerate torus');
  const S = elementarySurf(s.kind, F, s.kind === 'plane' ? [] : s.kind === 'cone' ? [s.radius, s.semiAngle]
    : s.kind === 'torus' ? [s.majorRadius, s.minorRadius] : [s.radius]);
  const vertex = (v: number): V3 => {
    if (v < 0) throw new Unsupported('an edge without vertices');
    return [d.vertex.point[3 * v]!, d.vertex.point[3 * v + 1]!, d.vertex.point[3 * v + 2]!];
  };
  /** The kind of curve an edge is sampled on (a trimmed curve's basis's), as the file's oracle names them. */
  const kindOf = (c: number): string => {
    const x = decode.curve(d, c);
    if (x.kind === 'trimmed') return kindOf(x.basis);
    if (x.kind === 'bspline') return x.weights ? 'rational-bspline' : 'bspline';
    if (x.kind === 'line' || x.kind === 'circle' || x.kind === 'ellipse') return x.kind;
    throw new Unsupported(x.kind);
  };
  const density = (c: number, ev: CurveEvaluator): number => {
    const x = decode.curve(d, c);
    if (x.kind === 'trimmed') return density(x.basis, ev);
    if (x.kind === 'bspline') {
      const [lo, hi] = ev.range, spans = Math.max(1, x.knots.filter((k) => k >= lo && k <= hi).length - 1);
      return SPLINE_SPAN_SAMPLES * spans / (hi - lo);
    }
    return CONIC_SAMPLES / TWO_PI;
  };
  const edge = (e: number) => {
    const c = d.edge.curve[e]!;
    if (c < 0) throw new Unsupported('an edge without a 3D curve');
    const kind = kindOf(c), ps = vertex(d.edge.start[e]!), pe = vertex(d.edge.end[e]!);
    if (kind === 'line') return { kind, sample: () => [ps, pe] };
    const ev = curveEvaluator(d, c, cache);
    const r = ev && edgeParams(d, e, ev);
    if (!ev || !r) throw new Unsupported('an edge not evaluated');
    const [t0, t1] = r, sense = d.edge.sameSense[e] === 1;
    if (!ev.period && (t1 - t0) * (sense ? 1 : -1) < 0) throw new Unsupported('vertices against the curve\'s sense');
    const k = density(c, ev);
    return { kind, sample: (n: number) => {
      const m = Math.min(MAX_EDGE_SAMPLES * n, Math.max(MIN_CURVED_SAMPLES * n, Math.ceil(n * Math.abs(t1 - t0) * k)));
      const out: V3[] = [];
      for (let i = 0; i <= m; i++) out.push(i === 0 ? ps : i === m ? pe : ev.point(t0 + (t1 - t0) * i / m) as V3);
      return out;
    } };
  };
  const curves = new Set<string>();
  const loops: OracleLoop[] = [];
  for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
    if (d.loop.kind[l] === LOOP_KIND.vertex) continue;
    if (d.loop.kind[l] !== LOOP_KIND.edge) throw new Unsupported('POLY_LOOP');
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
