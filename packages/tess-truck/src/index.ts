// The truck tessellation backend: implements cad-scene's Tessellator over the WebAssembly build of native/ (build
// with ./build.sh). truck panics on some inputs; a panic traps the module, so the instance is replaced and the
// request returns an error diagnostic. truck can also hang: run it in tess-workers' pool for a timeout.

import type { Diagnostic, EdgeKind, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from 'cad-scene';

interface Exports {
  memory: WebAssembly.Memory;
  tess_init(): void;
  tess_alloc(len: number): number;
  tess_dealloc(ptr: number, len: number): void;
  tess_run(ptr: number, len: number, root: number, tol: number, ox: number, oy: number, oz: number, edges: number): number;
  tess_ptr(which: number): number;
  tess_len(which: number): number;
  tess_free(): void;
}

interface Diag {
  error?: string;
  unconvertedFaces?: number[];
  unconvertedEdges?: number[];
  unmeshedFaces?: number[];
  skippedItems?: string[];
  fixedPlacements?: number;
  curves3d?: number;
  tori?: number;
  cones?: number;
  nonfiniteEdges?: number[];
  nonfiniteFaces?: number[];
  unreadInstances?: number[];
  reversedShells?: [number, boolean][];
  uncheckedShells?: number[];
  inconsistentShells?: number[];
  unclearShells?: number[];
  clampedEdges?: number;
  clampedFaces?: number;
  flippedFaces?: number[];
}

const KINDS: EdgeKind[] = ['shared', 'seam', 'free', 'degenerate'];
const [POSITIONS, NORMALS, INDICES, FACES, EDGE_POSITIONS, EDGES, EDGE_ANGLES, DIAG] = [0, 1, 2, 3, 4, 5, 6, 7];

/** The wasm-bindgen runtime imports truck's dependencies leave in the module (chrono, getrandom). Nothing on our
 *  path calls them; if something does, the call fails loudly. */
export const WBINDGEN_IMPORTS: Record<string, string[]> = {
  __wbindgen_placeholder__: ['__wbindgen_describe', '__wbg___wbindgen_jspi_spawn_poll_4e3f923bdfe46933', '__wbg___wbindgen_throw_41e9ee4f547fc59a'],
  __wbindgen_externref_xform__: ['__wbindgen_externref_table_set_null', '__wbindgen_externref_table_grow'],
};

const list = (ids: number[], n = 10) => ids.slice(0, n).map((i) => `#${i}`).join(', ') + (ids.length > n ? ', …' : '');

async function wasmBytes(source?: BufferSource | URL | string): Promise<BufferSource> {
  if (source && typeof source !== 'string' && !(source instanceof URL)) return source;
  const url = source ? new URL(source) : new URL('../dist/tess_truck.wasm', import.meta.url);
  if (url.protocol === 'file:') {
    const fs = await import('node:fs/promises');
    return fs.readFile(url);
  }
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** The first 12 hex digits of the module's SHA-256, so that `info.version` changes with every build. */
async function wasmId(bytes: BufferSource): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(hash.subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TruckTessellator implements Tessellator {
  readonly info: TessellatorInfo = {
    name: 'truck', version: 'truck 88ed005', license: 'Apache-2.0',
    formats: ['step'], supportsFaceIds: true, supportsEdges: true, supportsCurves: false,
  };
  private module?: WebAssembly.Module;
  private x?: Exports;
  private panic = '';

  /**
   * Compile and instantiate the module. `opts.wasm`: its bytes or URL (default dist/tess_truck.wasm next to this
   * package). `info.version` then names the module's hash too.
   */
  async init(opts?: Record<string, unknown>): Promise<void> {
    if (this.x) return;
    if (!this.module) {
      const bytes = await wasmBytes(opts?.wasm as BufferSource | URL | string | undefined);
      this.module = await WebAssembly.compile(bytes);
      this.info.version = `truck 88ed005, wasm ${await wasmId(bytes)}`;
    }
    this.instantiate();
  }

  private instantiate(): void {
    const stubs: WebAssembly.Imports = {};
    for (const [mod, names] of Object.entries(WBINDGEN_IMPORTS)) {
      stubs[mod] = Object.fromEntries(names.map((n) => [n, () => { throw new Error(`tess-truck: unexpected call to ${mod}.${n}`); }]));
    }
    const env = {
      tess_panic: (ptr: number, len: number) => {
        this.panic = new TextDecoder().decode(new Uint8Array(this.x!.memory.buffer, ptr, len));
      },
    };
    const instance = new WebAssembly.Instance(this.module!, { ...stubs, env });
    this.x = instance.exports as unknown as Exports;
    this.x.tess_init();
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    if (!this.x) throw new Error('TruckTessellator: call init() first');
    if (req.format !== 'step') throw new Error(`TruckTessellator: format '${req.format}' isn't supported`);
    const x = this.x;
    const origin = req.origin ?? [0, 0, 0];
    const empty = (diagnostics: Diagnostic[]): TessellationResult => ({ origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics });
    let rc: number;
    try {
      const ptr = x.tess_alloc(req.data.length);
      new Uint8Array(x.memory.buffer, ptr, req.data.length).set(req.data);
      try {
        rc = x.tess_run(ptr, req.data.length, req.rootId ?? 0, req.linearDeflection, origin[0], origin[1], origin[2], req.edges ? 1 : 0);
      } finally {
        x.tess_dealloc(ptr, req.data.length);
      }
    } catch (e) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      // A panic (or another trap): the instance can't be trusted any more.
      const message = this.panic || e.message;
      this.panic = '';
      this.instantiate();
      return empty([{ severity: 'error', message: `truck panicked: ${message}` }]);
    }
    const view = <T extends Float32Array | Uint32Array | Int32Array>(C: { new (b: ArrayBuffer, o: number, n: number): T }, which: number) =>
      new C(x.memory.buffer, x.tess_ptr(which), x.tess_len(which)).slice() as T;
    const diag = JSON.parse(new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.tess_ptr(DIAG), x.tess_len(DIAG)))) as Diag;
    const diagnostics: Diagnostic[] = [];
    if (rc !== 0) {
      x.tess_free();
      return empty([{ severity: 'error', message: `truck: ${diag.error ?? 'failed'}` }]);
    }
    const faceData = view(Int32Array, FACES);
    const faces: TessellationResult['faces'] = [];
    for (let i = 0; i < faceData.length; i += 3) faces.push({ entityId: faceData[i]! < 0 ? null : faceData[i]!, start: faceData[i + 1]!, count: faceData[i + 2]! });
    const result: TessellationResult = { origin, positions: view(Float32Array, POSITIONS), normals: view(Float32Array, NORMALS), indices: view(Uint32Array, INDICES), faces, diagnostics };
    if (req.edges) {
      const edgeData = view(Int32Array, EDGES);
      const angles = view(Float32Array, EDGE_ANGLES);
      result.edgePositions = view(Float32Array, EDGE_POSITIONS);
      result.edges = [];
      for (let i = 0; i < angles.length; i++) {
        const e: NonNullable<TessellationResult['edges']>[number] = {
          entityId: edgeData[i * 4]! < 0 ? null : edgeData[i * 4]!, start: edgeData[i * 4 + 1]!, count: edgeData[i * 4 + 2]!, kind: KINDS[edgeData[i * 4 + 3]!]!,
        };
        if (angles[i]! >= 0) e.dihedral = angles[i]!;
        result.edges.push(e);
      }
    }
    x.tess_free();
    if (diag.unreadInstances?.length) diagnostics.push({ severity: 'warning', message: `${diag.unreadInstances.length} instances truck's parser can't read (left out): ${list(diag.unreadInstances)}` });
    if (diag.nonfiniteFaces?.length) diagnostics.push({ severity: 'warning', message: `${diag.nonfiniteFaces.length} faces whose surfaces truck evaluates to NaN (left out): ${list(diag.nonfiniteFaces)}` });
    if (diag.nonfiniteEdges?.length) diagnostics.push({ severity: 'warning', message: `${diag.nonfiniteEdges.length} edges whose curves truck evaluates to NaN (left out, with their faces): ${list(diag.nonfiniteEdges)}` });
    if (diag.unconvertedFaces?.length) diagnostics.push({ severity: 'warning', message: `${diag.unconvertedFaces.length} faces truck can't convert (left out): ${list(diag.unconvertedFaces)}` });
    if (diag.unconvertedEdges?.length) diagnostics.push({ severity: 'warning', message: `${diag.unconvertedEdges.length} edges truck can't convert: ${list(diag.unconvertedEdges)}` });
    if (diag.unmeshedFaces?.length) diagnostics.push({ severity: 'warning', message: `${diag.unmeshedFaces.length} faces failed to mesh: ${list(diag.unmeshedFaces)}` });
    if (diag.skippedItems?.length) diagnostics.push({ severity: 'warning', message: `representation items truck doesn't mesh: ${diag.skippedItems.slice(0, 10).join(', ')}${diag.skippedItems.length > 10 ? ', …' : ''}` });
    if (diag.flippedFaces?.length) diagnostics.push({ severity: 'info', message: `${diag.flippedFaces.length} faces reversed, since truck meshed them against all their loops: ${list(diag.flippedFaces)}` });
    for (const [id, isVoid] of diag.reversedShells ?? []) diagnostics.push({ severity: 'info', message: `shell #${id} reversed: as written, this ${isVoid ? 'void' : 'outer shell'} faces into the material` });
    if (diag.inconsistentShells?.length) diagnostics.push({ severity: 'info', message: `orientation of ${diag.inconsistentShells.length} solid shells not checked, since their faces disagree in orientation: ${list(diag.inconsistentShells)}` });
    if (diag.unclearShells?.length) diagnostics.push({ severity: 'info', message: `orientation of ${diag.unclearShells.length} solid shells not checked, since their meshes' volumes are too small or uncertain to tell: ${list(diag.unclearShells)}` });
    if (diag.uncheckedShells?.length) diagnostics.push({ severity: 'info', message: `orientation of ${diag.uncheckedShells.length} solid shells not checked, since their meshes aren't closed: ${list(diag.uncheckedShells)}` });
    if (diag.curves3d) diagnostics.push({ severity: 'info', message: `${diag.curves3d} SURFACE_CURVEs read by their 3D curve instead of a pcurve` });
    if (diag.cones) diagnostics.push({ severity: 'info', message: `${diag.cones} CONICAL_SURFACE semi-angles converted to radians from the context's angle unit` });
    if (diag.tori) diagnostics.push({ severity: 'info', message: `${diag.tori} TOROIDAL_SURFACEs with negative radii read with their absolute values` });
    if (diag.clampedEdges || diag.clampedFaces) diagnostics.push({ severity: 'info', message: `B-splines with unclamped knot vectors clamped to their valid range, which truck lacks: ${diag.clampedEdges ?? 0} edge curves, ${diag.clampedFaces ?? 0} face surfaces` });
    if (diag.fixedPlacements) diagnostics.push({ severity: 'info', message: `${diag.fixedPlacements} AXIS2_PLACEMENT_3Ds along x without a ref_direction given the standard's default (0, 1, 0), which truck lacks` });
    return result;
  }

  memoryBytes(): number {
    return this.x?.memory.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.x = undefined;
  }
}
