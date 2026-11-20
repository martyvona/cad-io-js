// Piecewise rational Bezier evaluation to second derivatives, from the Bernstein form (Piegl and Tiller, The NURBS
// Book, 1.4 and 4.2: C = A / w, C' = (A' - w' C) / w, C'' = (A'' - 2 w' C' - w'' C) / w), for B-splines whose
// interior knots all have multiplicity equal to the degree (each span a Bezier piece, so no knot recursion), and the
// exact rational forms of the circle it's used on. Independent of geometry.ts's Cox-de Boor evaluator, which the facts
// check.

import { type V } from './vec.ts';

/** The Bernstein polynomial B_{i,p}(s), 0 outside 0 <= i <= p. */
function bern(i: number, p: number, s: number): number {
  if (i < 0 || i > p) return 0;
  let c = 1;
  for (let k = 1; k <= i; k++) c = c * (p - k + 1) / k;
  return c * s ** i * (1 - s) ** (p - i);
}

/** B_{i,p} and its first two derivatives in s. */
function bern2(i: number, p: number, s: number): [number, number, number] {
  return [bern(i, p, s), p ? p * (bern(i - 1, p - 1, s) - bern(i, p - 1, s)) : 0,
    p > 1 ? p * (p - 1) * (bern(i - 2, p - 2, s) - 2 * bern(i - 1, p - 2, s) + bern(i, p - 2, s)) : 0];
}

/** A B-spline in Bezier pieces: degree, the knots (distinct), poles and weights (1 where not rational). */
export interface Pieces {
  degree: number;
  knots: number[];
  poles: V[];
  weights: number[];
}

/** The knot multiplicities of `Pieces`: degree + 1 at the ends, degree inside. */
export const multiplicities = (b: Pieces): number[] => b.knots.map((_, k) => (k === 0 || k === b.knots.length - 1
  ? b.degree + 1 : b.degree));

/** The span of t (the last span for t at the end), its start and length. */
function span(knots: number[], t: number): { k: number; a: number; h: number } {
  let k = 0;
  while (k < knots.length - 2 && t >= knots[k + 1]!) k++;
  return { k, a: knots[k]!, h: knots[k + 1]! - knots[k]! };
}

/** A point of a piecewise rational Bezier curve and its first two derivatives in t. */
export function curveAt(b: Pieces, t: number): { p: V; d1: V; d2: V } {
  const { k, a, h } = span(b.knots, t), s = (t - a) / h, p = b.degree, dim = b.poles[0]!.length;
  const A = [new Array(dim).fill(0), new Array(dim).fill(0), new Array(dim).fill(0)];
  const W = [0, 0, 0];
  for (let i = 0; i <= p; i++) {
    const P = b.poles[k * p + i]!, w = b.weights[k * p + i]!, B = bern2(i, p, s);
    for (let o = 0; o < 3; o++) {
      W[o]! += B[o]! * w;
      for (let c = 0; c < dim; c++) A[o]![c] += B[o]! * w * P[c]!;
    }
  }
  const C = A[0]!.map((x) => x / W[0]!);
  const C1 = A[1]!.map((x, c) => (x - W[1]! * C[c]!) / W[0]!);
  const C2 = A[2]!.map((x, c) => (x - 2 * W[1]! * C1[c]! - W[2]! * C[c]!) / W[0]!);
  return { p: C, d1: C1.map((x) => x / h), d2: C2.map((x) => x / (h * h)) };
}

/** A tensor-product surface of piecewise rational Bezier pieces: poles[i][j] for u index i, v index j. */
export interface PatchPieces {
  uDegree: number;
  vDegree: number;
  uKnots: number[];
  vKnots: number[];
  poles: V[][];
  weights: number[][];
}

/** A point of a piecewise rational Bezier surface and its partials to second order. */
export function surfaceAt(b: PatchPieces, u: number, v: number): { p: V; du: V; dv: V; duu: V; duv: V; dvv: V } {
  const su = span(b.uKnots, u), sv = span(b.vKnots, v), p = b.uDegree, q = b.vDegree;
  const s = (u - su.a) / su.h, r = (v - sv.a) / sv.h;
  // Homogeneous sums by derivative order (a, c) in (u, v): index 3 a + c.
  const A: V[] = Array.from({ length: 9 }, () => [0, 0, 0]), W = new Array(9).fill(0) as number[];
  for (let i = 0; i <= p; i++) for (let j = 0; j <= q; j++) {
    const P = b.poles[su.k * p + i]![sv.k * q + j]!, w = b.weights[su.k * p + i]![sv.k * q + j]!;
    const Bu = bern2(i, p, s), Bv = bern2(j, q, r);
    for (let a = 0; a < 3; a++) for (let c = 0; a + c < 3; c++) {
      const f = Bu[a]! * Bv[c]! * w;
      W[3 * a + c]! += f;
      for (let x = 0; x < 3; x++) A[3 * a + c]![x] = A[3 * a + c]![x]! + f * P[x]!;
    }
  }
  const w = W[0]!, S = A[0]!.map((x) => x / w);
  const Su = A[3]!.map((x, k) => (x - W[3]! * S[k]!) / w), Sv = A[1]!.map((x, k) => (x - W[1]! * S[k]!) / w);
  const Suu = A[6]!.map((x, k) => (x - 2 * W[3]! * Su[k]! - W[6]! * S[k]!) / w);
  const Svv = A[2]!.map((x, k) => (x - 2 * W[1]! * Sv[k]! - W[2]! * S[k]!) / w);
  const Suv = A[4]!.map((x, k) => (x - W[3]! * Sv[k]! - W[1]! * Su[k]! - W[4]! * S[k]!) / w);
  const hu = su.h, hv = sv.h;
  return { p: S, du: Su.map((x) => x / hu), dv: Sv.map((x) => x / hv), duu: Suu.map((x) => x / (hu * hu)),
    duv: Suv.map((x) => x / (hu * hv)), dvv: Svv.map((x) => x / (hv * hv)) };
}

const C45 = Math.SQRT1_2;

/**
 * The unit circle as a rational quadratic B-spline of four quarter arcs, in 2D (x, y), from angle 0 counter-clockwise:
 * knots 0, 1/4, 1/2, 3/4, 1. At each knot k / 4 it is at angle k pi / 2, at each span's middle at the span's middle
 * angle (the arcs are symmetric), and nowhere else at a parameter proportional to the angle.
 */
export function unitCircle(): Pieces {
  const poles: V[] = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1], [1, 0]];
  return { degree: 2, knots: [0, 0.25, 0.5, 0.75, 1], poles, weights: poles.map((_, k) => (k % 2 ? C45 : 1)) };
}

/**
 * A unit half circle from (0, -1) through (1, 0) to (0, 1) in (x, y), two quarter arcs, knots 0, 1/2, 1: a sphere's
 * meridian, x the distance from the axis.
 */
export function unitHalfCircle(): Pieces {
  const poles: V[] = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1]];
  return { degree: 2, knots: [0, 0.5, 1], poles, weights: poles.map((_, k) => (k % 2 ? C45 : 1)) };
}

/**
 * The exact angle of the unit circle's rational form at parameter t, for a self-check of the facts: within a quarter
 * arc, s in [0, 1] local, the point is ((1 - s)^2 + c 2 s (1 - s), c 2 s (1 - s) + s^2) / w in the arc's frame, whose
 * angle is atan2 of those.
 */
export function circleAngle(t: number, quarters = 4): number {
  const k = Math.min(Math.floor(t * quarters), quarters - 1), s = t * quarters - k;
  const x = (1 - s) ** 2 + 2 * C45 * s * (1 - s), y = 2 * C45 * s * (1 - s) + s * s;
  return k * Math.PI / 2 + Math.atan2(y, x);
}
