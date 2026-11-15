// Closed forms of each curve and surface kind to second derivatives, in Part 42's parameterizations as
// docs/brep-reference.md gives them, written from those definitions (not from geometry.ts): the facts' source.

import { type CurveEval, type SurfaceEval } from './maker.ts';
import { add, cross, dot, lin, mul, type V } from './vec.ts';

const Z3: V = [0, 0, 0];

export interface Frame {
  o: V;
  x: V;
  y: V;
  z: V;
}

/** A placement's frame: y = z x x. */
export const frame = (o: V, z: V, x: V): Frame => ({ o, x, y: cross(z, x), z });

export const lineEv = (p: V, u: V, m: number): CurveEval => (t) => ({ p: add(p, mul(u, t * m)), d1: mul(u, m),
  d2: u.map(() => 0) });

/** A circle or ellipse in a 3D frame or a 2D one (o, x, y). */
export const ellipseEv = (o: V, x: V, y: V, a: number, b: number): CurveEval => (t) => {
  const c = Math.cos(t), s = Math.sin(t);
  return { p: lin([1, o], [a * c, x], [b * s, y]), d1: lin([-a * s, x], [b * c, y]),
    d2: lin([-a * c, x], [-b * s, y]) };
};

export const hyperbolaEv = (o: V, x: V, y: V, a: number, b: number): CurveEval => (t) => {
  const c = Math.cosh(t), s = Math.sinh(t);
  return { p: lin([1, o], [a * c, x], [b * s, y]), d1: lin([a * s, x], [b * c, y]), d2: lin([a * c, x], [b * s, y]) };
};

/** C(t) = o + f (t^2 x + 2 t y). */
export const parabolaEv = (o: V, x: V, y: V, f: number): CurveEval => (t) => ({
  p: lin([1, o], [f * t * t, x], [2 * f * t, y]), d1: lin([2 * f * t, x], [2 * f, y]), d2: mul(x, 2 * f) });

/** The parabola's length from t0 to t1: f times the integral of 2 sqrt(1 + t^2). */
export const parabolaLength = (f: number, t0: number, t1: number): number => {
  const F = (t: number) => t * Math.sqrt(1 + t * t) + Math.asinh(t);
  return Math.abs(f) * (F(t1) - F(t0));
};

/** A polyline: segment k over [k, k + 1]. */
export const polylineEv = (P: V[]): CurveEval => (t) => {
  const k = Math.min(Math.max(Math.floor(t), 0), P.length - 2), d = P[k + 1]!.map((x, c) => x - P[k]![c]!);
  return { p: add(P[k]!, mul(d, t - k)), d1: d, d2: d.map(() => 0) };
};

/** A composite's segment k over [k, k + 1], mapped linearly onto [a, b] of its curve (reversed if not same sense). */
export const compositeEv = (segs: { ev: CurveEval; a: number; b: number; sameSense: boolean }[]): CurveEval =>
  (t) => {
    const k = Math.min(Math.max(Math.floor(t), 0), segs.length - 1), g = segs[k]!, f = t - k, h = g.b - g.a;
    const r = g.ev(g.sameSense ? g.a + f * h : g.b - f * h), j = g.sameSense ? h : -h;
    return { p: r.p, d1: mul(r.d1, j), d2: mul(r.d2, j * j) };
  };

// -- Surfaces.

export const planeEv = (F: Frame): SurfaceEval => (u, v) => ({ p: lin([1, F.o], [u, F.x], [v, F.y]), du: F.x,
  dv: F.y, duu: Z3, duv: Z3, dvv: Z3 });

/** A cone (k = tan of the semi-angle) or, with k = 0, a cylinder: o + (r + v k)(cos u x + sin u y) + v z. */
export const coneEv = (F: Frame, r: number, k: number): SurfaceEval => (u, v) => {
  const c = Math.cos(u), s = Math.sin(u), e = lin([c, F.x], [s, F.y]), e1 = lin([-s, F.x], [c, F.y]);
  const rho = r + v * k;
  return { p: lin([1, F.o], [rho, e], [v, F.z]), du: mul(e1, rho), dv: lin([k, e], [1, F.z]), duu: mul(e, -rho),
    duv: mul(e1, k), dvv: Z3 };
};

export const sphereEv = (F: Frame, R: number): SurfaceEval => (u, v) => {
  const c = Math.cos(u), s = Math.sin(u), e = lin([c, F.x], [s, F.y]), e1 = lin([-s, F.x], [c, F.y]);
  const cv = Math.cos(v), sv = Math.sin(v);
  return { p: lin([1, F.o], [R * cv, e], [R * sv, F.z]), du: mul(e1, R * cv), dv: lin([-R * sv, e], [R * cv, F.z]),
    duu: mul(e, -R * cv), duv: mul(e1, -R * sv), dvv: lin([-R * cv, e], [-R * sv, F.z]) };
};

export const torusEv = (F: Frame, R: number, r: number): SurfaceEval => (u, v) => {
  const c = Math.cos(u), s = Math.sin(u), e = lin([c, F.x], [s, F.y]), e1 = lin([-s, F.x], [c, F.y]);
  const cv = Math.cos(v), sv = Math.sin(v), rho = R + r * cv;
  return { p: lin([1, F.o], [rho, e], [r * sv, F.z]), du: mul(e1, rho), dv: lin([-r * sv, e], [r * cv, F.z]),
    duu: mul(e, -rho), duv: mul(e1, -r * sv), dvv: lin([-r * cv, e], [-r * sv, F.z]) };
};

/** S(u, v) = C(u) + v m D. */
export const extrusionEv = (C: CurveEval, D: V, m: number): SurfaceEval => (u, v) => {
  const c = C(u);
  return { p: lin([1, c.p], [v * m, D]), du: c.d1, dv: mul(D, m), duu: c.d2, duv: Z3, dvv: Z3 };
};

/** S(u, v): C(v) turned by u about the axis through A along the unit a (Rodrigues), and its partials. */
export const revolutionEv = (C: CurveEval, A: V, a: V): SurfaceEval => (u, v) => {
  const c = Math.cos(u), s = Math.sin(u);
  // R(u) q = c q + s (a x q) + (1 - c)(a . q) a, and its derivatives in u.
  const R = (q: V) => lin([c, q], [s, cross(a, q)], [(1 - c) * dot(a, q), a]);
  const R1 = (q: V) => lin([-s, q], [c, cross(a, q)], [s * dot(a, q), a]);
  const R2 = (q: V) => lin([-c, q], [-s, cross(a, q)], [c * dot(a, q), a]);
  const g = C(v), q = g.p.map((x, k) => x - A[k]!);
  return { p: add(A, R(q)), du: R1(q), dv: R(g.d1), duu: R2(q), duv: R1(g.d1), dvv: R(g.d2) };
};
