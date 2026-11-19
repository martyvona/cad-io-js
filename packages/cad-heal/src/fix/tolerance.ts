// edgeTolerance: an edge's tolerance grown to cover how far its geometry disagrees, measured: over its coedges, the
// p-curve each ends with (the source's, measured; or the pass's own, its projection's error) from its curve, or where
// a coedge has none, its curve's distance from the face's surface. Grown to GROWTH times the largest, since the
// measures are sampled; never shrunk, and with no cap (that's to be decided).

import type { Geometry } from 'cad-geom';
import { SAMPLES } from '../measure.ts';

/** The grown tolerance's margin over what's measured (sampled measures can miss the largest between samples). */
export const GROWTH = 1.1;

/** Points per side of the grid a bounded surface's points are taken at, for curveOffSurface's bound. */
const GRID = 9;

/**
 * The largest distance from the curve row `curve` at SAMPLES points over `range` to the surface row `surface` (its
 * inversion over the row's whole domain): sampled, an estimate; NaN where an evaluation or inversion fails.
 *
 * Before inverting, a bound that holds over the whole curve, not only at its samples: the distance f(t) from C(t) to
 * the surface is at most C(t)'s distance from any surface point (here the nearest of a GRID x GRID grid over a
 * bounded surface's domain), and f is 1-Lipschitz in the point, so on a span between samples t_i and t_i+1, every t
 * within half the span of one of them, f(t) <= max(f(t_i), f(t_i+1)) + M h / 2 with M cad-geom's upper bound on
 * |C'| over the span (derivBound) and h the span's length. Where every span's bound is within `tol`, so is the curve,
 * and the bound is returned without inverting (the pass needs only whether a curve is past tol, and inversion on a
 * surface smaller than the tolerance is slow). `grids` keeps each surface's grid points across calls.
 */
export function curveOffSurface(g: Geometry, curve: number, range: [number, number], surface: number, tol: number,
  grids?: Map<number, Float64Array | null>): number {
  const ts = Array.from({ length: SAMPLES }, (_, i) => range[0] + (range[1] - range[0]) * i / (SAMPLES - 1));
  const C = g.evalCurve(curve, ts, 0);
  if (C.status !== 'ok' || C.statuses.some((s) => s !== 0)) return NaN;
  const si = g.surfaceInfo(surface);
  let grid = grids?.get(surface);
  if (grid === undefined) {
    grid = null;
    if ([si.u[0], si.u[1], si.v[0], si.v[1]].every(Number.isFinite)) {
      const uv: number[] = [];
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          uv.push(si.u[0] + (si.u[1] - si.u[0]) * i / (GRID - 1), si.v[0] + (si.v[1] - si.v[0]) * j / (GRID - 1));
        }
      }
      const q = g.evalSurface(surface, uv, 0);
      if (q.status === 'ok' && !q.statuses.some((x) => x !== 0)) grid = q.values;
    }
    grids?.set(surface, grid);
  }
  if (grid) {
    // Each sample's distance from the nearest grid point, an upper bound on its distance from the surface.
    const at = new Float64Array(SAMPLES);
    let ok = true;
    for (let i = 0; i < SAMPLES && ok; i++) {
      let near = Infinity;
      for (let k = 0; k < grid.length; k += 3) {
        near = Math.min(near, Math.hypot(C.values[3 * i]! - grid[k]!, C.values[3 * i + 1]! - grid[k + 1]!,
          C.values[3 * i + 2]! - grid[k + 2]!));
      }
      at[i] = near, ok = near <= tol;
    }
    if (ok) {
      const spans: number[] = [];
      for (let i = 0; i + 1 < SAMPLES; i++) spans.push(Math.min(ts[i]!, ts[i + 1]!), Math.max(ts[i]!, ts[i + 1]!));
      const speed = g.curveDerivBound(curve, spans, 1);
      if (speed.status === 'ok' && !speed.statuses.some((x) => x !== 0)) {
        let bound = 0;
        for (let i = 0; i + 1 < SAMPLES; i++) {
          bound = Math.max(bound, Math.max(at[i]!, at[i + 1]!) + speed.bounds[i]! * (spans[2 * i + 1]! - spans[2 * i]!)
            / 2);
        }
        if (bound <= tol) return bound;
      }
    }
  }
  const inv = g.invertSurface(surface, C.values, [si.u[0], si.u[1], si.v[0], si.v[1]], tol);
  if (inv.status !== 'ok' || inv.statuses.some((s) => s !== 0)) return NaN;
  let w = 0;
  for (const x of inv.distance) w = Math.max(w, x);
  return w;
}
