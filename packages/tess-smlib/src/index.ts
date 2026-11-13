// The SMLib tessellation backend: implements cad-scene's Tessellator over the WebAssembly build of
// native/smlib_tess.cpp (build with ./build-smlib.sh, then ./build.sh). SMLib (NVIDIA's usd-brep, Apache-2.0) builds
// each part's B-rep model, heals it and meshes it; our wrapper is AGPL-3.0-only, as the module is as a whole.

import type { EdgeKind, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from 'cad-scene';
import { oracleMeasures, sha256 } from 'cad-scene';

interface SmlibModule {
  HEAPU8: Uint8Array;
  HEAPF32: Float32Array;
  HEAPU32: Uint32Array;
  HEAPF64: Float64Array;
  UTF8ToString(p: number): string;
  _malloc(n: number): number;
  _free(p: number): void;
  _smlib_tessellate_model(data: number, len: number, lin: number, ang: number, ox: number, oy: number,
    oz: number): number;
  _smlib_set_measures(on: number): void;
  _smlib_set_heal(on: number): void;
  _smlib_set_scale(scale: number): void;
  _smlib_set_edges(on: number): void;
  _smlib_positions(): number;
  _smlib_normals(): number;
  _smlib_num_vertices(): number;
  _smlib_indices(): number;
  _smlib_num_indices(): number;
  _smlib_faces(): number;
  _smlib_num_faces(): number;
  _smlib_edge_positions(): number;
  _smlib_num_edge_points(): number;
  _smlib_edges(): number;
  _smlib_edge_angles(): number;
  _smlib_num_edges(): number;
  _smlib_measures(): number;
  _smlib_num_measures(): number;
  _smlib_curve_positions(): number;
  _smlib_num_curve_points(): number;
  _smlib_curves(): number;
  _smlib_num_curves(): number;
  _smlib_points(): number;
  _smlib_point_ids(): number;
  _smlib_num_points(): number;
  _smlib_diag(): number;
  _smlib_free(): void;
  /** Present where the id arrays are uint32 with 0 for none (a module built before had int32 with -1). */
  _smlib_ids_u32(): number;
}

const KINDS: EdgeKind[] = ['shared', 'seam', 'free', 'degenerate'];

/** Changes when this adapter's results change for the same module, so that cached results from before aren't read. */
const ADAPTER = 8;

/** The upstream source the module is built from (third_party/pull.sh). */
const SOURCE = 'SMLib (usd-brep 1.0.1, 3fd5b95)';

/** What this adapter uses of the module: the wrapper's C functions, the allocator, and the runtime's heap views. */
export const REQUIRED_EXPORTS: readonly (keyof SmlibModule)[] = [
  'HEAPU8', 'HEAPF32', 'HEAPU32', 'HEAPF64', 'UTF8ToString', '_malloc', '_free', '_smlib_tessellate_model',
  '_smlib_set_measures', '_smlib_set_heal', '_smlib_set_scale', '_smlib_set_edges', '_smlib_positions',
  '_smlib_normals', '_smlib_num_vertices',
  '_smlib_indices', '_smlib_num_indices', '_smlib_faces', '_smlib_num_faces', '_smlib_edge_positions',
  '_smlib_num_edge_points', '_smlib_edges', '_smlib_edge_angles', '_smlib_num_edges', '_smlib_measures',
  '_smlib_num_measures', '_smlib_curve_positions', '_smlib_num_curve_points', '_smlib_curves', '_smlib_num_curves',
  '_smlib_points', '_smlib_point_ids', '_smlib_num_points', '_smlib_ids_u32', '_smlib_diag', '_smlib_free',
];

/** Emscripten's module factory: the default export of the JavaScript glue built with the module. */
export type SmlibFactory = (moduleArg: {
  instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => object;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<unknown>;

/**
 * Where `SmlibTessellator.init` gets its module. The glue and the module must come from the same build. In a worker
 * pool (tess-workers), the options are posted to each worker: give URLs or a compiled module, not a function.
 */
export interface SmlibInitOptions {
  /** The Emscripten glue: its factory (the .mjs's default export), or the .mjs's URL. Default dist/smlib_tess.mjs. */
  glue?: SmlibFactory | URL | string;
  /** The module: its bytes, its URL, or compiled (then `version` is required). Default dist/smlib_tess.wasm. */
  wasm?: BufferSource | URL | string | WebAssembly.Module;
  /** Names the build in `info.version` in place of the module's hash; required with a compiled module. */
  version?: string;
}

export interface SmlibOptions {
  /** Run SMLib's healer on each B-rep built (default true). */
  heal?: boolean;
  /**
   * Build each part with its lengths times this, a power of two from 1 (the default) up; results are at the part's
   * own size all the same. SMLib has absolute constants, so which faces mesh depends on the numbers' size: small
   * parts can mesh more faces larger. (Not below 1: SMLib traps on parts made small. A power of two, so that points
   * come back as they were.)
   */
  scale?: number;
}

async function fetchBytes(url: URL): Promise<BufferSource> {
  if (url.protocol === 'file:') return (await import('node:fs/promises')).readFile(url);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

async function wasmId(bytes: BufferSource): Promise<string> {
  const hash = await sha256(bytes);
  return Array.from(hash.subarray(0, 6), (b) => b.toString(16).padStart(2, '0')).join('');
}

export class SmlibTessellator implements Tessellator {
  readonly info: TessellatorInfo = {
    name: 'smlib', version: SOURCE, license: 'AGPL-3.0-only', formats: ['cad-brep'], supportsFaceIds: true,
    supportsEdges: true, supportsCurves: true,
  };
  readonly heal: boolean;
  readonly scale: number;
  private m?: SmlibModule;
  /** SMLib's printed messages during a call: dropped (it prints debugging text only). */
  constructor(opts: SmlibOptions = {}) {
    this.heal = opts.heal ?? true;
    this.scale = opts.scale ?? 1;
    if (!(this.scale >= 1 && Number.isFinite(this.scale) && Number.isInteger(Math.log2(this.scale)))) {
      throw new RangeError('SmlibTessellator: scale must be a power of two, 1 or more');
    }
  }

  async init(opts: SmlibInitOptions = {}): Promise<void> {
    if (this.m) return;
    const { glue, wasm, version } = opts;
    if (wasm instanceof WebAssembly.Module && version === undefined) throw new TypeError(
      'tess-smlib: init({wasm}) with a compiled WebAssembly.Module needs a version, since it has no bytes to hash');
    const glueUrl = glue === undefined ? new URL('../dist/smlib_tess.mjs', import.meta.url).href : String(glue);
    const factory = typeof glue === 'function' ? glue : (await import(glueUrl)).default as SmlibFactory;
    let bytes: BufferSource | undefined;
    let module: WebAssembly.Module;
    if (wasm instanceof WebAssembly.Module) module = wasm;
    else {
      const b = wasm !== undefined && typeof wasm !== 'string' && !(wasm instanceof URL) ? wasm : await fetchBytes(
        wasm === undefined ? new URL('../dist/smlib_tess.wasm', import.meta.url) : new URL(wasm));
      module = await WebAssembly.compile(b);
      bytes = b;
    }
    const id = bytes && await wasmId(bytes);
    let fail!: (e: unknown) => void;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    this.m = (await Promise.race([factory({
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(module, imports).then(done, fail);
        return {};
      },
      print: () => {},
      printErr: () => {},
    }), failed])) as SmlibModule;
    const missing = REQUIRED_EXPORTS.filter((k) => !(k in this.m!));
    if (missing.length) {
      this.m = undefined;
      throw new Error(`tess-smlib: the module lacks ${missing.join(', ')}: is native/smlib_tess.cpp linked in, with `
        + 'the exports packages/tess-smlib/build.sh lists?');
    }
    this.info.version = `${version ?? SOURCE}${id ? `, wasm ${id}` : ''}, adapter ${ADAPTER}`
      + (this.heal ? '' : ', unhealed') + (this.scale === 1 ? '' : `, scale ${String(this.scale)}`);
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    const m = this.m;
    if (!m) throw new Error('SmlibTessellator: call init() first');
    if (req.format !== 'cad-brep') throw new Error(`SmlibTessellator: format '${req.format}' isn't taken`);
    const origin = req.origin ?? [0, 0, 0];
    // (Pointers come back as signed 32-bit numbers: unsigned, as the module's memory may pass 2 GB.)
    const ptr = m._malloc(req.data.length) >>> 0;
    m.HEAPU8.set(req.data, ptr);
    m._smlib_set_measures(req.measures ? 1 : 0);
    m._smlib_set_heal(this.heal ? 1 : 0);
    m._smlib_set_scale(this.scale);
    m._smlib_set_edges(req.edges ? 1 : 0);
    let rc: number;
    try {
      rc = m._smlib_tessellate_model(ptr, req.data.length, req.linearDeflection, req.angularDeflection, origin[0],
        origin[1], origin[2]);
    } finally {
      m._free(ptr);
    }
    const diag = JSON.parse(m.UTF8ToString(m._smlib_diag() >>> 0)) as Record<string, unknown>;
    const diagnostics: TessellationResult['diagnostics'] = [];
    for (const w of Array.isArray(diag.builder) ? diag.builder as string[] : []) diagnostics.push(
      { severity: 'warning', message: `SMLib builder: ${w}` });
    if (rc !== 0) {
      m._smlib_free();
      diagnostics.push({ severity: 'error', message: rc === -5 ? `SMLib builder: ${String(diag.error)}`
        : `SMLib: ${String(diag.error)}` });
      return { origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics };
    }
    const f32 = (p: number, n: number) => m.HEAPF32.slice(p >>> 2, (p >>> 2) + n);
    const u32 = (p: number, n: number) => m.HEAPU32.slice(p >>> 2, (p >>> 2) + n);
    /** A source id, 0 for none. */
    const id = (x: number) => (x === 0 ? null : x);
    const nv = m._smlib_num_vertices();
    const positions = f32(m._smlib_positions(), nv * 3);
    const normals = f32(m._smlib_normals(), nv * 3);
    const indices = u32(m._smlib_indices(), m._smlib_num_indices());
    const faceData = u32(m._smlib_faces(), m._smlib_num_faces() * 3);
    const faces: TessellationResult['faces'] = [];
    for (let i = 0; i < faceData.length; i += 3) {
      faces.push({ entityId: id(faceData[i]!), start: faceData[i + 1]!,
        count: faceData[i + 2]! });
    }
    const result: TessellationResult = { origin, positions, normals, indices, faces, diagnostics };
    const nm = req.measures ? m._smlib_num_measures() : 0;
    if (nm) {
      const at = m._smlib_measures() >>> 3;
      const q = m.HEAPF64.slice(at, at + 4 * nm);
      result.measures = [];
      for (let i = 0; i < q.length; i += 4) {
        result.measures.push({ entityId: q[i]!, area: q[i + 1]!, perimeter: q[i + 2]!, valid: q[i + 3] === 1 });
      }
    }
    // (With the measures, the area oracle's, on the model as given, whatever `scale` builds it at.)
    if (req.measures) result.oracle = oracleMeasures(req.data);
    if (req.edges) {
      const ne = m._smlib_num_edges();
      const edgeData = u32(m._smlib_edges(), ne * 4);
      const angles = f32(m._smlib_edge_angles(), ne);
      result.edgePositions = f32(m._smlib_edge_positions(), m._smlib_num_edge_points() * 3);
      result.edges = [];
      for (let i = 0; i < ne; i++) {
        const e: NonNullable<TessellationResult['edges']>[number] = {
          entityId: id(edgeData[i * 4]!), start: edgeData[i * 4 + 1]!,
          count: edgeData[i * 4 + 2]!, kind: KINDS[edgeData[i * 4 + 3]!]!,
        };
        if (angles[i]! >= 0) e.dihedral = angles[i]!;
        result.edges.push(e);
      }
    }
    const nc = m._smlib_num_curves();
    if (nc) {
      const curveData = u32(m._smlib_curves(), nc * 3);
      result.curvePositions = f32(m._smlib_curve_positions(), m._smlib_num_curve_points() * 3);
      result.curves = [];
      for (let i = 0; i < curveData.length; i += 3) {
        result.curves.push({ entityId: id(curveData[i]!), start: curveData[i + 1]!,
          count: curveData[i + 2]! });
      }
    }
    const np = m._smlib_num_points();
    if (np) {
      result.points = f32(m._smlib_points(), np * 3);
      result.pointIds = Array.from(u32(m._smlib_point_ids(), np), id);
    }
    m._smlib_free();
    // (The faces the builder left out among them: a face without triangles is a failure, whatever the cause, which
    // the builder's warnings say.)
    const failures = Number(diag.failures ?? 0) + Number(diag.leftOut ?? 0);
    if (failures) diagnostics.push({ severity: 'error', message: `${failures} faces failed to mesh` });
    if (diag.retried) {
      diagnostics.push({ severity: 'info', message: `${String(diag.retried)} faces meshed badly in their shells, `
        + `meshed again alone, unhealed, healed, with shorter edges or larger (${String(diag.improved)} `
        + 'better so)' });
    }
    if (diag.folded) {
      diagnostics.push({ severity: 'info', message: `${String(diag.folded)} triangles SMLib made twice or folded back `
        + 'on themselves removed' });
    }
    if (diag.unjoined) {
      diagnostics.push({ severity: 'error', message: `${String(diag.unjoined)} edges along which the meshes of the `
        + "faces they join don't meet: the mesh is open there" });
    }
    if (diag.tessError) diagnostics.push({ severity: 'warning', message: `SMLib: ${String(diag.tessError)}` });
    // (SMLib's own times, for corpus_checks/smlib_occt.ts.)
    if (globalThis.process?.env.SMLIB_TIMES) {
      diagnostics.push({ severity: 'info', message: `times ${String(diag.msBuild)} ${String(diag.msTessellate)} `
        + `${String(diag.msMeasures)}` });
    }
    return result;
  }

  memoryBytes(): number {
    return this.m?.HEAPU8.buffer.byteLength ?? 0;
  }

  dispose(): void {
    this.m = undefined;
  }
}
