// The tessellator interface: one request per part, its payload parsed by the backend. See README.md. Backends implement
// it in their own packages (tess-occt, tess-truck, tess-smlib); a part's B-rep model goes as `cad-brep`, which a
// backend reading STEP takes through step-export's StepTessellator (the model written as STEP).

import type { Diagnostic, EdgeKind, Vec3 } from './scene.ts';
import type { Criterion, Target } from './targets.ts';

/** `cad-brep`: a B-rep model's buffer (cad-brep's BrepData.buffer) as bytes. */
export type PayloadFormat = 'cad-brep' | 'step' | 'iges' | 'brep';

export interface TessellatorInfo {
  name: string;
  version: string;
  license: string;
  formats: PayloadFormat[];
  supportsFaceIds: boolean;
  supportsEdges: boolean;
  /** Whether results include wireframe curves and points (`curves`, `points`). */
  supportsCurves: boolean;
  /**
   * Whether the backend reads a request's `analysis` (its meshes depend on it, so a cache keys on it); absent or
   * false: it ignores it.
   */
  readsAnalysis?: boolean;
}

export interface TessellationRequest {
  format: PayloadFormat;
  /** One part's payload (a B-rep model's buffer, a STEP file); faces keep their source ids. */
  data: Uint8Array;
  /** The root entity in the payload (STEP: the shape representation). */
  rootId?: number;
  /**
   * Subtracted from every position, in double precision, before conversion to Float32: a point near the part, so
   * that parts modelled far from their origin keep their precision. In the payload's units. Default (0, 0, 0).
   */
  origin?: Vec3;
  /** Maximum distance between mesh and surface, in the payload's units. */
  linearDeflection: number;
  /** Maximum angle between adjacent mesh normals, in radians. */
  angularDeflection: number;
  /**
   * The smallest angle a backend that refines for shape aims for in its triangles, in radians (tess-cadio's minAngle:
   * 10 degrees by default, at most 30). Absent: the backend's default; backends without one ignore it.
   */
  minAngle?: number;
  /**
   * The longest a triangle's edge may be, as a fraction of the part's size (tess-cadio's partSize; docs/triage.md's
   * g), for a backend that can aim at it (tess-cadio); others ignore it. Absent: none.
   */
  maxEdge?: number;
  /**
   * Elementary faces' (planes, cylinders, cones, spheres, tori) size metric's stretch capped at this from their first
   * meshing, for a backend with a size metric (tess-cadio); others ignore it. Absent: none.
   */
  elementaryStretchCap?: number;
  /**
   * The target (targets.ts) a tessellator choosing among backends chooses each face's mesh by (FallbackTessellator,
   * which then asks for records); backends ignore it, and it isn't in a cache's key (its meshing limits, the fields
   * above, are).
   */
  target?: Target;
  /**
   * The part's analysis buffer (cad-brep's analysis-layout.ts, `BrepAnalysis.buffer`), of `data`'s model, where
   * healing gave one: present only for a healed part, and may be absent for one (a caller that doesn't pass it, a
   * rigid copy, which drops it). A backend that reads it (TessellatorInfo.readsAnalysis) takes what it says of the
   * model (healed p-curves' provenance and tolerances, tolerances past repair) and must mesh the model as given
   * without it; others ignore it. Copied to workers with the request, not transferred.
   */
  analysis?: Uint8Array;
  /** Also return B-rep edges as polylines. */
  edges?: boolean;
  /**
   * Also return each source face's measures on the exact geometry (`measures`), where the backend can, and the area
   * oracle's areas (`oracle`), where it trusts them.
   */
  measures?: boolean;
  /**
   * Also return each face's triage record (`records`, records.ts), measured where the request runs (tess-workers'
   * worker); with `measures` so (b) has the area oracle's areas. Default false.
   */
  records?: boolean;
  /**
   * With `records`, a foreign backend's faces' (h) counted by tess-cadio's first meshing (`CadioTessellator.
   * expectedCounts`), at about one tess-cadio edge phase a part (docs/triage.md); without, (h) is a tess-cadio
   * meshing's of the same part where FallbackTessellator has one, else unmeasured. Default false.
   */
  recordExpected?: boolean;
}

/**
 * Each face's triage record (docs/triage.md's criteria), a row per source face id, columns per value (so a worker
 * transfers them). Counts and lengths in the payload's units, angles in radians; NaN or -1 where absent.
 */
export interface FaceRecords {
  entityId: Float64Array;
  /** (g)'s reference: the part's size (tess-cadio's partSize), NaN where unknown. */
  partSize: number;
  /** (k) and (h): its triangles, degenerate ones included. */
  triangles: Uint32Array;
  /** (l): triangles with two corners at one position. */
  degenerate: Uint32Array;
  /**
   * (a.1), its mesh edges welded by position, degenerate triangles left out: edges used three times or more, or twice
   * the same way; edges used once (its boundary, or holes); of those, the ones on no B-rep edge's polyline (a hole;
   * -1 where the result has no edges).
   */
  nonManifoldEdges: Uint32Array;
  openEdges: Uint32Array;
  holeEdges: Int32Array;
  /** (b): its mesh's area, the area oracle's (times its shells' uses; NaN where it trusts none), records.ts's AREA. */
  area: Float64Array;
  oracleArea: Float64Array;
  areaClass: Uint8Array;
  /**
   * (c)'s face tolerance: tess-cadio's Tolerances::face, the part's (its uncertainty, else 1e-5, at least 1e-9 x
   * its vertices' box) widened by the face's own; NaN without the model.
   */
  tolerance: Float64Array;
  /** (c) and (d): the backend's own values where it reports them, as records.ts's CHECK says. */
  deviation: Float64Array;
  deviationCheck: Uint8Array;
  normalAngle: Float64Array;
  normalCheck: Uint8Array;
  /** (e): facets against the mean of their corners' shipped normals (-1: no normals). */
  turned: Int32Array;
  /** (f): its smallest angle, and its triangles under the request's minAngle. */
  minAngle: Float64Array;
  belowMinAngle: Uint32Array;
  /** (g): its longest edge. */
  longestEdge: Float64Array;
  /** (h): its expected triangles and where the count came from (records.ts's EXPECTED). */
  expected: Float64Array;
  expectedSource: Uint8Array;
  /**
   * (a.2): its mesh edges on a model edge not shared exactly with that edge's other uses once joined (-1: not
   * joined); (j): records.ts's ORIENTATION, written where the result is joined and oriented.
   */
  unsewnEdges: Int32Array;
  orientation: Uint8Array;
  /**
   * (k): 1 where only the sliver fill meshed the face (fill.ts's fillResult: no backend did), its row then measured
   * on the filled mesh; 0 otherwise.
   */
  filled: Uint8Array;
}

export interface TessellationResult {
  /** The origin that was subtracted (echoed from the request). */
  origin: Vec3;
  /** Positions minus `origin`, in the payload's units. */
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  /**
   * Index ranges per source face (STEP: ADVANCED_FACE); they partition `indices`. An entityId may repeat (a backend
   * can split one source face), and is null for ranges with no known source.
   */
  faces: { entityId: number | null; start: number; count: number }[];
  /**
   * Each source face's measures on the exact geometry, when requested and the backend can (OCCT): summed over the
   * pieces it split the face into, in the payload's units; `valid` when the backend found every piece sound.
   */
  measures?: { entityId: number; area: number; perimeter: number; valid: boolean }[];
  /**
   * With measures, faces' areas and perimeters by the thread's area oracle (oracleMeasures: independent of the
   * backend; in a pool's workers cad-oracle's, else cad-scene's own on planes and quadrics), where it trusts them for
   * judging, `error` the area's error estimate; in the payload's units.
   */
  oracle?: { entityId: number; area: number; perimeter: number; error?: number }[];
  /**
   * Faces meshed with a defect the backend kept rather than fail them (tess-cadio's keepDefects): `what` in words (a
   * few triangles turned against the surface, past the deflection by so much, at the point cap); `pastLimits` where
   * the defect is past the backend's own limits for keeping it, so that a fallback backend's mesh of the face is to
   * replace it where that one is better (fallback.ts). A face here has its triangles.
   */
  defects?: { entityId: number; pastLimits: boolean; what: string }[];
  /**
   * What the backend measured of its own faces' meshes (tess-cadio's), for their triage records (records.ts): its
   * deviation (c) and normal (d) checks, each records.ts's CHECK with its value (NaN where none), and the expected
   * count its point cap meshed the face to (0: none).
   */
  reported?: { entityId: number; deviationCheck: number; deviation: number; normalCheck: number; normalAngle: number;
    expected: number }[];
  /** Each face's triage record, with TessellationRequest.records. */
  records?: FaceRecords;
  /**
   * With a target, FallbackTessellator's faces kept as the primary's though the fallback (`by`) meshed them, for the
   * withheld message: each with the criteria the fallback's mesh of it is in error by (both in error; or put back, in
   * error once composed).
   */
  fallbackErrors?: { by: string; faces: { entityId: number; criteria: Criterion[] }[] };
  /** B-rep edges as polylines, when requested; points coincide with mesh vertices. All polylines concatenated. */
  edgePositions?: Float32Array;
  edges?: {
    /** Null for backend-made edges (OCCT seams, pole edges); may repeat if split. */
    entityId: number | null;
    /** In points, into edgePositions. */
    start: number;
    count: number;
    kind: EdgeKind;
    /** Shared edges: the largest angle (radians) between the two faces' normals along the edge. */
    dihedral?: number;
  }[];
  /**
   * Wireframe curves (STEP: a geometric set's or wireframe model's curves, not faces' edges) as polylines, minus
   * `origin`, whenever the part has them. All polylines concatenated.
   */
  curvePositions?: Float32Array;
  curves?: {
    /** The curve as the source names it (STEP: the geometric set's element); null if unknown; may repeat if split. */
    entityId: number | null;
    /** In points, into curvePositions. */
    start: number;
    count: number;
  }[];
  /**
   * The edges of faces (or pieces of faces) with no triangles, as polylines minus `origin`, if the backend gives them
   * (OCCT): exact where a split face's piece failed, which the source's own face can't say.
   */
  outlinePositions?: Float32Array;
  outlines?: { entityId: number | null; start: number; count: number }[];
  /** Isolated points (STEP: a geometric set's points), minus `origin`, whenever the part has them. */
  points?: Float32Array;
  /** Each point's source entity (STEP: CARTESIAN_POINT), or null. */
  pointIds?: (number | null)[];
  /** Warnings for what was left out; errors for faces that failed to mesh, or a part that did (`failedPart`). */
  diagnostics: Diagnostic[];
  /**
   * The backend that made this result, its name and version, where a tessellator chooses among several
   * (FallbackTessellator); absent: the tessellator's own (`info`).
   */
  backend?: string;
}

/**
 * Where a backend is in a request: a phrase for people, and where it can say them, the face it's on (its entity id
 * and row), the round of its work and how many of the round's faces it has done.
 */
export interface TessellationProgress {
  message: string;
  faceId?: number | null;
  row?: number;
  round?: number;
  facesDone?: number;
  facesTotal?: number;
}

export interface Tessellator {
  readonly info: TessellatorInfo;
  /** Load and compile the backend (WASM). */
  init(opts?: Record<string, unknown>): Promise<void>;
  /**
   * `onProgress`, optional: where the backend is, said as it goes (throttled by the backend), so a host that stops a
   * request (a timeout) can say how far it got. Backends may ignore it.
   */
  tessellate(req: TessellationRequest, onProgress?: (p: TessellationProgress) => void): Promise<TessellationResult>;
  /**
   * The backend's memory in bytes (WASM: its linear memory, which never shrinks), so a host can recycle an instance
   * that has grown too large. Optional.
   */
  memoryBytes?(): number;
  /** The time limit per request, in milliseconds, that this tessellator enforces (0: none). Absent if it has none. */
  readonly timeoutMs?: number;
  dispose(): void;
}
