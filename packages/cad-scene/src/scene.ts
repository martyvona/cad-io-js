// The scene model: what every importer produces and every exporter (and later the viewer) consumes, independent of
// the source format. See README.md, "Scene Model (cad-scene)", and CLAUDE.md, "Decisions".
//
// Structure: components (one per product or assembly definition) are defined once and placed by occurrences, so a
// subassembly used many times is stored once; `instances` expands the tree on demand. Parts (one per tessellation
// unit) are likewise defined once and referenced by components. Lengths in the scene are millimetres; each part's
// geometry stays in its own unit, and the transforms carry the conversion.

/** A 4x4 matrix, column-major (as three.js and glTF): element (row r, column c) is m[c * 4 + r]. */
export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

/** Where something came from: the source format and an id in it (a STEP instance id, say). */
export interface SourceId {
  format: string;
  id: number;
}

/** Free-form metadata, filled in by each importer; carried through to exporters. */
export type Properties = Record<string, PropertyValue>;
export type PropertyValue = string | number | boolean | null | PropertyValue[] | { [key: string]: PropertyValue };

export interface Diagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  source?: SourceId;
}

export interface Scene {
  /** Lengths in the scene (transforms' translations, anything measured in scene space) are millimetres. */
  unit: 'millimetre';
  /** Component definitions; occurrences refer to them by index. */
  components: Component[];
  /** The top-level occurrences: the roots of the tree. */
  roots: Occurrence[];
  parts: Part[];
  materials: Material[];
  layers: Layer[];
  /** Changes to single instances, identified by their occurrence paths (see `instances`). */
  overrides: InstanceOverride[];
  /**
   * The whole model's bounding sphere, in millimetres (bounds.ts): a file's own (our extras), estimated before meshing
   * from what each placed part has, or from every placed part's mesh box. For fitting a view; approximate.
   */
  bounds?: SceneBounds;
  /** File-level metadata. */
  properties: Properties;
  diagnostics: Diagnostic[];
}

export interface Box {
  min: Vec3;
  max: Vec3;
}

export interface Sphere {
  center: Vec3;
  radius: number;
}

export interface SceneBounds extends Sphere {
  /** A file's, an estimate (some parts by their B-rep's vertices), or every part's mesh box. */
  from: 'source' | 'estimated' | 'meshes';
}

/** A product or assembly definition: its own parts, and occurrences of other components. */
export interface Component {
  name: string;
  sources: SourceId[];
  properties: Properties;
  /** Geometry of this component itself, each with its placement in the component's coordinates. */
  parts: PartRef[];
  /** Sub-components. */
  children: Occurrence[];
  /** The component's geometry is in another file. */
  external?: ExternalReference;
  material?: number;
}

/** One use of a component. */
export interface Occurrence {
  /** Index into `Scene.components`. */
  component: number;
  /** From the component's coordinates to its parent's (or the scene's, for a root), in millimetres. */
  transform: Mat4;
  name?: string;
  sources: SourceId[];
  properties: Properties;
}

export interface PartRef {
  /** Index into `Scene.parts`. */
  part: number;
  /** From the part's coordinates (in its own unit) to the component's, in millimetres. */
  transform: Mat4;
  material?: number;
  /** False: hidden (STEP: an invisible style). */
  visible?: boolean;
}

export interface ExternalReference {
  /** The referenced file, as the source names it (often a bare file name, relative to the source file). */
  uri: string;
  format?: string;
}

/**
 * A leaf of the scene: geometry with a unit and an origin, as exact geometry a backend can tessellate (`brep`), as
 * meshes (`lods`), or both (the user, 2026-10-29; CLAUDE.md, "Decisions"): meshes from the source file (glTF, three.js
 * JSON, JT's levels of detail) or made from the B-rep by a tessellator (tessellateScene adds them). Curves and points
 * alone are a level whose mesh has no triangles. A part with neither is empty.
 */
export interface Part {
  name: string;
  sources: SourceId[];
  properties: Properties;
  /** The part's length unit, in millimetres (25.4 for inches). */
  unit: number;
  /**
   * A point near the part's geometry, in its own coordinates: tessellators subtract it before converting to Float32.
   */
  origin: Vec3;
  material?: number;
  /** Materials of individual faces, by the face's source id (a STEP ADVANCED_FACE, say); override `material`. */
  faceMaterials?: { face: number; material: number }[];
  /**
   * Whether the part's faces bound solids, as the source states it (STEP: every face in a closed shell, a solid's or a
   * surface model's; false if any is in an open shell); absent when it doesn't say (no faces, faces in no shell,
   * tessellated faces, a mesh). What a section can be capped on (the viewer), whatever small gaps the meshes have.
   */
  closed?: boolean;
  /** Exact geometry, tessellated on demand by a backend. */
  brep?: Brep;
  /** Meshes, finest first (chooseLod picks one). */
  lods: Lod[];
  /**
   * Its faces' measures on the exact geometry, which meshes are judged by (faceFailures): from a backend that meshed
   * the B-rep, or read from one of our exports; kept when the B-rep isn't (the user, 2026-10-30).
   */
  measures?: Measures;
}

/** A part's measures on its exact geometry (the user, 2026-10-30; CLAUDE.md, "Decisions"). */
export interface Measures {
  /** Who measured: a backend's name and version, or `source` for a file that stated them. */
  by: string;
  /** By the face's source id, as `Mesh.faces` and `faceMaterials` are keyed. */
  faces: Map<number, FaceMeasures>;
}

/** One face's measures, in the part's units: summed over the pieces a backend's shape healing split it into. */
export interface FaceMeasures {
  /** Its surface area, in the part's units squared. */
  area: number;
  /** The length of its boundary (every edge of every loop, a seam twice), in the part's units. */
  perimeter: number;
  /** The measuring backend found the face's geometry sound (OCCT: BRepCheck_Analyzer); false: not to be trusted. */
  valid: boolean;
}

/** B-rep formats a part's exact geometry can be in, grown as importers are added (a backend lists those it takes). */
export type BrepFormat = 'step' | 'iges' | 'brep';

/** A part's exact geometry. */
export interface Brep {
  format: BrepFormat;
  /** The tessellation payload (a STEP subset, say). A function, since building it is work only needed on demand. */
  payload: () => Uint8Array;
  /** The root entity within the payload (STEP: the shape representation). */
  rootId?: number;
  /**
   * The box of the part's vertices (STEP: its VERTEX_POINTs, else all its points), in its coordinates: not a bound
   * (curved faces bulge past their vertices), an estimate of where it is before it's meshed (sceneBounds).
   */
  vertexBox?: Box;
  /**
   * The outlines of the part's faces drawn from the source itself (STEP: their edges along their curves), for faces
   * that fail to mesh or a part that does (tessellateScene's `outlines`): every face's id, in order, and the outlines
   * of `faces` (all if absent), in the part's units minus its origin. Optional; like `payload`, a function.
   */
  outline?: (o: { linearDeflection: number; angularDeflection: number; faces?: ReadonlySet<number> }) =>
    { faces: number[]; positions: Float32Array; outlines: { source: number; start: number; count: number }[] };
}

/** One level of detail of a part: a mesh, where it came from, and how fine it is where that's known. */
export interface Lod {
  mesh: Mesh;
  /** The source file's, or made from the B-rep by a tessellator. */
  from: 'source' | 'tessellated';
  /** Maximum distance from the surface, millimetres: as tessellated, or as the source states it. */
  linearDeflection?: number;
  /** Maximum angle between adjacent normals, radians: likewise. */
  angularDeflection?: number;
  /** The tessellator that made it: its name and version. */
  backend?: string;
}

/** A triangle mesh, with any wireframe curves and points, in the part's coordinates minus `origin`. */
export interface Mesh {
  origin: Vec3;
  /** The box of everything it draws, in its coordinates (positions' frame); none if it draws nothing (meshBox). */
  box?: Box;
  positions: Float32Array;
  normals?: Float32Array;
  indices: Uint32Array;
  /**
   * Index ranges per source face; they partition `indices`. A face may repeat; null for ranges with no known source.
   */
  faces: { source: number | null; start: number; count: number }[];
  edgePositions?: Float32Array;
  edges?: { source: number | null; start: number; count: number; kind: EdgeKind; dihedral?: number }[];
  /** Wireframe curves (not faces' edges) as polylines, all concatenated; a curve may repeat, null if unknown. */
  curvePositions?: Float32Array;
  curves?: { source: number | null; start: number; count: number }[];
  /** Isolated points, and each one's source (or null). */
  points?: Float32Array;
  pointSources?: (number | null)[];
  /**
   * Outlines of faces that failed to mesh (faceFailures), from the backend (a failed piece's edges) or else the
   * source (BrepPart.outline): polylines, all concatenated, one or more a face (its edges).
   */
  faceOutlinePositions?: Float32Array;
  faceOutlines?: { source: number; start: number; count: number }[];
}

export type EdgeKind = 'shared' | 'seam' | 'free' | 'degenerate';

export interface Material {
  name?: string;
  /** RGB in [0, 1], as the source gives it (STEP colours are sRGB). */
  color: Vec3;
  /** 1 opaque, 0 invisible. */
  opacity: number;
  sources: SourceId[];
}

export interface Layer {
  name: string;
  description?: string;
  visible: boolean;
  /** Members: whole parts, and single faces of parts. */
  parts: number[];
  faces: { part: number; face: number }[];
  sources: SourceId[];
}

/** A change to one instance in the expanded tree. */
export interface InstanceOverride {
  /** Indices from the root: into `Scene.roots`, then into each component's `children`. */
  path: number[];
  /**
   * Only this part reference of the component at `path` (an index into its `parts`), not the whole subtree (the user,
   * 2026-10-29: so importers can say what a format says per placed part). Absent: everything beneath.
   */
  ref?: number;
  material?: number;
  visible?: boolean;
  /** Per-face materials of this instance's parts (STEP: context-dependent overriding styles on faces). */
  faceMaterials?: { part: number; face: number; material: number }[];
  sources: SourceId[];
}
