// pcurveReparam: a source's p-curve whose image is right but whose parameter is an affine function of its edge's
// curve's, s = a t + b, rewritten with the curve's parameter t (the model's rule: a p-curve's parameter is its 3D
// curve's). Exact: a line's point, direction and magnitude, a B-spline's knots (and with a < 0 its knots, poles,
// weights and multiplicities reversed) take the map; other kinds return undefined (a conic's angle takes only a = +-1,
// rare enough to leave to replacement).

import { type BrepData, CURVE_KIND } from 'cad-brep';
import type { Curve2 } from '../edit.ts';

/** The p-curve row `row` (dim 2) reparameterized by s = a t + b, or undefined for a kind not handled. */
export function reparameterized(d: BrepData, row: number, a: number, b: number): Curve2 | undefined {
  if (!(Number.isFinite(a) && a !== 0 && Number.isFinite(b)) || d.curve.dim[row] !== 2) return undefined;
  const R = d.pool.curveReal, I = d.pool.curveInt, r = d.curve.real[row]!, k = d.curve.kind[row]!;
  if (k === CURVE_KIND.line) {
    // p(s) = P + s m D, so p(a t + b) = (P + b m D) + t (a m) D.
    const [px, py, dx, dy, m] = [R[r]!, R[r + 1]!, R[r + 2]!, R[r + 3]!, R[r + 4]!];
    const sgn = Math.sign(a);
    return { kind: k, reals: [px + b * m * dx, py + b * m * dy, sgn * dx, sgn * dy, Math.abs(a) * m], ints: [] };
  }
  if (k === CURVE_KIND.bspline) {
    const i = d.curve.int[row]!, [degree, n, nk, rational, closed, self, form] = [I[i]!, I[i + 1]!, I[i + 2]!, I[i + 3]!,
      I[i + 4]!, I[i + 5]!, I[i + 6]!];
    const knots = Array.from(R.subarray(r, r + nk), (s) => (s - b) / a);
    const poles: number[][] = [];
    for (let j = 0; j < n; j++) poles.push([R[r + nk + 2 * j]!, R[r + nk + 2 * j + 1]!]);
    const weights = rational ? Array.from(R.subarray(r + nk + 2 * n, r + nk + 3 * n)) : [];
    const mults = Array.from(I.subarray(i + 7, i + 7 + nk));
    if (a < 0) knots.reverse(), poles.reverse(), weights.reverse(), mults.reverse();
    return { kind: k, reals: [...knots, ...poles.flat(), ...weights],
      ints: [degree, n, nk, rational, closed, self, form, ...mults] };
  }
  return undefined;
}
