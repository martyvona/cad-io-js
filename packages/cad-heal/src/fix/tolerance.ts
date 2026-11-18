// edgeTolerance: an edge's tolerance grown to cover how far its geometry disagrees, measured: over its coedges, the
// p-curve each ends with (the source's, measured; or the pass's own, its projection's error) from its curve, or where
// a coedge has none, its curve's distance from the face's surface. Grown to GROWTH times the largest, since the
// measures are sampled; never shrunk, and with no cap (that's to be decided).

import type { Geometry } from 'cad-geom';
import { SAMPLES } from '../measure.ts';

/** The grown tolerance's margin over what's measured (sampled measures can miss the largest between samples). */
export const GROWTH = 1.1;

/** The largest distance from the curve row `curve` at SAMPLES points over `range` to the surface row `surface` (its
 * inversion over the row's whole domain): sampled. NaN where an evaluation or inversion fails. */
export function curveOffSurface(g: Geometry, curve: number, range: [number, number], surface: number, tol: number):
  number {
  const ts = Array.from({ length: SAMPLES }, (_, i) => range[0] + (range[1] - range[0]) * i / (SAMPLES - 1));
  const C = g.evalCurve(curve, ts, 0);
  if (C.status !== 'ok' || C.statuses.some((s) => s !== 0)) return NaN;
  const si = g.surfaceInfo(surface);
  const inv = g.invertSurface(surface, C.values, [si.u[0], si.u[1], si.v[0], si.v[1]], tol);
  if (inv.status !== 'ok' || inv.statuses.some((s) => s !== 0)) return NaN;
  let w = 0;
  for (const x of inv.distance) w = Math.max(w, x);
  return w;
}
