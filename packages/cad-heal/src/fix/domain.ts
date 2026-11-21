// P-curves kept on their surface's domain: a fitted p-curve (a projection's, a trace's) can overshoot a side of a
// direction that isn't periodic (an end a hair past the iso-line it runs along or ends on), and a source's line can
// end past one by its rounding; evaluation there is refused as outside the domain, by the face API, whose use's ends
// then don't reach their vertices ("a p-curve's range off its domain"), and by every consumer. A B-spline's poles are
// clamped into the domain there; a line is passed through its ends clamped (at the edge's range, its parameter). The
// caller measures the move on the surface (curves.ts), which its edge's tolerance then covers. Other kinds (conics)
// are left.

import { CURVE_KIND } from 'cad-brep';
import type { Curve2 } from '../edit.ts';

/** A 2D curve placed on [u0, u1] x [v0, v1] (a side left open where its bound isn't finite). */
export interface Placed {
  curve: Curve2;
  /** The largest pole's (or end's) move in u and in v (0, 0 where nothing moved). */
  du: number;
  dv: number;
}

/** The points that bound curve c over `range` (a B-spline's poles; a line's ends there, given a finite range). */
export function hullOf(c: Curve2, range?: [number, number]): [number, number][] {
  if (c.kind === CURVE_KIND.bspline) {
    const n = c.ints[1]!, nk = c.ints[2]!;
    return Array.from({ length: n }, (_, j) => [c.reals[nk + 2 * j]!, c.reals[nk + 2 * j + 1]!]);
  }
  if (c.kind === CURVE_KIND.line && range && Number.isFinite(range[0]) && Number.isFinite(range[1])) {
    const [px, py, dx, dy, m] = [c.reals[0]!, c.reals[1]!, c.reals[2]!, c.reals[3]!, c.reals[4]!];
    return range.map((t) => [px + t * m * dx, py + t * m * dy]);
  }
  return [];
}

/** How far curve c's hull lies outside [u0, u1] and [v0, v1], per direction (0 inside, or a kind not handled). */
export function overshoot(c: Curve2, u: [number, number], v: [number, number], range?: [number, number]):
  [number, number] {
  let ou = 0, ov = 0;
  for (const [x, y] of hullOf(c, range)) {
    ou = Math.max(ou, u[0] - x, x - u[1]), ov = Math.max(ov, v[0] - y, y - v[1]);
  }
  return [ou, ov];
}

/** c placed in the box in the directions `clampU`, `clampV` (a line over `range`, its parameter). */
export function intoDomain(c: Curve2, u: [number, number], v: [number, number], clampU: boolean, clampV: boolean,
  range?: [number, number]): Placed {
  const pts = hullOf(c, range);
  if (!pts.length || (!clampU && !clampV)) return { curve: c, du: 0, dv: 0 };
  let du = 0, dv = 0;
  const moved = pts.map(([x, y]) => {
    const x2 = clampU ? Math.min(Math.max(x, u[0]), u[1]) : x, y2 = clampV ? Math.min(Math.max(y, v[0]), v[1]) : y;
    du = Math.max(du, Math.abs(x2 - x)), dv = Math.max(dv, Math.abs(y2 - y));
    return [x2, y2] as [number, number];
  });
  if (c.kind === CURVE_KIND.line) {
    // Through the ends moved, in the same parameter: p(t) = P + t m D.
    const [t0, t1] = range!, [a, b] = moved as [[number, number], [number, number]];
    const vx = (b[0] - a[0]) / (t1 - t0), vy = (b[1] - a[1]) / (t1 - t0), m = Math.hypot(vx, vy);
    if (!(m > 0)) return { curve: c, du: 0, dv: 0 };
    return { curve: { kind: c.kind, reals: [a[0] - t0 * vx, a[1] - t0 * vy, vx / m, vy / m, m], ints: [] }, du, dv };
  }
  // A B-spline's own reals only (a view of a model's pool runs on past them): knots, poles, weights.
  const n = c.ints[1]!, nk = c.ints[2]!, rational = c.ints[3]! !== 0, ni = 7 + nk;
  const reals = Array.from({ length: nk + 2 * n + (rational ? n : 0) }, (_, j) => c.reals[j]!);
  moved.forEach(([x, y], j) => { reals[nk + 2 * j] = x, reals[nk + 2 * j + 1] = y; });
  return { curve: { kind: c.kind, reals, ints: Array.from({ length: ni }, (_, j) => c.ints[j]!) }, du, dv };
}

/** Curve c (a 2D line or B-spline in the model's form, rational or not) at t, or undefined for another kind. */
export function evalCurve2(c: Curve2, t: number): [number, number] | undefined {
  if (c.kind === CURVE_KIND.line) {
    const [px, py, dx, dy, m] = [c.reals[0]!, c.reals[1]!, c.reals[2]!, c.reals[3]!, c.reals[4]!];
    return [px + t * m * dx, py + t * m * dy];
  }
  if (c.kind !== CURVE_KIND.bspline) return undefined;
  const p = c.ints[0]!, n = c.ints[1]!, nk = c.ints[2]!, rational = c.ints[3]! !== 0;
  const U: number[] = [];
  for (let j = 0; j < nk; j++) for (let k = 0; k < c.ints[7 + j]!; k++) U.push(c.reals[j]!);
  t = Math.min(Math.max(t, U[p]!), U[n]!);
  let s = p;
  while (s < n - 1 && t >= U[s + 1]!) s++;
  // de Boor in homogeneous coordinates.
  const d = Array.from({ length: p + 1 }, (_, j) => {
    const i = s - p + j, w = rational ? c.reals[nk + 2 * n + i]! : 1;
    return [c.reals[nk + 2 * i]! * w, c.reals[nk + 2 * i + 1]! * w, w];
  });
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = s - p + j, den = U[i + p + 1 - r]! - U[i]!, a = den > 0 ? (t - U[i]!) / den : 0;
      for (let k = 0; k < 3; k++) d[j]![k] = (1 - a) * d[j - 1]![k]! + a * d[j]![k]!;
    }
  }
  return [d[p]![0]! / d[p]![2]!, d[p]![1]! / d[p]![2]!];
}
