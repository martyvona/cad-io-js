// pcurveMissingOnPlane: a bare use's p-curve on a plane, the exact image of its edge's curve by the plane's (u, v)
// map (the face API's affine map: u = a . (P - o), v = b . (P - o)), in the curve's own parameter, as every consumer
// could derive it; for the curves whose projection the face API gives no model form of (its kind 0, the map given).
// Lines, B-splines and polylines map point by point; a conic maps its placement, which keeps its parameter only where
// it turns the plane's way (its axis along the plane's normal): one turning the other way, and the other kinds
// (trimmed, composite, offset), are left without.

import { type BrepData, CURVE_KIND } from 'cad-brep';
import type { Curve2 } from '../edit.ts';

/** The image of 3D curve row `k` by the map `affine` (a, b, o: 9 reals), or why there's none. */
export function planeImage(d: BrepData, k: number, affine: ArrayLike<number>): Curve2 | { why: string } {
  const kind = d.curve.kind[k]!, at = d.curve.real[k]!, R = d.pool.curveReal;
  if (d.curve.dim[k] !== 3) return { why: 'not a 3D curve' };
  if (![0, 1, 2, 3, 4, 5].some((i) => affine[i] !== 0)) return { why: 'no map given' };
  const a = [affine[0]!, affine[1]!, affine[2]!], b = [affine[3]!, affine[4]!, affine[5]!];
  const o = [affine[6]!, affine[7]!, affine[8]!];
  const dot = (p: number[], q: ArrayLike<number>, i = 0) => p[0]! * q[i]! + p[1]! * q[i + 1]! + p[2]! * q[i + 2]!;
  const point = (i: number) => {
    const q = [R[i]! - o[0]!, R[i + 1]! - o[1]!, R[i + 2]! - o[2]!];
    return [dot(a, q), dot(b, q)];
  };
  const vector = (i: number) => [dot(a, R, i), dot(b, R, i)];
  // A conic's placement (origin, axis, x direction) to the plane's: its origin and x direction mapped, where its axis
  // is along the plane's normal (a x b).
  const placement = (i: number) => {
    const n = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
    if (!(dot(n, R, i + 3) > 0)) return undefined;
    const x = vector(i + 6), m = Math.hypot(x[0]!, x[1]!);
    return m > 0 ? [...point(i), x[0]! / m, x[1]! / m] : undefined;
  };
  switch (kind) {
    case CURVE_KIND.line: {
      // The parameter is distance / magnitude: the image's direction made unit, its magnitude scaled to match.
      const v = vector(at + 3), m = Math.hypot(v[0]!, v[1]!);
      if (!(m > 0)) return { why: 'a line square to the plane' };
      return { kind, reals: [...point(at), v[0]! / m, v[1]! / m, R[at + 6]! * m], ints: [] };
    }
    case CURVE_KIND.circle: case CURVE_KIND.ellipse: case CURVE_KIND.hyperbola: case CURVE_KIND.parabola: {
      const p = placement(at);
      if (!p) return { why: 'a conic turning the other way in (u, v)' };
      const rest = kind === CURVE_KIND.circle || kind === CURVE_KIND.parabola ? 1 : 2;
      return { kind, reals: [...p, ...Array.from({ length: rest }, (_, j) => R[at + 9 + j]!)], ints: [] };
    }
    case CURVE_KIND.bspline: {
      const I = d.pool.curveInt, ia = d.curve.int[k]!;
      const n = I[ia + 1]!, nk = I[ia + 2]!, rational = I[ia + 3] === 1;
      const reals: number[] = [];
      for (let j = 0; j < nk; j++) reals.push(R[at + j]!);
      for (let j = 0; j < n; j++) reals.push(...point(at + nk + 3 * j));
      if (rational) for (let j = 0; j < n; j++) reals.push(R[at + nk + 3 * n + j]!);
      return { kind, reals, ints: Array.from({ length: 7 + nk }, (_, j) => I[ia + j]!) };
    }
    case CURVE_KIND.polyline: {
      const n = d.pool.curveInt[d.curve.int[k]!]!, reals: number[] = [];
      for (let j = 0; j < n; j++) reals.push(...point(at + 3 * j));
      return { kind, reals, ints: [n] };
    }
    default: return { why: 'a kind with no point-by-point image (trimmed, composite, offset)' };
  }
}
