// cad-brep: a part's B-rep as one buffer (docs/brep-model.md). The layout is layout.ts (and include/cad_brep.h).
export * from './layout.ts';
export { type BrepData, type BrepTables, BrepFormatError, COLUMNS, type ColumnSpec, openBrep, rowCount } from
  './data.ts';
export { BrepBuilder } from './builder.ts';
export * as decode from './decode.ts';
export { type BrepJson, brepFromJson, brepToJson } from './json.ts';
export { type BrepDiagnostic, MAX_DIAGNOSTICS, UNIT_TOLERANCE, validateBrep } from './validate.ts';
export type * from './types.ts';
export { curveEvaluator, curveEvaluatorOf, type CurveEvaluator, edgeParams, fullKnots, nearestParam, nearestParams,
  normalAt, type Patch, PATCH_TREE_MIN, surfaceEvaluator, type SurfaceEvaluator } from './geometry.ts';
export { faceOutlines, type FaceOutlines, MAX_OUTLINE_POINTS, type OutlineOptions } from './outlines.ts';
