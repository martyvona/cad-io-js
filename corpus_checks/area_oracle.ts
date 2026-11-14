// An area oracle independent of every mesher and kernel: a STEP face's exact area from the file's own geometry, for
// faces on planes, cylinders, cones, spheres and tori. What it covers, how it works and where it can be wrong:
// docs/backends.md. The integral, and the same oracle on the B-rep model, are cad-scene's (area-oracle.ts); this reads
// the file through step-parser alone, so the two checked against each other check the model's conversion.
import type { StepFile, Value } from '../packages/step-parser/src/index.ts';
import { CONIC_SAMPLES, cross, dist, dot, elementarySurf, faceIntegral, MAX_EDGE_SAMPLES, MIN_CURVED_SAMPLES, norm,
  type OracleArea, type OracleLoop, type OracleResult, type OracleSurface, OracleUnsupportedError as Unsupported,
  SAME_POINT, scale, SPLINE_SPAN_SAMPLES, sub, type Surf, TWO_PI, type V3 } from
  '../packages/cad-scene/src/area-oracle.ts';

export { modelFaceArea, OFF_SURFACE, type OracleArea, type OracleFlag, type OracleResult, type OracleSurface,
  type OracleUnsupported, trustedArea as trusted } from '../packages/cad-scene/src/area-oracle.ts';

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
            return [F.o[0] + c * F.x[0] + s * F.y[0], F.o[1] + c * F.x[1] + s * F.y[1],
              F.o[2] + c * F.x[2] + s * F.y[2]]; },
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
      const m = Math.min(MAX_EDGE_SAMPLES * n,
        Math.max(MIN_CURVED_SAMPLES * n, Math.ceil(n * Math.abs(t1 - t0) * c.density)));
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
  return { kind: weights ? 'rational-bspline' : 'bspline', at, lo, hi,
    density: (SPLINE_SPAN_SAMPLES * spans) / (hi - lo),
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
