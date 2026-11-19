// edgeTolerance: an edge's tolerance grown to cover how far its geometry disagrees, measured: over its coedges, the
// p-curve each ends with (the source's, measured; or the pass's own, its projection's error) from its curve, or where
// a coedge has none, its curve's distance from the face's surface. Grown to GROWTH times the largest, since the
// measures are sampled; never shrunk, and with no cap (growth.ts says how far each grew, as a warning or an error).

import type { Geometry } from 'cad-geom';
import { SAMPLES } from '../measure.ts';

/** The grown tolerance's margin over what's measured (sampled measures can miss the largest between samples). */
export const GROWTH = 1.1;

/** Points per side of the first grid of a bounded surface's points, for curveOffSurface's bound; each side is then
 * made fine enough that neighbours are about half the tolerance apart, up to MAX_GRID (a strip narrower than the
 * tolerance but long needs many points along it). */
const GRID = 9, MAX_GRID = 257;

/**
 * The largest distance from the curve row `curve` at SAMPLES points over `range` to the surface row `surface` (its
 * inversion over the row's whole domain): sampled, an estimate; NaN where an evaluation or inversion fails.
 *
 * Before inverting, a bound that holds over the whole curve, not only at its samples (gridBound): the distance f(t)
 * from C(t) to the surface is at most C(t)'s distance from any surface point (here the nearest of a grid over a
 * bounded surface's domain, about half the tolerance apart), and f is 1-Lipschitz in the point, so on a span between
 * samples t_i and t_i+1, every t within half the span of one of them, f(t) <= max(f(t_i), f(t_i+1)) + M h / 2 with M
 * cad-geom's upper bound on |C'| over the span (derivBound) and h the span's length. Where every span's bound is
 * within `tol`, so is the curve, and the bound is returned without inverting (the pass needs only whether a curve is
 * past tol, and inversion on a surface smaller than the tolerance is slow). `grids` keeps each surface's grid
 * points, and their cells for each tolerance asked, across calls: building them is most of the bound's cost.
 */
export function curveOffSurface(g: Geometry, curve: number, range: [number, number], surface: number, tol: number,
  grids?: Grids): number {
  const si = g.surfaceInfo(surface);
  let grid = grids?.get(surface);
  if (grid === undefined) {
    let found: Float64Array | null = null;
    if ([si.u[0], si.u[1], si.v[0], si.v[1]].every(Number.isFinite)) {
      const points = (nu: number, nv: number) => {
        const uv: number[] = [];
        for (let i = 0; i < nu; i++) {
          for (let j = 0; j < nv; j++) {
            uv.push(si.u[0] + (si.u[1] - si.u[0]) * i / (nu - 1), si.v[0] + (si.v[1] - si.v[0]) * j / (nv - 1));
          }
        }
        const q = g.evalSurface(surface, uv, 0);
        return q.status === 'ok' && !q.statuses.some((x) => x !== 0) ? q.values : null;
      };
      const coarse = points(GRID, GRID);
      if (coarse) {
        // The largest step between neighbours along u and along v sets each side's count.
        let su = 0, sv = 0;
        const at = (i: number, j: number) => 3 * (i * GRID + j);
        const step = (a: number, b: number) => Math.hypot(coarse[a]! - coarse[b]!, coarse[a + 1]! - coarse[b + 1]!,
          coarse[a + 2]! - coarse[b + 2]!);
        for (let i = 0; i < GRID; i++) {
          for (let j = 0; j < GRID; j++) {
            if (i + 1 < GRID) su = Math.max(su, step(at(i, j), at(i + 1, j)));
            if (j + 1 < GRID) sv = Math.max(sv, step(at(i, j), at(i, j + 1)));
          }
        }
        const count = (s: number) => Math.min(MAX_GRID, Math.max(GRID, Math.ceil((GRID - 1) * s / (tol / 2)) + 1));
        const nu = count(su), nv = count(sv);
        found = nu === GRID && nv === GRID ? coarse : points(nu, nv) ?? coarse;
      }
    }
    grid = found && { points: found, cells: new Map() };
    grids?.set(surface, grid);
  }
  if (grid) {
    const bound = gridBound(g, curve, range, grid, tol);
    if (bound <= tol) return bound;
  }
  const ts = Array.from({ length: SAMPLES }, (_, i) => range[0] + (range[1] - range[0]) * i / (SAMPLES - 1));
  const C = g.evalCurve(curve, ts, 0);
  if (C.status !== 'ok' || C.statuses.some((s) => s !== 0)) return NaN;
  const inv = g.invertSurface(surface, C.values, [si.u[0], si.u[1], si.v[0], si.v[1]], tol);
  if (inv.status !== 'ok' || inv.statuses.some((s) => s !== 0)) return NaN;
  let w = 0;
  for (const x of inv.distance) w = Math.max(w, x);
  return w;
}

/** A surface's grid points (x, y, z each), and per cell size their indices by cell (cellKey). */
export interface SurfaceGrid {
  points: Float64Array;
  cells: Map<number, Map<number, number[]>>;
}
export type Grids = Map<number, SurfaceGrid | null>;

/** A cell's key: its three indices hashed to 32 bits. Two cells may share a key; that only adds candidates to a
 * search, each still a real grid point at its exact distance, so the bound stays sound. */
const cellKey = (i: number, j: number, k: number) =>
  Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);

/** The most spans the bound samples a curve with (each span's term at most a quarter of the tolerance where that
 * many suffice). */
const MAX_SPANS = 4096;

/**
 * An upper bound on the curve's distance from the surface over the whole range, from the surface's points `grid`:
 * Infinity where it isn't within tol (the caller then inverts). The curve is sampled finely enough that each span's
 * term M h / 2 is at most a quarter of tol (up to MAX_SPANS spans), and each sample's nearest grid point found among
 * the grid's points hashed into cells tol wide (a sample farther than tol from all of them fails the bound).
 */
function gridBound(g: Geometry, curve: number, range: [number, number], sg: SurfaceGrid, tol: number): number {
  const lo = Math.min(...range), hi = Math.max(...range);
  const whole = g.curveDerivBound(curve, [lo, hi], 1);
  if (whole.status !== 'ok' || whole.statuses[0] !== 0) return Infinity;
  const n = Math.min(MAX_SPANS, Math.max(SAMPLES - 1, Math.ceil(whole.bounds[0]! * (hi - lo) / (tol / 2))));
  const ts = Array.from({ length: n + 1 }, (_, i) => lo + (hi - lo) * i / n), spans: number[] = [];
  for (let i = 0; i < n; i++) spans.push(ts[i]!, ts[i + 1]!);
  const C = g.evalCurve(curve, ts, 0), speed = g.curveDerivBound(curve, spans, 1);
  if (C.status !== 'ok' || C.statuses.some((x) => x !== 0) || speed.status !== 'ok'
    || speed.statuses.some((x) => x !== 0)) return Infinity;
  // The grid's points by cell, tol wide: a point within tol of a sample is in its cell or a neighbour.
  const grid = sg.points, cell = (x: number) => Math.floor(x / tol);
  let cells = sg.cells.get(tol);
  if (!cells) {
    cells = new Map();
    for (let k = 0; k < grid.length; k += 3) {
      const key = cellKey(cell(grid[k]!), cell(grid[k + 1]!), cell(grid[k + 2]!));
      (cells.get(key) ?? cells.set(key, []).get(key)!).push(k);
    }
    sg.cells.set(tol, cells);
  }
  const at = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) {
    const x = C.values[3 * i]!, y = C.values[3 * i + 1]!, z = C.values[3 * i + 2]!;
    let near = Infinity;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        for (let c = -1; c <= 1; c++) {
          for (const k of cells.get(cellKey(cell(x) + a, cell(y) + b, cell(z) + c)) ?? []) {
            near = Math.min(near, Math.hypot(x - grid[k]!, y - grid[k + 1]!, z - grid[k + 2]!));
          }
        }
      }
    }
    if (!(near <= tol)) return Infinity;
    at[i] = near;
  }
  let bound = 0;
  for (let i = 0; i < n; i++) {
    bound = Math.max(bound, Math.max(at[i]!, at[i + 1]!) + speed.bounds[i]! * (ts[i + 1]! - ts[i]!) / 2);
  }
  return bound;
}
