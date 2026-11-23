// The layout of a B-rep analysis buffer: the companion to a model buffer (layout.ts) holding what's derived from the
// model rather than given by its source (docs/own-tessellator.md, "The input"): measured tolerances, parameter ranges
// the source left out, outer loops, adjacency, continuity, surface facts, measures with their errors, and where each
// value came from. The model stays exactly as imported; this buffer is keyed by its rows and tied to it by its hash.
// The same conventions as layout.ts: tables of columns, row references as indices (-1: none), NaN for not computed,
// little-endian, 8-byte aligned columns. A change here is a change of format (bump ANALYSIS_MAGIC).

import type { ColumnType } from './layout.ts';

export const ANALYSIS_MAGIC = 'CBA6';

/**
 * The tables in buffer order. A per-entity table (vertex, edge, coedge, face, surface, shell) is either empty (not
 * analysed) or has exactly the model's rows of that table, row i describing the model's row i. Variable-length data
 * (adjacency lists, singularities) are in the pools, as offset and count pairs.
 */
export const ANALYSIS_TABLES = {
  /**
   * One row. `model` the SHA-256 of the model buffer's bytes (8 words, big-endian digest order): a consumer given an
   * analysis of another model (edited, healed) must refuse it. `uncertainty` the distance below which analysis took
   * points as one, in millimetres (the part's, or a default where it has none).
   */
  analysis: [['model', 'u32', 8], ['uncertainty', 'f64', 1]],
  pool: [['real', 'f64', 1], ['int', 'i32', 1]],
  /**
   * `measured` the largest distance from the vertex to the ends of its edges' curves and to its faces' surfaces
   * (NaN: not measured); `edges` the edges ending there, `count` row indices in `pool.int` from `first`;
   * `toleranceFrom` PROVENANCE of the model's tolerance (healed: grown by healing, the model then a healed one),
   * `givenTolerance` the source's (NaN: it gave none), so the source's claim stays visible beside the grown value;
   * `toleranceError` 1 where healing grew the tolerance past its error limit (cad-heal's growth.ts: past 5 x the
   * tolerance it started from, the larger of `givenTolerance` and `analysis.uncertainty`, and past 0.01 x the part's
   * size), else 0: input beyond repair, every face with a loop through the vertex failed by the mesher at once.
   */
  vertex: [['measured', 'f64', 1], ['first', 'i32', 1], ['count', 'i32', 1], ['toleranceFrom', 'u8', 1],
    ['givenTolerance', 'f64', 1], ['toleranceError', 'u8', 1]],
  /**
   * `range` the edge's curve parameters at start and end: the model's where given, else derived (by inversion of
   * its vertices, closed curves resolved), `rangeFrom` PROVENANCE; `measured` the largest deviation of its coedges'
   * p-curves (through their surfaces) from its 3D curve over the range; its coedges `count` row indices in
   * `pool.int` from `first`; `toleranceFrom`, `givenTolerance` and `toleranceError` as the vertex's (every face with a
   * loop using the edge failed); `givenRange` the source's range (NaN where it gave none), as `givenTolerance` is.
   */
  edge: [['range', 'f64', 2], ['rangeFrom', 'u8', 1], ['measured', 'f64', 1], ['first', 'i32', 1],
    ['count', 'i32', 1], ['toleranceFrom', 'u8', 1], ['givenTolerance', 'f64', 1], ['toleranceError', 'u8', 1],
    ['givenRange', 'f64', 2]],
  /**
   * `range` the p-curve's parameters at the coedge's start and end (as the edge's, in the loop's direction),
   * `rangeFrom` PROVENANCE; `deviation` its p-curve's largest distance, mapped through the surface, from the 3D
   * curve (NaN without either); `face` and `loop` the rows that use it; `pcurveFrom` PROVENANCE of the model's
   * p-curve (none: it has none; given: the source's; healed: made, replaced or reparameterized by healing);
   * `givenPcurve` and `givenRange` the source's p-curve (a curve row of the model, which healing keeps however it
   * changes the use: -1 where the source gave none) and range (NaN where it gave none), so healing again with other
   * options starts from the source's.
   */
  coedge: [['range', 'f64', 2], ['rangeFrom', 'u8', 1], ['deviation', 'f64', 1], ['face', 'i32', 1],
    ['loop', 'i32', 1], ['pcurveFrom', 'u8', 1], ['givenPcurve', 'i32', 1], ['givenRange', 'f64', 2]],
  /**
   * The coedges healing traced (their edge's curve onto their face's surface, where it couldn't bound the curve
   * within the tolerance otherwise), one row each in coedge order, only those: `coedge` its row, `status`
   * TRACE_STATUS, `tol` the tolerance traced at, `offSurface` the curve's largest distance from the surface along the
   * trace (between its feet too, as the projection measures it; for a stopped trace, up to `stopAt` and wherever the
   * curve's hull leaves the surface's box: a lower bound), `stopAt` the curve parameter where it couldn't continue and
   * `stopWhy` TRACE_STOP (NaN and none where it didn't stop). The p-curve fitted from a trace is the model's
   * (pcurveFrom healed), not kept here.
   */
  trace: [['coedge', 'i32', 1], ['status', 'u8', 1], ['tol', 'f64', 1], ['offSurface', 'f64', 1],
    ['stopAt', 'f64', 1], ['stopWhy', 'u8', 1]],
  /**
   * `outerLoop` the face's outer loop row (-1: none, as a band's whose loops wind around a period), `outerFrom`
   * PROVENANCE (given where the source labels exactly one); `uv` the (u, v) box of its loops (u lo, u hi, v lo,
   * v hi); `area` the oracle's value and error estimate (NaN: not computed), `areaFrom` MEASURE_TRUST; `turned`
   * how healing's orientShells turned the face, so healing again turns it back, bits: 1 its sense flipped to its
   * loops' (they ran against it, its neighbours agreeing with them), 2 turned whole to agree with its shell's other
   * faces (sense flipped, loops reversed: an edge was used twice the same way); 0 neither.
   */
  face: [['outerLoop', 'i32', 1], ['outerFrom', 'u8', 1], ['uv', 'f64', 4], ['area', 'f64', 2],
    ['areaFrom', 'u8', 1], ['turned', 'u8', 1]],
  /**
   * Facts about each surface: `uClosed`, `vClosed` LOGICAL as measured (closed in fact, not as claimed); periods
   * (0: none); its singularities `count` records of 6 reals in `pool.real` from `first`: SINGULARITY kind, isoU
   * (0/1), the fixed parameter, the 3D point.
   */
  surface: [['uClosed', 'u8', 1], ['vClosed', 'u8', 1], ['uPeriod', 'f64', 1], ['vPeriod', 'f64', 1],
    ['first', 'i32', 1], ['count', 'i32', 1]],
  /**
   * Continuity across an edge between two of its uses (every pair, so non-manifold edges too): `edge`, coedges `a`
   * and `b`; `class` CONTINUITY; `angle` the largest angle between the faces' normals along the edge (radians, each
   * normal turned by its face's sense), `angleError` its error estimate.
   */
  continuity: [['edge', 'i32', 1], ['a', 'i32', 1], ['b', 'i32', 1], ['class', 'u8', 1], ['angle', 'f64', 1],
    ['angleError', 'f64', 1]],
  /**
   * Per model shell: `volume` the oracle's signed volume and error estimate (NaN: open, or not computed), positive
   * where the faces' normals point out of the volume; `facing` FACING, by the volume's sign or point classification,
   * `facingFrom` how it was found (both of the model's shell as the source gave it); `turned` 1 where healing turned
   * the shell's faces (orientShells: each face's sense flipped, its loops' coedge rows reversed in place and their
   * orientations flipped), so healing again turns them back before putting the source's values back.
   */
  shell: [['volume', 'f64', 2], ['facing', 'u8', 1], ['facingFrom', 'u8', 1], ['turned', 'u8', 1]],
  /**
   * One row where the model is a healed one (none otherwise): how it was healed, so healing it again knows what it
   * holds. `fixes` the fixes that ran, a bit per fix in cad-heal's HEAL_FIXES order (bit 0 the first);
   * `pcurveFitTolerance` the tolerance (mm) its p-curves for bare uses were fitted at; `version` cad-heal's
   * HEAL_VERSION; `sourceCurves` how many of the model's curve rows are the source's (the rest healing's, appended);
   * `strayPoles` how many poles strayPole moved, in this healing or an earlier one (their old places aren't kept).
   */
  healing: [['fixes', 'u32', 1], ['pcurveFitTolerance', 'f64', 1], ['version', 'u32', 1], ['sourceCurves', 'u32', 1],
    ['strayPoles', 'u32', 1]],
} as const satisfies Record<string, readonly (readonly [string, ColumnType, number])[]>;

export type AnalysisTableName = keyof typeof ANALYSIS_TABLES;

/** Where a value came from: the source (the model's own value, copied), measured by analysis, or set by healing. */
export const PROVENANCE = { none: 0, given: 1, measured: 2, healed: 3 } as const;
/** How far a measure is to be trusted: not computed, an estimate within its error, or exact (closed form). */
export const MEASURE_TRUST = { none: 0, estimate: 1, exact: 2 } as const;
/** Across an edge: unknown, positional only, tangent planes agree, curvatures agree too. */
export const CONTINUITY = { unknown: 0, c0: 1, g1: 2, g2: 3 } as const;
export const SINGULARITY = { pole: 0, apex: 1, normalVanishes: 2 } as const;
/** A trace: complete, stopped where it couldn't continue (`stopAt`, `stopWhy`), or not made at all (the curve or
 * surface refused). */
export const TRACE_STATUS = { ok: 1, stopped: 2, notMade: 3 } as const;
/** Why a trace stopped: no convergent step, a jump in the feet that isn't a seam's period, a pole line it couldn't
 * cross, a degenerate stretch (S_u x S_v vanishing), a fold (the distance's Hessian singular: a fold or branch). */
export const TRACE_STOP = { none: 0, noConvergence: 1, jump: 2, poleLine: 3, degenerate: 4, fold: 5 } as const;
/** A closed shell's faces' normals: not known, out of the volume they bound, or into it. */
export const FACING = { unknown: 0, out: 1, in: 2 } as const;
/** How a shell's facing was found. */
export const FACING_FROM = { none: 0, volume: 1, classification: 2, both: 3 } as const;
