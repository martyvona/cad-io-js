// The OCCT tessellation backend: implements cad-scene's Tessellator over the WebAssembly build of native/occt_tess.cpp
// (build with ./build.sh). License: LGPL-2.1 with the Open CASCADE exception, isolated in this package.

import type { Diagnostic, EdgeKind, TessellationRequest, TessellationResult, Tessellator,
  TessellatorInfo } from 'cad-scene';
import { sha256 } from 'cad-scene';

interface OcctModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  UTF8ToString(p: number): string;
  _malloc(n: number): number;
  _free(p: number): void;
  _occt_tessellate(data: number, len: number, rootId: number, lin: number, ang: number, productMode: number, ox: number,
    oy: number, oz: number): number;
  _occt_positions(): number;
  _occt_normals(): number;
  _occt_num_vertices(): number;
  _occt_indices(): number;
  _occt_num_indices(): number;
  _occt_faces(): number;
  _occt_num_faces(): number;
  _occt_edge_positions(): number;
  _occt_num_edge_points(): number;
  _occt_edges(): number;
  _occt_edge_angles(): number;
  _occt_num_edges(): number;
  _occt_curve_positions(): number;
  _occt_num_curve_points(): number;
  _occt_curves(): number;
  _occt_num_curves(): number;
  _occt_points(): number;
  _occt_point_ids(): number;
  _occt_num_points(): number;
  _occt_diag(): number;
  /** Failed faces' outlines (builds before 2026-10-28 lack them). */
  _occt_outline_positions?(): number;
  _occt_num_outline_points?(): number;
  _occt_outlines?(): number;
  _occt_num_outlines?(): number;
  /** Faces' measures, when switched on (builds before 2026-10-30 lack them): quads of id, area, perimeter, valid. */
  _occt_set_measures?(on: number): void;
  _occt_measures?(): number;
  _occt_num_measures?(): number;
  /** Our OCCT patches the build has, comma-separated (builds before 2026-10-25 lack it). */
  _occt_patches?(): number;
  _occt_free(): void;
}

const KINDS: EdgeKind[] = ['shared', 'seam', 'free', 'degenerate'];

/**
 * OCCT's printed messages are kept per part as warnings, at most this many and this many characters in all; the rest
 * are counted. In the corpus a part prints at most 2 (`*** ERR StepReaderData : Unresolved Reference : Fails Count :
 * 13 ***`, `**** ERR StepFile : Incorrect Syntax : ...`); see CLAUDE.md, "OCCT".
 */
export const MAX_MESSAGES = 10;
export const MAX_MESSAGE_CHARS = 1000;

/** Changes when this adapter's results change for the same module, so that cached results from before aren't read. */
const ADAPTER = 2;

/** Collects one tessellate call's messages, within the limits. Exported for the tests. */
export class Messages {
  readonly kept: string[] = [];
  chars = 0;
  dropped = 0;
  add(text: string): void {
    const t = text.replace(/^\*+\s*|\s*\*+$/g, '');
    if (!t) return;
    if (this.kept.length === MAX_MESSAGES || this.chars === MAX_MESSAGE_CHARS) { this.dropped++; return; }
    const kept = t.slice(0, MAX_MESSAGE_CHARS - this.chars);
    this.kept.push(kept.length < t.length ? `${kept}...` : kept);
    this.chars += kept.length;
  }
  diagnostics(): Diagnostic[] {
    const d: Diagnostic[] = this.kept.map((t) => ({ severity: 'warning', message: `OCCT: ${t}` }));
    if (this.dropped) d.push({ severity: 'warning', message: `OCCT: ${this.dropped} more messages left out` });
    return d;
  }
}

/** What this adapter uses of the module: the wrapper's C functions, the allocator, and the runtime's heap views. */
export const REQUIRED_EXPORTS: readonly (keyof OcctModule)[] = [
  'HEAPU8', 'HEAPF32', 'HEAPU32', 'HEAP32', 'UTF8ToString', '_malloc', '_free', '_occt_tessellate', '_occt_positions',
  '_occt_normals', '_occt_num_vertices', '_occt_indices', '_occt_num_indices', '_occt_faces', '_occt_num_faces',
  '_occt_edge_positions', '_occt_num_edge_points', '_occt_edges', '_occt_edge_angles', '_occt_num_edges',
  '_occt_curve_positions', '_occt_num_curve_points', '_occt_curves', '_occt_num_curves', '_occt_points',
  '_occt_point_ids', '_occt_num_points', '_occt_diag', '_occt_free',
];

/** Emscripten's module factory: the default export of the JavaScript glue built with the module. */
export type OcctFactory = (moduleArg: {
  instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => object;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<unknown>;

/**
 * Where `OcctTessellator.init` gets its module, for hosts with their own OCCT build that links native/occt_tess.cpp
 * (third_party/README.md, "A custom OCCT build for tess-occt"). The glue and the module must come from the same build.
 * In a worker pool (tess-workers), the options are posted to each worker: give URLs or a compiled module, not bytes
 * of a large module or a function, which can't be posted.
 */
export interface OcctInitOptions {
  /** The Emscripten glue: its factory (the .mjs's default export), or the .mjs's URL. Default dist/occt_tess.mjs. */
  glue?: OcctFactory | URL | string;
  /** The module: its bytes, its URL, or compiled (then `version` is required). Default dist/occt_tess.wasm. */
  wasm?: BufferSource | URL | string | WebAssembly.Module;
  /**
   * Names the build in `info.version`, which cache keys include, in place of "OCCT 8.1 (<commit>)"; required with a
   * compiled module, whose bytes can't be hashed, and then it must change whenever the module does.
   */
  version?: string;
}

async function fetchBytes(url: URL): Promise<BufferSource> {
  if (url.protocol === 'file:') return (await import('node:fs/promises')).readFile(url);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

/** The first 12 hex digits of the module's SHA-256, so that `info.version` changes with every build. */
async function wasmId(bytes: BufferSource): Promise<string> {
  const hash = await sha256(bytes);
  return Array.from(hash.subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class OcctTessellator implements Tessellator {
  readonly info: TessellatorInfo = {
    name: 'occt', version: 'OCCT 8.1 (3d097a0328)', license: 'LGPL-2.1-only WITH OCCT-exception-1.0',
    formats: ['step'], supportsFaceIds: true, supportsEdges: true, supportsCurves: true,
  };
  private m?: OcctModule;
  /** Where OCCT's messages go during a tessellate call; outside one (init) they're dropped. */
  private messages?: Messages;

  /**
   * Load and instantiate the WebAssembly module: by default dist/occt_tess.mjs and dist/occt_tess.wasm beside this
   * package. A host with its own OCCT build, one that links native/occt_tess.cpp as third_party/README.md describes,
   * passes it instead (`OcctInitOptions`). The module is compiled here rather than by Emscripten's loader, to hash it:
   * `info.version` then names the hash too, so caches tell builds apart.
   */
  async init(opts: OcctInitOptions = {}): Promise<void> {
    if (this.m) return;
    const { glue, wasm, version } = opts;
    if (wasm instanceof WebAssembly.Module && version === undefined) throw new TypeError(
      'tess-occt: init({wasm}) with a compiled WebAssembly.Module needs a version, since it has no bytes to hash');
    const glueUrl = glue === undefined ? new URL('../dist/occt_tess.mjs', import.meta.url).href : String(glue);
    const factory = typeof glue === 'function' ? glue : (await import(glueUrl)).default as OcctFactory;
    let bytes: BufferSource | undefined;
    let module: WebAssembly.Module;
    if (wasm instanceof WebAssembly.Module) module = wasm;
    else {
      const b = wasm !== undefined && typeof wasm !== 'string' && !(wasm instanceof URL) ? wasm : await fetchBytes(
        wasm === undefined ? new URL('../dist/occt_tess.wasm', import.meta.url) : new URL(wasm));
      module = await WebAssembly.compile(b);
      bytes = b;
    }
    const id = bytes && await wasmId(bytes);
    // Emscripten waits on `done` without a way to fail, so a failed instantiation rejects alongside it.
    let fail!: (e: unknown) => void;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    this.m = (await Promise.race([factory({
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(module, imports).then(done, fail);
        return {};
      },
      // OCCT prints to standard output (and maybe error): kept as diagnostics instead of written anywhere.
      print: (text) => this.messages?.add(text),
      printErr: (text) => this.messages?.add(text),
    }), failed])) as OcctModule;
    const missing = REQUIRED_EXPORTS.filter((k) => !(k in this.m!));
    if (missing.length) {
      this.m = undefined;
      throw new Error(`tess-occt: the module lacks ${missing.join(', ')}: is native/occt_tess.cpp linked in, with the `
        + 'exports packages/tess-occt/build.sh lists?');
    }
    // Our OCCT patches the module was built with, named unless the host names its build itself.
    const patches = this.m._occt_patches ? this.m.UTF8ToString(this.m._occt_patches()) : '';
    const ours = glue === undefined && wasm === undefined ? 'OCCT 8.1 (3d097a0328)' : 'OCCT, a host build';
    const name = version ?? ours + (patches ? ` + patches ${patches}` : '');
    this.info.version = `${name}${id ? `, wasm ${id}` : ''}, adapter ${ADAPTER}`;
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    const m = this.m;
    if (!m) throw new Error('OcctTessellator: call init() first');
    if (req.format !== 'step') throw new Error(`OcctTessellator: format '${req.format}' isn't supported yet`);
    const origin = req.origin ?? [0, 0, 0];
    const ptr = m._malloc(req.data.length);
    m.HEAPU8.set(req.data, ptr);
    let rc: number;
    const messages = this.messages = new Messages();
    m._occt_set_measures?.(req.measures ? 1 : 0);
    try {
      rc = m._occt_tessellate(ptr, req.data.length, req.rootId ?? 0, req.linearDeflection, req.angularDeflection, 0,
        origin[0], origin[1], origin[2]);
    } finally {
      m._free(ptr);
      this.messages = undefined;
    }
    const diagText = m.UTF8ToString(m._occt_diag());
    const diag = JSON.parse(diagText) as Record<string, unknown>;
    const diagnostics = messages.diagnostics();
    if (rc !== 0) {
      m._occt_free();
      diagnostics.push({ severity: 'error',
        message: `OCCT: ${String(diag.error)}${diag.what ? `: ${String(diag.what)}` : ''}` });
      return { origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics };
    }
    // Copy out of the heap: it can move on the next allocation.
    const f32 = (p: number, n: number) => m.HEAPF32.slice(p >> 2, (p >> 2) + n);
    const u32 = (p: number, n: number) => m.HEAPU32.slice(p >> 2, (p >> 2) + n);
    const i32 = (p: number, n: number) => m.HEAP32.slice(p >> 2, (p >> 2) + n);
    const nv = m._occt_num_vertices();
    const positions = f32(m._occt_positions(), nv * 3);
    const normals = f32(m._occt_normals(), nv * 3);
    const indices = u32(m._occt_indices(), m._occt_num_indices());
    const faceData = i32(m._occt_faces(), m._occt_num_faces() * 3);
    const faces: TessellationResult['faces'] = [];
    for (let i = 0; i < faceData.length; i += 3) {
      faces.push({ entityId: faceData[i]! < 0 ? null : faceData[i]!, start: faceData[i + 1]!,
        count: faceData[i + 2]! });
    }
    const result: TessellationResult = { origin, positions, normals, indices, faces, diagnostics };
    const nm = req.measures ? m._occt_num_measures?.() ?? 0 : 0;
    if (nm) {
      const at = m._occt_measures!() >> 3;
      const q = m.HEAPF64.slice(at, at + 4 * nm);
      result.measures = [];
      for (let i = 0; i < q.length; i += 4) {
        result.measures.push({ entityId: q[i]!, area: q[i + 1]!, perimeter: q[i + 2]!, valid: q[i + 3] === 1 });
      }
    }
    if (req.edges) {
      const ne = m._occt_num_edges();
      const edgeData = i32(m._occt_edges(), ne * 4);
      const angles = f32(m._occt_edge_angles(), ne);
      result.edgePositions = f32(m._occt_edge_positions(), m._occt_num_edge_points() * 3);
      result.edges = [];
      for (let i = 0; i < ne; i++) {
        const e: NonNullable<TessellationResult['edges']>[number] = {
          entityId: edgeData[i * 4]! < 0 ? null : edgeData[i * 4]!, start: edgeData[i * 4 + 1]!,
          count: edgeData[i * 4 + 2]!, kind: KINDS[edgeData[i * 4 + 3]!]!,
        };
        if (angles[i]! >= 0) e.dihedral = angles[i]!;
        result.edges.push(e);
      }
    }
    const nc = m._occt_num_curves();
    if (nc) {
      const curveData = i32(m._occt_curves(), nc * 3);
      result.curvePositions = f32(m._occt_curve_positions(), m._occt_num_curve_points() * 3);
      result.curves = [];
      for (let i = 0; i < curveData.length; i += 3) {
        result.curves.push({ entityId: curveData[i]! < 0 ? null : curveData[i]!, start: curveData[i + 1]!,
          count: curveData[i + 2]! });
      }
    }
    const no = m._occt_num_outlines?.() ?? 0;
    if (no) {
      const outlineData = i32(m._occt_outlines!(), no * 3);
      result.outlinePositions = f32(m._occt_outline_positions!(), m._occt_num_outline_points!() * 3);
      result.outlines = [];
      for (let i = 0; i < outlineData.length; i += 3) {
        result.outlines.push({ entityId: outlineData[i]! < 0 ? null : outlineData[i]!, start: outlineData[i + 1]!,
          count: outlineData[i + 2]! });
      }
    }
    const np = m._occt_num_points();
    if (np) {
      result.points = f32(m._occt_points(), np * 3);
      result.pointIds = Array.from(i32(m._occt_point_ids(), np), (id) => (id < 0 ? null : id));
    }
    m._occt_free();
    if (diag.unmapped) diagnostics.push(
      { severity: 'info', message: `${String(diag.unmapped)} faces without a STEP entity id` });
    if (diag.noTriangulation) diagnostics.push(
      { severity: 'warning', message: `${String(diag.noTriangulation)} faces failed to mesh` });
    if (diag.curvesUnmapped) diagnostics.push(
      { severity: 'info', message: `${String(diag.curvesUnmapped)} curves without a STEP entity id` });
    if (diag.curvesNoPolygon) diagnostics.push(
      { severity: 'warning', message: `${String(diag.curvesNoPolygon)} curves failed to discretize` });
    return result;
  }

  memoryBytes(): number {
    return this.m?.HEAPU8.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.m = undefined;
  }
}
