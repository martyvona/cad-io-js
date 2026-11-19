// pcurveReparam: a source's p-curve whose image is right but whose parameter is an affine function of its edge's
// curve's, s = a t + b, rewritten with the curve's parameter t (the model's rule: a p-curve's parameter is its 3D
// curve's). Exact: a line's point, direction and magnitude, a B-spline's knots (and with a < 0 its knots, poles,
// weights and multiplicities reversed) take the map; other kinds return undefined (a conic's angle takes only a = +-1,
// rare enough to leave to replacement).

import { type BrepData, CURVE_KIND } from 'cad-brep';
import type { Curve2 } from '../edit.ts';

/** The p-curve row `row` (dim 2) reparameterized by s = a t + b, or undefined for a kind not handled; `snap` as
 * reparameterize's. */
export function reparameterized(d: BrepData, row: number, a: number, b: number, snap?: [number, number]):
  Curve2 | undefined {
  if (d.curve.dim[row] !== 2) return undefined;
  return reparameterize({ kind: d.curve.kind[row]!, reals: d.pool.curveReal.subarray(d.curve.real[row]!),
    ints: d.pool.curveInt.subarray(d.curve.int[row]!) }, a, b, snap);
}

/**
 * A 2D curve in the model's form reparameterized by s = a t + b (its reals and ints may run past its own: only its
 * kind's are read), or undefined for a kind not handled. A B-spline's knots within 1e-9 of the span of `snap` (the
 * edge's range) of its ends are put on them exactly: the map's rounding can leave the last knot an ulp short of the
 * range's end, where evaluation then refuses it as outside the domain.
 */
export function reparameterize(c: Curve2, a: number, b: number, snap?: [number, number]): Curve2 | undefined {
  if (!(Number.isFinite(a) && a !== 0 && Number.isFinite(b))) return undefined;
  const R = c.reals, I = c.ints, k = c.kind;
  if (k === CURVE_KIND.line) {
    // p(s) = P + s m D, so p(a t + b) = (P + b m D) + t (a m) D.
    const [px, py, dx, dy, m] = [R[0]!, R[1]!, R[2]!, R[3]!, R[4]!];
    const sgn = Math.sign(a);
    return { kind: k, reals: [px + b * m * dx, py + b * m * dy, sgn * dx, sgn * dy, Math.abs(a) * m], ints: [] };
  }
  if (k === CURVE_KIND.bspline) {
    const [degree, n, nk, rational, closed, self, form] = [I[0]!, I[1]!, I[2]!, I[3]!, I[4]!, I[5]!, I[6]!];
    const knots = Array.from({ length: nk }, (_, j) => (R[j]! - b) / a);
    if (snap) {
      const near = 1e-9 * Math.abs(snap[1] - snap[0]);
      for (let j = 0; j < nk; j++) for (const t of snap) if (Math.abs(knots[j]! - t) <= near) knots[j] = t;
    }
    const poles: number[][] = [];
    for (let j = 0; j < n; j++) poles.push([R[nk + 2 * j]!, R[nk + 2 * j + 1]!]);
    const weights = rational ? Array.from({ length: n }, (_, j) => R[nk + 2 * n + j]!) : [];
    const mults = Array.from({ length: nk }, (_, j) => I[7 + j]!);
    if (a < 0) knots.reverse(), poles.reverse(), weights.reverse(), mults.reverse();
    return { kind: k, reals: [...knots, ...poles.flat(), ...weights],
      ints: [degree, n, nk, rational, closed, self, form, ...mults] };
  }
  return undefined;
}
