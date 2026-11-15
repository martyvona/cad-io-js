// The layout of a B-rep analysis buffer: the companion to a model buffer (layout.ts) holding what's derived from the
// model rather than given by its source (docs/own-tessellator.md, "The input"): measured tolerances, parameter ranges
// the source left out, outer loops, adjacency, continuity, surface facts, measures with their errors, and where each
// value came from. The model stays exactly as imported; this buffer is keyed by its rows and tied to it by its hash.
// The same conventions as layout.ts: tables of columns, row references as indices (-1: none), NaN for not computed,
// little-endian, 8-byte aligned columns. A change here is a change of format (bump ANALYSIS_MAGIC).

import type { ColumnType } from './layout.ts';

export const ANALYSIS_MAGIC = 'CBA1';

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
   * (NaN: not measured); `edges` the edges ending there, `count` row indices in `pool.int` from `first`.
   */
  vertex: [['measured', 'f64', 1], ['first', 'i32', 1], ['count', 'i32', 1]],
  /**
   * `range` the edge's curve parameters at start and end: the model's where given, else derived (by inversion of
   * its vertices, closed curves resolved), `rangeFrom` PROVENANCE; `measured` the largest deviation of its coedges'
   * p-curves (through their surfaces) from its 3D curve over the range; its coedges `count` row indices in
   * `pool.int` from `first`.
   */
  edge: [['range', 'f64', 2], ['rangeFrom', 'u8', 1], ['measured', 'f64', 1], ['first', 'i32', 1],
    ['count', 'i32', 1]],
  /**
   * `range` the p-curve's parameters at the coedge's start and end (as the edge's, in the loop's direction),
   * `rangeFrom` PROVENANCE; `deviation` its p-curve's largest distance, mapped through the surface, from the 3D
   * curve (NaN without either); `face` and `loop` the rows that use it.
   */
  coedge: [['range', 'f64', 2], ['rangeFrom', 'u8', 1], ['deviation', 'f64', 1], ['face', 'i32', 1],
    ['loop', 'i32', 1]],
  /**
   * `outerLoop` the face's outer loop row (-1: none, as a band's whose loops wind around a period), `outerFrom`
   * PROVENANCE (given where the source labels exactly one); `uv` the (u, v) box of its loops (u lo, u hi, v lo,
   * v hi); `area` the oracle's value and error estimate (NaN: not computed), `areaFrom` MEASURE_TRUST.
   */
  face: [['outerLoop', 'i32', 1], ['outerFrom', 'u8', 1], ['uv', 'f64', 4], ['area', 'f64', 2],
    ['areaFrom', 'u8', 1]],
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
   * `facingFrom` how it was found.
   */
  shell: [['volume', 'f64', 2], ['facing', 'u8', 1], ['facingFrom', 'u8', 1]],
} as const satisfies Record<string, readonly (readonly [string, ColumnType, number])[]>;

export type AnalysisTableName = keyof typeof ANALYSIS_TABLES;

/** Where a value came from: the source (the model's own value, copied), measured by analysis, or set by healing. */
export const PROVENANCE = { none: 0, given: 1, measured: 2, healed: 3 } as const;
/** How far a measure is to be trusted: not computed, an estimate within its error, or exact (closed form). */
export const MEASURE_TRUST = { none: 0, estimate: 1, exact: 2 } as const;
/** Across an edge: unknown, positional only, tangent planes agree, curvatures agree too. */
export const CONTINUITY = { unknown: 0, c0: 1, g1: 2, g2: 3 } as const;
export const SINGULARITY = { pole: 0, apex: 1, normalVanishes: 2 } as const;
/** A closed shell's faces' normals: not known, out of the volume they bound, or into it. */
export const FACING = { unknown: 0, out: 1, in: 2 } as const;
/** How a shell's facing was found. */
export const FACING_FROM = { none: 0, volume: 1, classification: 2, both: 3 } as const;
