// The truck tessellation backend: implements cad-scene's Tessellator over the WebAssembly build of native/ (build
// with ./build.sh), taking a part's model (native/src/model.rs). truck panics on some
// inputs; a panic traps the module, so the instance is replaced and the request returns an error diagnostic. truck
// can also hang: run it in tess-workers' pool for a timeout.

import type { Diagnostic, EdgeKind, TessellationRequest, TessellationResult, Tessellator,
  TessellatorInfo } from 'cad-scene';
import { sha256 } from 'cad-scene';

interface Exports {
  memory: WebAssembly.Memory;
  tess_init(): void;
  tess_alloc(len: number): number;
  tess_dealloc(ptr: number, len: number): void;
  tess_run_model(ptr: number, len: number, tol: number, ox: number, oy: number, oz: number, edges: number): number;
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
  nonfiniteEdges?: number[];
  nonfiniteFaces?: number[];
  reversedShells?: [number, boolean][];
  uncheckedShells?: number[];
  inconsistentShells?: number[];
  unclearShells?: number[];
  clampedEdges?: number;
  clampedFaces?: number;
  flippedFaces?: number[];
}

const KINDS: EdgeKind[] = ['shared', 'seam', 'free', 'degenerate'];
/** Changes when this adapter's results change for the same module, so that cached results from before aren't read. */
const ADAPTER = 1;
const [POSITIONS, NORMALS, INDICES, FACES, EDGE_POSITIONS, EDGES, EDGE_ANGLES, DIAG] = [0, 1, 2, 3, 4, 5, 6, 7];

/** The wasm-bindgen runtime imports truck's dependencies leave in the module (chrono, getrandom). Nothing on our
 *  path calls them; if something does, the call fails loudly. */
export const WBINDGEN_IMPORTS: Record<string, string[]> = {
  __wbindgen_placeholder__: ['__wbindgen_describe', '__wbg___wbindgen_jspi_spawn_poll_4e3f923bdfe46933',
    '__wbg___wbindgen_throw_41e9ee4f547fc59a'],
  __wbindgen_externref_xform__: ['__wbindgen_externref_table_set_null', '__wbindgen_externref_table_grow'],
};

/** Ids as the diagnostics list them (0: a row of the model without one). */
const list = (ids: number[], n = 10) => ids.slice(0, n).map((i) => (i ? `#${i}` : '(no id)')).join(', ')
  + (ids.length > n ? ', ...' : '');

/**
 * Where `TruckTessellator.init` gets its module: another build of native/ (this package's wrapper over truck), say
 * one a host already loads. In a worker pool (tess-workers) the options are posted to each worker: a URL or a
 * compiled module, not the bytes of a large module.
 */
export interface TruckInitOptions {
  /** The module: its bytes, its URL, or compiled (then `version` is required). Default dist/tess_truck.wasm. */
  wasm?: BufferSource | URL | string | WebAssembly.Module;
  /**
   * Names the build in `info.version`, which cache keys include, in place of "truck <commit>"; required with a
   * compiled module, whose bytes can't be hashed, and then it must change whenever the module does.
   */
  version?: string;
}

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
  const hash = await sha256(bytes);
  return Array.from(hash.subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class TruckTessellator implements Tessellator {
  readonly info: TessellatorInfo = {
    // (Our wrapper's license, AGPL-3.0-only, over truck's Apache-2.0: the module as a whole.)
    name: 'truck', version: 'truck 88ed005', license: 'AGPL-3.0-only',
    // (Models only: StepTessellator passes them through.)
    formats: ['cad-brep'], supportsFaceIds: true, supportsEdges: true, supportsCurves: false,
  };
  private module?: WebAssembly.Module;
  private x?: Exports;
  private panic = '';

  /**
   * Compile and instantiate the module, by default dist/tess_truck.wasm next to this package. `info.version` then
   * names the module's hash too, so caches tell builds apart (`TruckInitOptions`).
   */
  async init(opts: TruckInitOptions = {}): Promise<void> {
    if (this.x) return;
    if (!this.module) {
      const { wasm, version } = opts;
      if (wasm instanceof WebAssembly.Module) {
        if (version === undefined) throw new TypeError(
          'tess-truck: init({wasm}) with a compiled WebAssembly.Module needs a version, since it has no bytes to hash');
        this.module = wasm;
        this.info.version = `${version}, adapter ${ADAPTER}`;
      } else {
        const bytes = await wasmBytes(wasm);
        this.module = await WebAssembly.compile(bytes);
        this.info.version = `${version ?? 'truck 88ed005'}, wasm ${await wasmId(bytes)}, adapter ${ADAPTER}`;
      }
    }
    this.instantiate();
  }

  private instantiate(): void {
    const stubs: WebAssembly.Imports = {};
    for (const [mod, names] of Object.entries(WBINDGEN_IMPORTS)) {
      stubs[mod] = Object.fromEntries(
        names.map((n) => [n, () => { throw new Error(`tess-truck: unexpected call to ${mod}.${n}`); }]));
    }
    const env = {
      tess_panic: (ptr: number, len: number) => {
        this.panic = new TextDecoder().decode(new Uint8Array(this.x!.memory.buffer, ptr, len));
      },
    };
    const instance = new WebAssembly.Instance(this.module!, { ...stubs, env });
    this.x = instance.exports as unknown as Exports;
    if (!this.x.tess_run_model) {
      this.x = undefined;
      throw new Error('tess-truck: the module has no tess_run_model (a build that read STEP only): rebuild it');
    }
    this.x.tess_init();
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    if (!this.x) throw new Error('TruckTessellator: call init() first');
    if (req.format !== 'cad-brep') throw new Error(
      `TruckTessellator: format '${req.format}' isn't taken: models only`);
    const x = this.x;
    const origin = req.origin ?? [0, 0, 0];
    const empty = (diagnostics: Diagnostic[]): TessellationResult => (
      { origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics });
    let rc: number;
    try {
      const ptr = x.tess_alloc(req.data.length);
      new Uint8Array(x.memory.buffer, ptr, req.data.length).set(req.data);
      try {
        rc = x.tess_run_model(ptr, req.data.length, req.linearDeflection, origin[0], origin[1], origin[2],
          req.edges ? 1 : 0);
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
    const view = <T extends Float32Array | Uint32Array | Int32Array>(
      C: { new (b: ArrayBuffer, o: number, n: number): T }, which: number) =>
      new C(x.memory.buffer, x.tess_ptr(which), x.tess_len(which)).slice() as T;
    const diag = JSON.parse(new TextDecoder().decode(
      new Uint8Array(x.memory.buffer, x.tess_ptr(DIAG), x.tess_len(DIAG)))) as Diag;
    const diagnostics: Diagnostic[] = [];
    if (rc !== 0) {
      x.tess_free();
      return empty([{ severity: 'error', message: `truck: ${diag.error ?? 'failed'}` }]);
    }
    // (Ids 0 for none.)
    const id = (x: number) => (x === 0 ? null : x);
    const faceData = view(Uint32Array, FACES);
    const faces: TessellationResult['faces'] = [];
    for (let i = 0; i < faceData.length; i += 3) faces.push(
      { entityId: id(faceData[i]!), start: faceData[i + 1]!, count: faceData[i + 2]! });
    const result: TessellationResult = { origin, positions: view(Float32Array, POSITIONS),
      normals: view(Float32Array, NORMALS), indices: view(Uint32Array, INDICES), faces, diagnostics };
    if (req.edges) {
      const edgeData = view(Uint32Array, EDGES);
      const angles = view(Float32Array, EDGE_ANGLES);
      result.edgePositions = view(Float32Array, EDGE_POSITIONS);
      result.edges = [];
      for (let i = 0; i < angles.length; i++) {
        const e: NonNullable<TessellationResult['edges']>[number] = {
          entityId: id(edgeData[i * 4]!), start: edgeData[i * 4 + 1]!,
          count: edgeData[i * 4 + 2]!, kind: KINDS[edgeData[i * 4 + 3]!]!,
        };
        if (angles[i]! >= 0) e.dihedral = angles[i]!;
        result.edges.push(e);
      }
    }
    x.tess_free();
    if (diag.nonfiniteFaces?.length) diagnostics.push(
      { severity: 'warning', message: `${diag.nonfiniteFaces.length} faces whose surfaces truck evaluates to NaN (left `
      + `out): ${list(diag.nonfiniteFaces)}` });
    if (diag.nonfiniteEdges?.length) diagnostics.push(
      { severity: 'warning', message: `${diag.nonfiniteEdges.length} edges whose curves truck evaluates to NaN (left `
      + `out, with their faces): ${list(diag.nonfiniteEdges)}` });
    if (diag.unconvertedFaces?.length) diagnostics.push(
      { severity: 'warning', message: `${diag.unconvertedFaces.length} faces truck can't convert (left out): `
      + `${list(diag.unconvertedFaces)}` });
    if (diag.unconvertedEdges?.length) diagnostics.push(
      { severity: 'warning', message: `${diag.unconvertedEdges.length} edges truck can't convert: `
      + `${list(diag.unconvertedEdges)}` });
    // (The faces left out among them, which the warnings above say why of: a face without triangles is a failure.)
    const failed = [...new Set([...diag.unmeshedFaces ?? [], ...diag.unconvertedFaces ?? [],
      ...diag.nonfiniteFaces ?? []])].sort((a, b) => a - b);
    if (failed.length) diagnostics.push(
      { severity: 'error', message: `${failed.length} faces failed to mesh: ${list(failed)}` });
    if (diag.skippedItems?.length) diagnostics.push(
      { severity: 'warning', message: `representation items truck doesn't mesh: `
      + `${diag.skippedItems.slice(0, 10).join(', ')}${diag.skippedItems.length > 10 ? ', ...' : ''}` });
    if (diag.flippedFaces?.length) diagnostics.push(
      { severity: 'info', message: `${diag.flippedFaces.length} faces reversed, since truck meshed them against all `
      + `their loops: ${list(diag.flippedFaces)}` });
    for (const [id, isVoid] of diag.reversedShells ?? []) diagnostics.push(
      { severity: 'info', message: `shell ${list([id])} reversed: as written, this ${isVoid ? 'void' : 'outer shell'} `
      + 'faces into the material' });
    if (diag.inconsistentShells?.length) diagnostics.push(
      { severity: 'info', message: `orientation of ${diag.inconsistentShells.length} solid shells not checked, since `
      + `their faces disagree in orientation: ${list(diag.inconsistentShells)}` });
    if (diag.unclearShells?.length) diagnostics.push(
      { severity: 'info', message: `orientation of ${diag.unclearShells.length} solid shells not checked, since their `
      + `meshes' volumes are too small or uncertain to tell: ${list(diag.unclearShells)}` });
    if (diag.uncheckedShells?.length) diagnostics.push(
      { severity: 'info', message: `orientation of ${diag.uncheckedShells.length} solid shells not checked, since `
      + `their meshes aren't closed: ${list(diag.uncheckedShells)}` });
    if (diag.clampedEdges || diag.clampedFaces) diagnostics.push(
      { severity: 'info', message: `B-splines with unclamped knot vectors clamped to their valid range, which truck `
      + `lacks: ${diag.clampedEdges ?? 0} edge curves, ${diag.clampedFaces ?? 0} face surfaces` });
    return result;
  }

  memoryBytes(): number {
    return this.x?.memory.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.x = undefined;
  }
}
