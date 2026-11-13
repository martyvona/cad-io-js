// The B-rep's rows as plain objects: what BrepBuilder takes and the decoders (decode.ts) give back, equal both ways,
// and the JSON form (json.ts). References are row indices into the part's own tables, each to a row added before.
// Optional fields are absent where the buffer has -1, NaN or (an id) 0. Field names follow Part 42's attributes.

import type { CURVE_FORMS, SURFACE_FORMS, TRANSITIONS, TRIM_PREFERENCES } from './layout.ts';

/** STEP's LOGICAL: null is unknown. */
export type Logical = boolean | null;
/** A point or direction: 2 numbers for p-curves' geometry, 3 otherwise. */
export type Point = number[];

/**
 * A curve's or surface's frame: `origin`, `xDir` and, in 3D, `axis` (z), orthonormal and right-handed (y = axis x
 * xDir); in 2D, y is xDir turned +90 degrees.
 */
export interface Placement {
  origin: Point;
  axis?: Point;
  xDir: Point;
}

export type CurveForm = (typeof CURVE_FORMS)[number];
export type SurfaceForm = (typeof SURFACE_FORMS)[number];
export type Transition = (typeof TRANSITIONS)[number];
export type TrimPreference = (typeof TRIM_PREFERENCES)[number];

/** A trimmed curve's end: its parameter on the basis, its point, or both, as the source gives them. */
export interface Trim {
  parameter?: number;
  point?: Point;
}

interface Row {
  /** The source's id for it (STEP: the #id). */
  id?: number;
}

export type Curve = Row & (
  /** The parameter is distance along `direction` (unit) divided by `magnitude`. */
  | { kind: 'line'; point: Point; direction: Point; magnitude: number }
  | { kind: 'circle'; position: Placement; radius: number }
  | { kind: 'ellipse'; position: Placement; semiAxis1: number; semiAxis2: number }
  | { kind: 'hyperbola'; position: Placement; semiAxis: number; semiImagAxis: number }
  | { kind: 'parabola'; position: Placement; focalDist: number }
  /** Knots distinct and increasing with their multiplicities; `weights` only for a rational curve. */
  | { kind: 'bspline'; degree: number; knots: number[]; multiplicities: number[]; poles: Point[]; weights?: number[];
      closed: Logical; selfIntersect: Logical; form: CurveForm }
  | { kind: 'polyline'; points: Point[] }
  | { kind: 'trimmed'; basis: number; trim1: Trim; trim2: Trim; sense: boolean; preference: TrimPreference }
  | { kind: 'composite'; segments: { curve: number; sameSense: boolean; transition: Transition }[];
      selfIntersect: Logical }
  /** `refDirection` in 3D only. */
  | { kind: 'offset'; basis: number; distance: number; selfIntersect: Logical; refDirection?: Point }
);

export type Surface = Row & (
  | { kind: 'plane'; position: Placement }
  | { kind: 'cylinder'; position: Placement; radius: number }
  /** `radius` at v = 0; v runs along the axis (Part 42: radius r + v tan(semiAngle)). */
  | { kind: 'cone'; position: Placement; radius: number; semiAngle: number }
  | { kind: 'sphere'; position: Placement; radius: number }
  /** `selectOuter` only for a degenerate torus (major radius under the minor). */
  | { kind: 'torus'; position: Placement; majorRadius: number; minorRadius: number; selectOuter?: boolean }
  /** `poles[i][j]` for u index i, v index j; `weights` likewise, only for a rational surface. */
  | { kind: 'bspline'; uDegree: number; vDegree: number; uKnots: number[]; vKnots: number[];
      uMultiplicities: number[]; vMultiplicities: number[]; poles: Point[][]; weights?: number[][];
      uClosed: Logical; vClosed: Logical; selfIntersect: Logical; form: SurfaceForm }
  | { kind: 'extrusion'; curve: number; direction: Point; magnitude: number }
  | { kind: 'revolution'; curve: number; axisOrigin: Point; axisDirection: Point }
  | { kind: 'offset'; basis: number; distance: number; selfIntersect: Logical }
  | { kind: 'rectangularTrimmed'; basis: number; u1: number; u2: number; v1: number; v2: number; uSense: boolean;
      vSense: boolean }
  | { kind: 'curveSwept'; curve: number; directrix: number; referenceSurface: number }
  | { kind: 'fixedReferenceSwept'; curve: number; directrix: number; fixedReference: Point }
);

export interface Vertex extends Row {
  point: Point;
  tolerance?: number;
}

export interface Edge extends Row {
  /** A 3D curve; absent where the source has trims in parameter space only. */
  curve?: number;
  /** Absent on a curve-bounded surface's boundaries. */
  start?: number;
  end?: number;
  /** Start to end runs with the curve's parameter. */
  sameSense: boolean;
  degenerate?: boolean;
  /** The curve's parameters at start and end. */
  range?: [number, number];
  tolerance?: number;
}

export type Orientation = 'forward' | 'reversed' | 'internal' | 'external';
export type Bound = 'outer' | 'inner' | 'unknown';

/** An edge's use in a loop: forward runs from its start to its end. */
export interface Coedge extends Row {
  edge: number;
  orientation: Orientation;
  /** A 2D curve in the face's surface's (u, v). */
  pcurve?: number;
  /** The p-curve's parameters at the coedge's two ends, in the edge's start-to-end order. */
  range?: [number, number];
}

interface LoopBase extends Row {
  bound: Bound;
  /** Whether the loop runs as the source wrote it (STEP: FACE_BOUND.orientation). */
  sense: boolean;
}

export type Loop =
  | (LoopBase & { kind: 'edge'; coedges: Coedge[] })
  | (LoopBase & { kind: 'vertex'; vertex: number })
  | (LoopBase & { kind: 'poly'; vertices: number[] });

export interface Face extends Row {
  surface: number;
  sameSense: boolean;
  /** None: bounded by the surface's own extent. */
  loops: Loop[];
  tolerance?: number;
}

export type ShellKind = 'closed' | 'open' | 'faceSet';

export interface Shell extends Row {
  kind: ShellKind;
  faces: { face: number; sense: boolean }[];
}

export type BodyKind = 'solid' | 'sheet' | 'wire';

/** A solid's members are shells, the outer first, a sheet's shells, a wire's edges. */
export interface Body extends Row {
  kind: BodyKind;
  members: { ref: number; sense: boolean }[];
}

/** 12 numbers, affine, column-major: the x, y and z columns, then the translation. */
export type Transform = number[];

export type Item = Row & { transform?: Transform } & (
  | { kind: 'body' | 'curve' | 'surface' | 'face' | 'instance'; ref: number }
  | { kind: 'point'; point: Point }
);

/** A baked copy's fresh id: the source id it copies and the instances it came through, outermost first. */
export interface Copy {
  id: number;
  source: number;
  path: number[];
}

export interface PartInfo {
  /** The source's uncertainty, in millimetres. */
  uncertainty?: number;
}
