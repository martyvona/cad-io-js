// Evaluation of a B-rep's curves and surfaces by Part 42's parameterizations (docs/brep-model.md, rule 1): points and
// first derivatives, natural parameter ranges and periods, and closed-form inverses (a point's parameters) for the
// kinds that have them, nearest-point search for the rest. Built once per row (an evaluator decodes its row) and
// called many times. B-splines by Piegl and Tiller (The NURBS Book, A2.1 and A2.3), rational ones through homogeneous
// coordinates. Where Part 42's parameterization isn't known to us or unused by OCCT, the choice is said: a polyline's
// segment k runs over [k, k + 1] (as OCCT reads it), a composite curve's segment k over [k, k + 1] mapped linearly onto
// the segment's own range, an offset curve is OCCT's (the basis plus d times the unit of tangent x reference direction;
// in 2D of the tangent turned -90 degrees). Swept surfaces with a directrix aren't evaluated.

import type { BrepData } from './data.ts';
import { curve as decodeCurve, surface as decodeSurface } from './decode.ts';
import type { Curve, Placement, Surface } from './types.ts';

export type Vec = number[];

export interface CurveEvaluator {
  dim: number;
  /** The natural parameter range ([-Infinity, Infinity] for lines, hyperbolas, parabolas, offsets of them). */
  range: [number, number];
  /** The period, for closed conics. */
  period?: number;
  point(t: number): Vec;
  /** The first derivative. */
  d1(t: number): Vec;
  /** A point's parameter on the curve, in closed form (lines and conics), else by nearest-point search. */
  param(p: Vec): number | undefined;
}

export interface SurfaceEvaluator {
  /** The natural parameter ranges. */
  u: [number, number];
  v: [number, number];
  uPeriod?: number;
  vPeriod?: number;
  point(u: number, v: number): Vec;
  /** The partial derivatives. */
  d1(u: number, v: number): [Vec, Vec];
  /** A point's parameters, in closed form, for planes, cylinders, cones, spheres and tori (and trims and offsets of
   * them); undefined where there's no closed form or the point is on an axis. */
  params?(p: Vec): [number, number] | undefined;
  /** Knot spans in u and v (B-spline surfaces), for nearest-point search's grid. */
  spans?: [number, number];
}

const add = (a: Vec, b: Vec) => a.map((x, i) => x + b[i]!);
const sub = (a: Vec, b: Vec) => a.map((x, i) => x - b[i]!);
const scale = (a: Vec, s: number) => a.map((x) => x * s);
const dot = (a: Vec, b: Vec) => a.reduce((s, x, i) => s + x * b[i]!, 0);
export const cross = (a: Vec, b: Vec): Vec => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!];
const norm = (a: Vec) => Math.hypot(...a);
const unit = (a: Vec) => scale(a, 1 / norm(a));
/** A combination of vectors: sum of c_k v_k. */
const comb = (cs: number[], vs: Vec[]) => {
  const out = new Array<number>(vs[0]!.length).fill(0);
  cs.forEach((c, k) => { for (let i = 0; i < out.length; i++) out[i]! += c * vs[k]![i]!; });
  return out;
};
const TWO_PI = 2 * Math.PI;
const wrap = (a: number) => { const x = a % TWO_PI; return x < 0 ? x + TWO_PI : x; };

/** A placement's axes: x, y and (in 3D) z. */
function axes(p: Placement): { o: Vec; x: Vec; y: Vec; z?: Vec } {
  if (p.axis) return { o: p.origin, x: p.xDir, y: cross(p.axis, p.xDir), z: p.axis };
  return { o: p.origin, x: p.xDir, y: [-p.xDir[1]!, p.xDir[0]!] };
}

// -- B-splines.

/** A knot vector in full, each knot repeated by its multiplicity. */
export function fullKnots(knots: number[], mults: number[]): number[] {
  return knots.flatMap((k, i) => Array<number>(mults[i]!).fill(k));
}

/** The span index for t (Piegl and Tiller A2.1): the last i with U[i] <= t < U[i + 1], clamped to [p, n - 1]. */
function findSpan(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n]!) return n - 1;
  if (t <= U[p]!) return p;
  let lo = p, hi = n;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (t < U[mid]!) hi = mid;
    else lo = mid;
  }
  return lo;
}

/** The non-zero basis functions at t and their first derivatives (A2.3 with n = 1): [N, N'] of length p + 1. */
function basis(span: number, t: number, p: number, U: number[]): [number[], number[]] {
  const ndu: number[][] = Array.from({ length: p + 1 }, () => new Array<number>(p + 1).fill(0));
  const left = new Array<number>(p + 1).fill(0), right = new Array<number>(p + 1).fill(0);
  ndu[0]![0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[span + 1 - j]!;
    right[j] = U[span + j]! - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      ndu[j]![r] = right[r + 1]! + left[j - r]!;
      const temp = ndu[r]![j - 1]! / ndu[j]![r]!;
      ndu[r]![j] = saved + right[r + 1]! * temp;
      saved = left[j - r]! * temp;
    }
    ndu[j]![j] = saved;
  }
  const N = Array.from({ length: p + 1 }, (_, j) => ndu[j]![p]!);
  const D = new Array<number>(p + 1).fill(0);
  if (p > 0) {
    for (let r = 0; r <= p; r++) {
      // d/dt N_{span-p+r,p} = p (N_{span-p+r,p-1} / (U[i+p] - U[i]) - N_{span-p+r+1,p-1} / (U[i+p+1] - U[i+1]))
      let d = 0;
      if (r >= 1) d += ndu[r - 1]![p - 1]! / ndu[p]![r - 1]!;
      if (r <= p - 1) d -= ndu[r]![p - 1]! / ndu[p]![r]!;
      D[r] = p * d;
    }
  }
  return [N, D];
}

/** A B-spline curve's point and derivative, rational or not. */
function bsplineCurve(degree: number, U: number[], poles: Vec[], weights?: number[]) {
  const n = poles.length, p = degree;
  const at = (t: number): [Vec, Vec] => {
    const span = findSpan(n, p, t, U);
    const [N, D] = basis(span, t, p, U);
    const idx = Array.from({ length: p + 1 }, (_, j) => span - p + j);
    if (!weights) return [comb(N, idx.map((i) => poles[i]!)), comb(D, idx.map((i) => poles[i]!))];
    const w = idx.map((i) => weights[i]!);
    const W = dot(N, w), Wd = dot(D, w);
    const A = comb(N.map((x, j) => x * w[j]!), idx.map((i) => poles[i]!));
    const Ad = comb(D.map((x, j) => x * w[j]!), idx.map((i) => poles[i]!));
    const c = scale(A, 1 / W);
    return [c, scale(sub(Ad, scale(c, Wd)), 1 / W)];
  };
  return { range: [U[p]!, U[n]!] as [number, number], at };
}

/**
 * Nearest-point search on a curve over a finite range: dense samples, then bisection on the derivative of the squared
 * distance around each of the best few local minima among them (a curve can come back near itself), the nearest kept.
 */
export function nearestParam(c: Pick<CurveEvaluator, 'point' | 'd1'>, p: Vec, range: [number, number],
  samples = 256): number {
  const [a, b] = range, h = (b - a) / samples;
  const ts = Array.from({ length: samples + 1 }, (_, k) => a + (b - a) * k / samples);
  const ds = ts.map((t) => norm(sub(c.point(t), p)));
  const minima = ts.map((_, k) => k).filter((k) => (k === 0 || ds[k]! <= ds[k - 1]!) && (k === samples
    || ds[k]! <= ds[k + 1]!)).sort((i, j) => ds[i]! - ds[j]!).slice(0, 4);
  const g = (t: number) => dot(sub(c.point(t), p), c.d1(t));
  let best = ts[minima[0]!]!, bestD = ds[minima[0]!]!;
  for (const k of minima) {
    let lo = Math.max(a, ts[k]! - h), hi = Math.min(b, ts[k]! + h);
    let t = ts[k]!;
    if (g(lo) <= 0 && g(hi) >= 0) {
      for (let i = 0; i < 60 && hi - lo > 1e-15 * Math.max(1, Math.abs(hi)); i++) {
        const m = (lo + hi) / 2;
        if (g(m) < 0) lo = m;
        else hi = m;
      }
      t = (lo + hi) / 2;
    }
    const dd = norm(sub(c.point(t), p));
    if (dd < bestD) { bestD = dd; best = t; }
  }
  return best;
}

// -- Curves.

/** An evaluator for curve row `i`, or undefined where the curve can't be evaluated (unbounded composite segments,
 * missing rows). */
export function curveEvaluator(d: BrepData, i: number, cache = new Map<number, CurveEvaluator | undefined>()):
  CurveEvaluator | undefined {
  if (cache.has(i)) return cache.get(i);
  cache.set(i, undefined); // a cycle ends here
  const e = curveEvaluatorOf(decodeCurve(d, i), (j) => curveEvaluator(d, j, cache));
  cache.set(i, e);
  return e;
}

/**
 * An evaluator for a curve given as its object, `resolve` giving the evaluators of the rows it refers to (a trimmed
 * curve's basis, a composite's segments): for curves not yet in a buffer (an importer's).
 */
export function curveEvaluatorOf(c: Curve, resolve: (row: number) => CurveEvaluator | undefined):
  CurveEvaluator | undefined {
  const finite = (e: Omit<CurveEvaluator, 'param'> & { param?: CurveEvaluator['param'] }): CurveEvaluator => ({
    ...e, param: e.param ?? ((p) => Number.isFinite(e.range[0]) && Number.isFinite(e.range[1])
      ? nearestParam(e, p, e.range) : undefined),
  });
  switch (c.kind) {
    case 'line': {
      const v = scale(c.direction, c.magnitude);
      return finite({ dim: c.point.length, range: [-Infinity, Infinity], point: (t) => add(c.point, scale(v, t)),
        d1: () => v, param: (p) => dot(sub(p, c.point), c.direction) / c.magnitude });
    }
    case 'circle': case 'ellipse': {
      const { o, x, y } = axes(c.position);
      const a = c.kind === 'circle' ? c.radius : c.semiAxis1, b = c.kind === 'circle' ? c.radius : c.semiAxis2;
      return finite({ dim: o.length, range: [0, TWO_PI], period: TWO_PI,
        point: (t) => add(o, add(scale(x, a * Math.cos(t)), scale(y, b * Math.sin(t)))),
        d1: (t) => add(scale(x, -a * Math.sin(t)), scale(y, b * Math.cos(t))),
        param: (p) => { const q = sub(p, o); return wrap(Math.atan2(dot(q, y) / b, dot(q, x) / a)); } });
    }
    case 'hyperbola': {
      const { o, x, y } = axes(c.position), a = c.semiAxis, b = c.semiImagAxis;
      return finite({ dim: o.length, range: [-Infinity, Infinity],
        point: (t) => add(o, add(scale(x, a * Math.cosh(t)), scale(y, b * Math.sinh(t)))),
        d1: (t) => add(scale(x, a * Math.sinh(t)), scale(y, b * Math.cosh(t))),
        param: (p) => Math.asinh(dot(sub(p, o), y) / b) });
    }
    case 'parabola': {
      const { o, x, y } = axes(c.position), f = c.focalDist;
      return finite({ dim: o.length, range: [-Infinity, Infinity],
        point: (t) => add(o, scale(add(scale(x, t * t), scale(y, 2 * t)), f)),
        d1: (t) => scale(add(scale(x, 2 * t), scale(y, 2)), f),
        param: (p) => dot(sub(p, o), y) / (2 * f) });
    }
    case 'bspline': {
      const s = bsplineCurve(c.degree, fullKnots(c.knots, c.multiplicities), c.poles, c.weights);
      const e = { dim: c.poles[0]!.length, range: s.range, point: (t: number) => s.at(t)[0],
        d1: (t: number) => s.at(t)[1] };
      // Searched by its spans: 32 samples a span (at least 256).
      const n = Math.max(256, 32 * (c.knots.length - 1));
      return { ...e, param: (p) => nearestParam(e, p, s.range, n) };
    }
    case 'polyline': {
      const P = c.points, n = P.length;
      const seg = (t: number) => Math.min(Math.max(Math.floor(t), 0), n - 2);
      return finite({ dim: P[0]!.length, range: [0, n - 1],
        point: (t) => { const k = seg(t); return add(P[k]!, scale(sub(P[k + 1]!, P[k]!), t - k)); },
        d1: (t) => { const k = seg(t); return sub(P[k + 1]!, P[k]!); } });
    }
    case 'trimmed': {
      const b = resolve(c.basis);
      if (!b) return undefined;
      const t1 = c.trim1.parameter ?? (c.trim1.point ? b.param(c.trim1.point) : undefined);
      let t2 = c.trim2.parameter ?? (c.trim2.point ? b.param(c.trim2.point) : undefined);
      if (t1 === undefined || t2 === undefined) return { ...b };
      // On a closed curve, the trim runs from t1 to t2 in the curve's sense if `sense`, else against it.
      if (b.period) {
        if (c.sense && t2 <= t1) t2 += b.period;
        if (!c.sense && t2 >= t1) t2 -= b.period;
      }
      return { ...b, range: t1 <= t2 ? [t1, t2] : [t2, t1] };
    }
    case 'composite': {
      const segs = c.segments.map((s) => ({ s, e: resolve(s.curve) }));
      if (segs.some(({ e }) => !e || !Number.isFinite(e.range[0]) || !Number.isFinite(e.range[1]))) return undefined;
      const n = segs.length;
      const local = (t: number) => {
        const k = Math.min(Math.max(Math.floor(t), 0), n - 1), { s, e } = segs[k]!, [a, b] = e!.range;
        const f = t - k, len = b - a;
        return { e: e!, u: s.sameSense ? a + f * len : b - f * len, k: s.sameSense ? len : -len };
      };
      return finite({ dim: segs[0]!.e!.dim, range: [0, n], point: (t) => { const l = local(t); return l.e.point(l.u); },
        d1: (t) => { const l = local(t); return scale(l.e.d1(l.u), l.k); } });
    }
    case 'offset': {
      const b = resolve(c.basis);
      if (!b) return undefined;
      const dir = (t: number) => {
        const tan = b.d1(t);
        return unit(b.dim === 3 ? cross(tan, c.refDirection!) : [tan[1]!, -tan[0]!]);
      };
      const point = (t: number) => add(b.point(t), scale(dir(t), c.distance));
      const h = 1e-7;
      return finite({ dim: b.dim, range: b.range, ...(b.period ? { period: b.period } : {}), point,
        d1: (t) => scale(sub(point(t + h), point(t - h)), 1 / (2 * h)) });
    }
  }
}

// -- Surfaces.

export function surfaceEvaluator(d: BrepData, i: number, cache = new Map<number, SurfaceEvaluator | undefined>(),
  curves = new Map<number, CurveEvaluator | undefined>()): SurfaceEvaluator | undefined {
  if (cache.has(i)) return cache.get(i);
  cache.set(i, undefined);
  const e = makeSurface(d, decodeSurface(d, i), cache, curves);
  cache.set(i, e);
  return e;
}

function makeSurface(d: BrepData, s: Surface, cache: Map<number, SurfaceEvaluator | undefined>,
  curves: Map<number, CurveEvaluator | undefined>): SurfaceEvaluator | undefined {
  const inf: [number, number] = [-Infinity, Infinity];
  switch (s.kind) {
    case 'plane': {
      const { o, x, y } = axes(s.position);
      return { u: inf, v: inf, point: (u, v) => add(o, add(scale(x, u), scale(y, v))), d1: () => [x, y],
        params: (p) => { const q = sub(p, o); return [dot(q, x), dot(q, y)]; } };
    }
    case 'cylinder': case 'cone': {
      const { o, x, y, z } = axes(s.position);
      const R = s.radius, k = s.kind === 'cone' ? Math.tan(s.semiAngle) : 0;
      const ring = (u: number) => add(scale(x, Math.cos(u)), scale(y, Math.sin(u)));
      return { u: [0, TWO_PI], v: inf, uPeriod: TWO_PI,
        point: (u, v) => add(o, add(scale(ring(u), R + v * k), scale(z!, v))),
        d1: (u, v) => [scale(add(scale(x, -Math.sin(u)), scale(y, Math.cos(u))), R + v * k),
          add(scale(ring(u), k), z!)],
        params: (p) => {
          const q = sub(p, o), v = dot(q, z!), qx = dot(q, x), qy = dot(q, y);
          if (Math.hypot(qx, qy) <= 1e-12 * Math.max(1, R)) return undefined;
          // Past a cone's apex the radius R + v tan(a) is negative: the point is reached from across the axis.
          return [wrap(Math.atan2(qy, qx) + (R + v * k < 0 ? Math.PI : 0)), v];
        } };
    }
    case 'sphere': {
      const { o, x, y, z } = axes(s.position), R = s.radius;
      return { u: [0, TWO_PI], v: [-Math.PI / 2, Math.PI / 2], uPeriod: TWO_PI,
        point: (u, v) => add(o, scale(add(scale(add(scale(x, Math.cos(u)), scale(y, Math.sin(u))), Math.cos(v)),
          scale(z!, Math.sin(v))), R)),
        d1: (u, v) => [scale(add(scale(x, -Math.sin(u)), scale(y, Math.cos(u))), R * Math.cos(v)),
          scale(add(scale(add(scale(x, Math.cos(u)), scale(y, Math.sin(u))), -Math.sin(v)), scale(z!, Math.cos(v))),
            R)],
        params: (p) => {
          const q = sub(p, o), qx = dot(q, x), qy = dot(q, y), rho = Math.hypot(qx, qy);
          return rho <= 1e-12 * R ? undefined : [wrap(Math.atan2(qy, qx)), Math.atan2(dot(q, z!), rho)];
        } };
    }
    case 'torus': {
      const { o, x, y, z } = axes(s.position), R = s.majorRadius, r = s.minorRadius;
      const ring = (u: number) => add(scale(x, Math.cos(u)), scale(y, Math.sin(u)));
      return { u: [0, TWO_PI], v: [0, TWO_PI], uPeriod: TWO_PI, vPeriod: TWO_PI,
        point: (u, v) => add(o, add(scale(ring(u), R + r * Math.cos(v)), scale(z!, r * Math.sin(v)))),
        d1: (u, v) => [scale(add(scale(x, -Math.sin(u)), scale(y, Math.cos(u))), R + r * Math.cos(v)),
          add(scale(ring(u), -r * Math.sin(v)), scale(z!, r * Math.cos(v)))],
        params: (p) => {
          const q = sub(p, o), qx = dot(q, x), qy = dot(q, y), rho = Math.hypot(qx, qy);
          if (rho <= 1e-12 * Math.max(1, R)) return undefined;
          // Inside a spindle torus (minor radius over major) a point is reached from the far side of the axis, R + r
          // cos v negative: the branch whose tube circle the point is on.
          const qz = dot(q, z!), u = Math.atan2(qy, qx);
          if (Math.abs(Math.hypot(-rho - R, qz) - r) < Math.abs(Math.hypot(rho - R, qz) - r)) {
            return [wrap(u + Math.PI), wrap(Math.atan2(qz, -rho - R))];
          }
          return [wrap(u), wrap(Math.atan2(qz, rho - R))];
        } };
    }
    case 'bspline': {
      const U = fullKnots(s.uKnots, s.uMultiplicities), V = fullKnots(s.vKnots, s.vMultiplicities);
      const nu = s.poles.length, nv = s.poles[0]!.length, p = s.uDegree, q = s.vDegree;
      const at = (u: number, v: number): [Vec, Vec, Vec] => {
        const su = findSpan(nu, p, u, U), sv = findSpan(nv, q, v, V);
        const [Nu, Du] = basis(su, u, p, U), [Nv, Dv] = basis(sv, v, q, V);
        let A = [0, 0, 0], Au = [0, 0, 0], Av = [0, 0, 0], W = 0, Wu = 0, Wv = 0;
        for (let a = 0; a <= p; a++) for (let b = 0; b <= q; b++) {
          const i = su - p + a, j = sv - q + b, w = s.weights ? s.weights[i]![j]! : 1, P = s.poles[i]![j]!;
          const f = Nu[a]! * Nv[b]! * w, fu = Du[a]! * Nv[b]! * w, fv = Nu[a]! * Dv[b]! * w;
          A = add(A, scale(P, f)); Au = add(Au, scale(P, fu)); Av = add(Av, scale(P, fv));
          W += f; Wu += fu; Wv += fv;
        }
        const c = scale(A, 1 / W);
        return [c, scale(sub(Au, scale(c, Wu)), 1 / W), scale(sub(Av, scale(c, Wv)), 1 / W)];
      };
      return { u: [U[p]!, U[nu]!], v: [V[q]!, V[nv]!], spans: [s.uKnots.length - 1, s.vKnots.length - 1],
        point: (u, v) => at(u, v)[0],
        d1: (u, v) => { const r = at(u, v); return [r[1], r[2]]; } };
    }
    case 'extrusion': {
      const c = curveEvaluator(d, s.curve, curves);
      if (!c) return undefined;
      const V = scale(s.direction, s.magnitude);
      return { u: c.range, v: inf, ...(c.period ? { uPeriod: c.period } : {}),
        point: (u, v) => add(c.point(u), scale(V, v)), d1: (u) => [c.d1(u), V] };
    }
    case 'revolution': {
      const c = curveEvaluator(d, s.curve, curves);
      if (!c) return undefined;
      const A = s.axisOrigin, a = s.axisDirection;
      // Rodrigues: q turned by u about the axis, and the derivative of that in u.
      const turn = (q: Vec, u: number) => add(add(scale(q, Math.cos(u)), scale(cross(a, q), Math.sin(u))),
        scale(a, dot(a, q) * (1 - Math.cos(u))));
      const dturn = (q: Vec, u: number) => add(add(scale(q, -Math.sin(u)), scale(cross(a, q), Math.cos(u))),
        scale(a, dot(a, q) * Math.sin(u)));
      return { u: [0, TWO_PI], v: c.range, uPeriod: TWO_PI, point: (u, v) => add(A, turn(sub(c.point(v), A), u)),
        d1: (u, v) => [dturn(sub(c.point(v), A), u), turn(c.d1(v), u)] };
    }
    case 'offset': {
      const b = surfaceEvaluator(d, s.basis, cache, curves);
      if (!b) return undefined;
      const point = (u: number, v: number) => {
        const [su, sv] = b.d1(u, v);
        return add(b.point(u, v), scale(unit(cross(su, sv)), s.distance));
      };
      const h = 1e-7;
      return { ...b, point, d1: (u, v) => [scale(sub(point(u + h, v), point(u - h, v)), 1 / (2 * h)),
        scale(sub(point(u, v + h), point(u, v - h)), 1 / (2 * h))],
      params: undefined };
    }
    case 'rectangularTrimmed': {
      const b = surfaceEvaluator(d, s.basis, cache, curves);
      if (!b) return undefined;
      const [u1, u2] = s.u1 <= s.u2 ? [s.u1, s.u2] : [s.u2, s.u1];
      const [v1, v2] = s.v1 <= s.v2 ? [s.v1, s.v2] : [s.v2, s.v1];
      return { ...b, u: [u1, u2], v: [v1, v2] };
    }
    case 'curveSwept': case 'fixedReferenceSwept': return undefined;
  }
}

/** A surface's unit normal at (u, v) as Part 42 orients it (S_u x S_v), or undefined where it vanishes. */
export function normalAt(s: SurfaceEvaluator, u: number, v: number): Vec | undefined {
  const [su, sv] = s.d1(u, v), n = cross(su, sv), l = norm(n);
  return l > 0 ? scale(n, 1 / l) : undefined;
}

/**
 * A point's parameters on a surface over finite ranges, nearest first: a grid of samples (8 a knot span on B-spline
 * surfaces, at least `samples` each way), then Gauss-Newton steps kept in range from each of the best few local
 * minima on the grid, the nearest kept. Undefined where a range is unbounded. Closed-form `params` is better where it
 * exists.
 */
export function nearestParams(s: SurfaceEvaluator, p: Vec, samples = 24): [number, number] | undefined {
  const [u0, u1] = s.u, [v0, v1] = s.v;
  if (![u0, u1, v0, v1].every(Number.isFinite)) return undefined;
  const nu = Math.max(samples, 8 * (s.spans?.[0] ?? 0)), nv = Math.max(samples, 8 * (s.spans?.[1] ?? 0));
  const grid: number[][] = [];
  for (let i = 0; i <= nu; i++) {
    const row: number[] = [];
    for (let j = 0; j <= nv; j++) row.push(norm(sub(s.point(u0 + (u1 - u0) * i / nu, v0 + (v1 - v0) * j / nv), p)));
    grid.push(row);
  }
  const minima: [number, number][] = [];
  for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
    const g = grid[i]![j]!;
    let low = true;
    for (const [a, b] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const x = grid[i + a]?.[j + b];
      if (x !== undefined && x < g) low = false;
    }
    if (low) minima.push([i, j]);
  }
  minima.sort((a, b) => grid[a[0]]![a[1]]! - grid[b[0]]![b[1]]!);
  const clamp = (x: number, a: number, b: number) => Math.min(Math.max(x, a), b);
  let best: [number, number] = [u0, v0], bestD = Infinity;
  for (const [i, j] of minima.slice(0, 4)) {
    let bu = u0 + (u1 - u0) * i / nu, bv = v0 + (v1 - v0) * j / nv;
    for (let k = 0; k < 30; k++) {
      const r = sub(p, s.point(bu, bv)), [su, sv] = s.d1(bu, bv);
      const a = dot(su, su), b = dot(su, sv), c = dot(sv, sv), det = a * c - b * b;
      if (!(Math.abs(det) > 1e-300)) break;
      const gu = dot(su, r), gv = dot(sv, r);
      const nu2 = clamp(bu + (c * gu - b * gv) / det, u0, u1), nv2 = clamp(bv + (a * gv - b * gu) / det, v0, v1);
      if (norm(sub(s.point(nu2, nv2), p)) > norm(r)) break;
      const done = Math.abs(nu2 - bu) <= 1e-14 * Math.max(1, Math.abs(bu))
        && Math.abs(nv2 - bv) <= 1e-14 * Math.max(1, Math.abs(bv));
      bu = nu2;
      bv = nv2;
      if (done) break;
    }
    const dd = norm(sub(s.point(bu, bv), p));
    if (dd < bestD) { bestD = dd; best = [bu, bv]; }
  }
  return best;
}

/**
 * An edge's parameters on its 3D curve at its start and end, in that order (decreasing where the edge runs against
 * the curve): its `range` where it has one, else its vertices' parameters, a closed curve's period added or taken
 * away so the edge runs the way `sameSense` says (a whole turn where start and end are one vertex). An edge without
 * vertices covers its curve's range. Undefined without a curve, or a vertex that has no parameter.
 */
export function edgeParams(d: BrepData, e: number, c: CurveEvaluator): [number, number] | undefined {
  const r0 = d.edge.range[2 * e]!, r1 = d.edge.range[2 * e + 1]!;
  if (Number.isFinite(r0) && Number.isFinite(r1)) return [r0, r1];
  const s = d.edge.start[e]!, t = d.edge.end[e]!, same = d.edge.sameSense[e] === 1;
  if (s < 0 || t < 0) return same ? c.range : [c.range[1], c.range[0]];
  const at = (v: number) => c.param(Array.from(d.vertex.point.subarray(3 * v, 3 * v + 3)));
  let ts = at(s);
  let te = s === t ? ts : at(t);
  if (ts === undefined || te === undefined) return undefined;
  const P = c.period;
  if (P) {
    if (s === t) te = ts + (same ? P : -P);
    else if (same && te <= ts) te += P;
    else if (!same && te >= ts) te -= P;
  } else if (Number.isFinite(c.range[0]) && Number.isFinite(c.range[1])) {
    // A curve that closes without a period (a closed B-spline): a vertex at its junction is either end, whichever
    // runs the edge the way `sameSense` says; one vertex, the whole curve.
    const [lo, hi] = c.range, a = c.point(lo), b = c.point(hi);
    const at = (f: number) => c.point(lo + f * (hi - lo));
    const size = Math.max(...[0.25, 0.5, 0.75].map((f) => norm(sub(at(f), a))));
    if (norm(sub(a, b)) <= CLOSED * size) {
      if (s === t) return same ? [lo, hi] : [hi, lo];
      const end = (x: number) => Math.abs(x - lo) <= CLOSED * (hi - lo) || Math.abs(x - hi) <= CLOSED * (hi - lo);
      if (same && te < ts) {
        if (end(te)) te = hi;
        else if (end(ts)) ts = lo;
      } else if (!same && te > ts) {
        if (end(te)) te = lo;
        else if (end(ts)) ts = hi;
      }
    }
  }
  return [ts, te];
}

/** A curve's ends closer than this, relative to its size, close it. */
const CLOSED = 1e-9;
