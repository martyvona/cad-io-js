// pcurveReplace: a source's p-curve off its edge's curve (its image farther than the tolerance, either way, or its
// ends off the edge's vertices) replaced by the projection of the edge's curve where the projection is nearer (its
// error, |S(p(t)) - C(t)| at the same parameter, bounds both ways). On a plane the p-curve is dropped instead: planes'
// p-curves are exact for every consumer, so stay absent. A projection in several pieces (a pole's jump between
// them) can't be one p-curve in the curve's parameter, so isn't used.

import type { Geometry, Pcurve } from 'cad-geom';
import type { Curve2 } from '../edit.ts';

/** Statuses whose projection is a p-curve with its error measured: ok, or past tol (the curve off its surface, or a
 * fit short of tol). */
const USABLE = new Set(['ok', 'invalidModel', 'noConvergence']);

export type Replacement =
  | { kind: 'drop'; error: number }
  | { kind: 'curve'; curve: Curve2; error: number; range: [number, number] }
  | { kind: 'none'; why: 'not nearer' | Unusable; error: number };

/** Why a projection can't be a coedge's p-curve. */
export type Unusable = 'several pieces' | 'no model form' | 'not made';

/**
 * Coedge c's edge's curve projected onto its face's surface (`p`, where it's been projected already), as one p-curve
 * in the model's form in the parameter of the projection's `range` (the face API's edge range), with its error; or
 * why not.
 */
export function projected(g: Geometry, c: number, p: ReturnType<Geometry['projectCoedge']> = g.projectCoedge(c)):
  { curve: Curve2; error: number; range: [number, number] } | { why: Unusable; error: number } {
  if (!('pieces' in p) || !USABLE.has(p.status)) return { why: 'not made', error: NaN };
  const pr = p as Pcurve;
  const pieces = pr.takesTwin ? pr.seamTwin : pr.pieces;
  if (pieces.length !== 1 || pieces[0]!.poleLine) return { why: 'several pieces', error: pr.error };
  const q = pieces[0]!;
  if (!q.kind) return { why: 'no model form', error: pr.error };
  return { curve: { kind: q.kind, reals: q.reals, ints: q.ints }, error: pr.error, range: pr.range };
}

/**
 * What replaces coedge `c`'s given p-curve, whose deviation (the larger of its image's and its ends') is `given`; a
 * curve is in the parameter of the projection's `range` (the face API's edge range), which the caller maps onto its
 * own.
 */
export function replacement(g: Geometry, c: number, onPlane: boolean, given: number): Replacement {
  const p = g.projectCoedge(c);
  if (!('pieces' in p) || !USABLE.has(p.status)) return { kind: 'none', why: 'not made', error: NaN };
  if (!((p as Pcurve).error < given)) return { kind: 'none', why: 'not nearer', error: (p as Pcurve).error };
  if (onPlane) return { kind: 'drop', error: (p as Pcurve).error };
  const r = projected(g, c, p);
  return 'why' in r ? { kind: 'none', ...r } : { kind: 'curve', ...r };
}
