// The tessellator interface: one request per part, its payload parsed by the backend. See docs/architecture.md,
// "The tessellator interface". Backends implement it in their own packages (tess-occt, tess-truck).

import type { Diagnostic, EdgeKind, Vec3 } from './scene.ts';

export type PayloadFormat = 'step' | 'iges' | 'brep';

export interface TessellatorInfo {
  name: string;
  version: string;
  license: string;
  formats: PayloadFormat[];
  supportsFaceIds: boolean;
  supportsEdges: boolean;
}

export interface TessellationRequest {
  format: PayloadFormat;
  /** One part's payload; STEP subsets keep the original #ids. */
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
  /** Also return B-rep edges as polylines. */
  edges?: boolean;
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
  diagnostics: Diagnostic[];
}

export interface Tessellator {
  readonly info: TessellatorInfo;
  /** Load and compile the backend (WASM). */
  init(opts?: Record<string, unknown>): Promise<void>;
  tessellate(req: TessellationRequest): Promise<TessellationResult>;
  /**
   * The backend's memory in bytes (WASM: its linear memory, which never shrinks), so a host can recycle an instance
   * that has grown too large. Optional.
   */
  memoryBytes?(): number;
  /** The time limit per request, in milliseconds, that this tessellator enforces (0: none). Absent if it has none. */
  readonly timeoutMs?: number;
  dispose(): void;
}
