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
  /** File-level metadata. */
  properties: Properties;
  diagnostics: Diagnostic[];
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

export type Part = BrepPart | MeshPart | CurvesPart;

interface PartBase {
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
}

/** Exact geometry, tessellated on demand by a backend. */
export interface BrepPart extends PartBase {
  kind: 'brep';
  format: 'step' | 'iges' | 'brep';
  /** The tessellation payload (a STEP subset, say). A function, since building it is work only needed on demand. */
  payload: () => Uint8Array;
  /** The root entity within the payload (STEP: the shape representation). */
  rootId?: number;
}

/** Geometry already tessellated in the source. */
export interface MeshPart extends PartBase {
  kind: 'mesh';
  /** Levels of detail, finest first. */
  lods: Mesh[];
}

/** Wireframe or edge-only geometry. */
export interface CurvesPart extends PartBase {
  kind: 'curves';
  /** Polylines, in the part's coordinates minus its origin. */
  positions: Float32Array;
  polylines: { start: number; count: number; source?: number }[];
}

/** A triangle mesh, with any wireframe curves and points, in the part's coordinates minus `origin`. */
export interface Mesh {
  origin: Vec3;
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
  material?: number;
  visible?: boolean;
  /** Per-face materials of this instance's parts (STEP: context-dependent overriding styles on faces). */
  faceMaterials?: { part: number; face: number; material: number }[];
  sources: SourceId[];
}
