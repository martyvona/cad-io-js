// strayPole: a 3D B-spline curve's pole thrown far out of the part, inside a span too short to matter, moved onto its
// neighbours' common point. Such a pole makes the curve leave the part and come back inside that span (a curve that
// is otherwise right on its faces), which every measure along the curve then sees. The rule is narrow on purpose:
// a pole is moved only where all three hold, and anything else is left for the projection to report.
//   1. it lies more than FAR x the part's size outside the part's vertices' box;
//   2. its support (the knot interval it acts on, U[i] to U[i + degree + 1]) is under SPAN of the curve's knot range;
//   3. it isn't an end pole, and the poles either side of it are within the curve's tolerance of each other (the
//      largest of the edges on it, or the part's where none is: a curve used only as another's part, a trimmed
//      curve's basis, say, is judged by the part's, the stricter).
// Moved onto the neighbours' midpoint, the curve within that support stays within the tolerance of them.

import { type BrepData, CURVE_KIND, rowCount } from 'cad-brep';

/** How far outside the part's box (in part sizes) a pole must be to be moved. */
export const FAR = 1e3;
/** The largest share of its curve's knot range a moved pole's support may have. */
export const SPAN = 1e-4;

export interface PoleMove {
  /** The curve row, and the pole's index among its poles. */
  curve: number;
  pole: number;
  /** The pool index of the pole's x (y and z follow), and where it goes. */
  at: number;
  to: [number, number, number];
  /** How far it was outside the part's box, in mm. */
  out: number;
}

/**
 * The stray poles of `d`'s 3D B-spline curves under the rule above; `tolOf(row)` the tolerance a curve row is judged
 * by, `size` the part's (its vertices' box diagonal, `lo` and `hi` that box's corners).
 */
export function strayPoles(d: BrepData, tolOf: (row: number) => number, size: number, lo: number[], hi: number[]):
  PoleMove[] {
  const moves: PoleMove[] = [];
  if (!(size > 0)) return moves;
  const R = d.pool.curveReal, I = d.pool.curveInt;
  for (let c = 0; c < rowCount(d, 'curve'); c++) {
    if (d.curve.kind[c] !== CURVE_KIND.bspline || d.curve.dim[c] !== 3) continue;
    const r = d.curve.real[c]!, i0 = d.curve.int[c]!;
    const degree = I[i0]!, n = I[i0 + 1]!, nk = I[i0 + 2]!;
    const U: number[] = [];
    for (let j = 0; j < nk; j++) for (let m = 0; m < I[i0 + 7 + j]!; m++) U.push(R[r + j]!);
    const range = U[U.length - 1]! - U[0]!;
    if (!(range > 0)) continue;
    const at = (i: number) => r + nk + 3 * i;
    for (let i = 1; i < n - 1; i++) {
      const p = at(i);
      const out = Math.hypot(...[0, 1, 2].map((k) => Math.max(lo[k]! - R[p + k]!, 0, R[p + k]! - hi[k]!)));
      if (!(out > FAR * size)) continue;
      if (!(U[i + degree + 1]! - U[i]! < SPAN * range)) continue;
      const a = at(i - 1), b = at(i + 1);
      if (!(Math.hypot(R[a]! - R[b]!, R[a + 1]! - R[b + 1]!, R[a + 2]! - R[b + 2]!) <= tolOf(c))) continue;
      moves.push({ curve: c, pole: i, at: p, out,
        to: [0, 1, 2].map((k) => (R[a + k]! + R[b + k]!) / 2) as [number, number, number] });
    }
  }
  return moves;
}

/** Per curve row, the largest tolerance of the edges on it. */
export function curveTolerances(d: BrepData, edgeTol: (e: number) => number): Map<number, number> {
  const out = new Map<number, number>();
  for (let e = 0; e < rowCount(d, 'edge'); e++) {
    const c = d.edge.curve[e]!, t = edgeTol(e);
    if (c >= 0 && !((out.get(c) ?? -Infinity) >= t)) out.set(c, t);
  }
  return out;
}
