// The layout of a B-rep buffer (BrepData): its tables and columns, the kinds and enumerations, and what each kind keeps
// in the pools. This file is the format: the builder, the views, validation and the generated C header
// (include/cad_brep.h, from gen/header.ts) all follow it, so a change here is a change of format (bump MAGIC).
// The model's rules (Part 42's parameterizations, millimetres and radians, placements complete, what stays absent):
// docs/brep-model.md; which reals are lengths: docs/brep-reference.md.

/** The first four bytes of every buffer; the digit is the format's version. */
export const MAGIC = 'CBR6';

export type ColumnType = 'u8' | 'i32' | 'u32' | 'f64';

/**
 * The tables in buffer order, each a list of columns: [name, type, values per row]. Rows of a table have the same
 * count in every column; `pool` is the exception, independent arrays, one pair per table that owns variable-length
 * data (so the bytes don't depend on how a builder interleaves tables). References are row indices into the named
 * table (-1: none); a row's `real` and `int` are offsets into its table's pools (curve: `pool.curveReal`,
 * `pool.curveInt`); ids are source ids, 1 to 2^32 - 1 (0: none); tolerances and ranges NaN where the source doesn't
 * give them.
 */
export const TABLES = {
  /** One row: the part's uncertainty in millimetres (NaN: none). Every length in the buffer is in millimetres. */
  part: [['uncertainty', 'f64', 1]],
  pool: [['curveReal', 'f64', 1], ['curveInt', 'i32', 1], ['surfaceReal', 'f64', 1], ['surfaceInt', 'i32', 1],
    ['itemReal', 'f64', 1], ['copyPath', 'u32', 1]],
  /** Curves, 3D or 2D (p-curves' geometry): `dim` 2 or 3; reals and ints by kind (CURVE_LAYOUTS). */
  curve: [['kind', 'u8', 1], ['dim', 'u8', 1], ['real', 'i32', 1], ['int', 'i32', 1], ['id', 'u32', 1]],
  surface: [['kind', 'u8', 1], ['real', 'i32', 1], ['int', 'i32', 1], ['id', 'u32', 1]],
  vertex: [['point', 'f64', 3], ['tolerance', 'f64', 1], ['id', 'u32', 1]],
  /**
   * `curve` a 3D curve or -1 (a source with trims in parameter space only); `start` and `end` vertices or -1 (a
   * curve-bounded surface's boundary); `sameSense` whether start to end runs with the curve's parameter; `range` the
   * curve's parameters at start and end where the source gives them.
   */
  edge: [['curve', 'i32', 1], ['start', 'i32', 1], ['end', 'i32', 1], ['sameSense', 'u8', 1], ['range', 'f64', 2],
    ['tolerance', 'f64', 1], ['id', 'u32', 1]],
  /** An edge's use in a loop: `orientation` ORIENTATION; `pcurve` a 2D curve in the face's surface's (u, v) or -1. */
  coedge: [['edge', 'i32', 1], ['orientation', 'u8', 1], ['pcurve', 'i32', 1], ['range', 'f64', 2],
    ['id', 'u32', 1]],
  /**
   * `kind` LOOP_KIND: an edge loop's coedges are `count` rows from `first`, run as listed; a vertex loop's vertex is
   * `first` (`count` 1). `bound` BOUND. `id` the bound's.
   */
  loop: [['kind', 'u8', 1], ['bound', 'u8', 1], ['first', 'i32', 1], ['count', 'i32', 1], ['id', 'u32', 1]],
  /** Loops `loopCount` rows from `firstLoop` (none: bounded by the surface's own extent). */
  face: [['surface', 'i32', 1], ['sameSense', 'u8', 1], ['firstLoop', 'i32', 1], ['loopCount', 'i32', 1],
    ['tolerance', 'f64', 1], ['id', 'u32', 1]],
  /**
   * `kind` SHELL_KIND, by topology (closed: every edge its faces bound used exactly twice, once each way); `declared`
   * SHELL_DECLARED, the source's claim. Its faces are `count` rows of `faceUse` from `first`, each used forward.
   */
  shell: [['kind', 'u8', 1], ['declared', 'u8', 1], ['first', 'i32', 1], ['count', 'i32', 1], ['id', 'u32', 1]],
  /**
   * `kind` BODY_KIND, `declared` the source's (a sheet of one closed shell is a solid); members `count` rows of
   * `member` from `first`: a solid's shells (the outer first, then voids), a sheet's shells, a wire's edges.
   */
  body: [['kind', 'u8', 1], ['declared', 'u8', 1], ['first', 'i32', 1], ['count', 'i32', 1], ['id', 'u32', 1]],
  /** A face of a shell. */
  faceUse: [['face', 'i32', 1]],
  /** A member of a body. */
  member: [['ref', 'i32', 1]],
  /**
   * The part's roots, in the model's one coordinate system (no transforms: a source's are baked into copies of the
   * rows, docs/brep-reference.md, "Transforms"). `kind` ITEM_KIND; `ref` the body, curve, surface or face, or a
   * point's offset of 3 reals in `pool.itemReal`.
   */
  item: [['kind', 'u8', 1], ['ref', 'i32', 1], ['id', 'u32', 1]],
  /**
   * Baked copies' fresh ids: `id` a copy's, `source` the id it copies; the instances it came through,
   * outermost first, `count` ids in `pool.copyPath` from `first`.
   */
  copy: [['id', 'u32', 1], ['source', 'u32', 1], ['first', 'i32', 1], ['count', 'i32', 1]],
} as const satisfies Record<string, readonly (readonly [string, ColumnType, number])[]>;

export type TableName = keyof typeof TABLES;

/** Three-valued: STEP's LOGICAL (closed, self-intersecting), unknown included. */
export const LOGICAL = { false: 0, true: 1, unknown: 2 } as const;
export const ORIENTATION = { forward: 0, reversed: 1, internal: 2, external: 3 } as const;
export const LOOP_KIND = { edge: 1, vertex: 2 } as const;
export const BOUND = { unknown: 0, outer: 1, inner: 2 } as const;
export const SHELL_KIND = { closed: 1, open: 2 } as const;
/** `faceSet`: neither said closed nor open (STEP's CONNECTED_FACE_SET). */
export const SHELL_DECLARED = { closed: 1, open: 2, faceSet: 3 } as const;
export const BODY_KIND = { solid: 1, sheet: 2, wire: 3 } as const;
export const ITEM_KIND = { body: 1, curve: 2, surface: 3, face: 4, point: 5 } as const;

export const CURVE_KIND = {
  line: 1, circle: 2, ellipse: 3, hyperbola: 4, parabola: 5, bspline: 6, polyline: 7, trimmed: 8, composite: 9,
  offset: 10,
} as const;
export const SURFACE_KIND = {
  plane: 1, cylinder: 2, cone: 3, sphere: 4, torus: 5, bspline: 6, extrusion: 7, revolution: 8, offset: 9,
  rectangularTrimmed: 10, curveSwept: 11, fixedReferenceSwept: 12,
} as const;

/** Part 42's enumerations, by their index here. */
export const CURVE_FORMS = ['unspecified', 'polyline_form', 'circular_arc', 'elliptic_arc', 'parabolic_arc',
  'hyperbolic_arc'] as const;
export const SURFACE_FORMS = ['unspecified', 'plane_surf', 'cylindrical_surf', 'conical_surf', 'spherical_surf',
  'toroidal_surf', 'surf_of_revolution', 'ruled_surf', 'generalised_cone', 'quadric_surf',
  'surf_of_linear_extrusion'] as const;
export const TRANSITIONS = ['discontinuous', 'continuous', 'cont_same_gradient',
  'cont_same_gradient_same_curvature'] as const;
export const TRIM_PREFERENCES = ['unspecified', 'parameter', 'cartesian'] as const;

/**
 * What each curve kind keeps in the pools, from its row's offsets, as text for the C header and readers; `d` is the
 * row's `dim`. A 3D placement is 9 reals (origin, axis, x direction: orthonormal, right-handed with y = axis x x); a 2D
 * one 4 (origin, x direction; y is x turned +90 degrees). Angles in radians; parameters as Part 42 defines them.
 */
export const CURVE_LAYOUTS: Record<keyof typeof CURVE_KIND, { reals: string; ints: string }> = {
  line: { reals: 'point (d), unit direction (d), magnitude (the parameter is distance / magnitude)', ints: '' },
  circle: { reals: 'placement, radius', ints: '' },
  ellipse: { reals: 'placement, semi_axis_1 (along x), semi_axis_2', ints: '' },
  hyperbola: { reals: 'placement, semi_axis, semi_imag_axis', ints: '' },
  parabola: { reals: 'placement, focal_dist', ints: '' },
  bspline: {
    reals: 'knots (k, distinct, increasing), poles (n x d), weights (n, if rational)',
    ints: 'degree, n, k, rational (0/1), closed (LOGICAL), self_intersect (LOGICAL), form (CURVE_FORMS), '
      + 'multiplicities (k)',
  },
  polyline: { reals: 'points (n x d)', ints: 'n' },
  trimmed: {
    reals: 'trim 1 parameter, trim 2 parameter (NaN if not given), trim 1 point (d), trim 2 point (d) (NaN if not '
      + 'given)',
    ints: 'basis curve, sense_agreement (0/1), master_representation (TRIM_PREFERENCES)',
  },
  composite: { reals: '', ints: 'n, self_intersect (LOGICAL), then per segment: curve, same_sense (0/1), transition '
    + '(TRANSITIONS)' },
  offset: { reals: 'distance, then for d = 3 the reference direction (3)', ints: 'basis curve, self_intersect '
    + '(LOGICAL)' },
};

export const SURFACE_LAYOUTS: Record<keyof typeof SURFACE_KIND, { reals: string; ints: string }> = {
  plane: { reals: 'placement', ints: '' },
  cylinder: { reals: 'placement, radius', ints: '' },
  cone: { reals: 'placement, radius (at v = 0), semi_angle', ints: '' },
  sphere: { reals: 'placement, radius', ints: '' },
  torus: { reals: 'placement, major_radius, minor_radius', ints: 'degenerate (0/1), select_outer (0/1)' },
  bspline: {
    reals: 'u knots (ku), v knots (kv), poles (nu x nv x 3, u-major: pole (i, j) at i * nv + j), weights (nu x nv, '
      + 'if rational)',
    ints: 'u degree, v degree, nu, nv, ku, kv, rational (0/1), u_closed, v_closed, self_intersect (LOGICAL each), '
      + 'form (SURFACE_FORMS), u multiplicities (ku), v multiplicities (kv)',
  },
  extrusion: { reals: 'unit direction (3), magnitude', ints: 'swept curve' },
  revolution: { reals: 'axis location (3), unit axis direction (3)', ints: 'swept curve' },
  offset: { reals: 'distance', ints: 'basis surface, self_intersect (LOGICAL)' },
  rectangularTrimmed: { reals: 'u1, u2, v1, v2', ints: 'basis surface, usense (0/1), vsense (0/1)' },
  curveSwept: { reals: '', ints: 'swept curve, directrix curve, reference surface' },
  fixedReferenceSwept: { reals: 'fixed reference direction (3)', ints: 'swept curve, directrix curve' },
};
