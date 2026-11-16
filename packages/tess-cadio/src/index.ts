// tess-cadio's tessellator: our own (native/include/tess_cadio/part.h) behind cad-scene's Tessellator interface,
// the WebAssembly module (dist/tess_cadio.wasm, build.sh's `module`) loaded by `init`. It takes B-rep models
// (`cad-brep`) only, meshes every face whose surface cad-geom supports (planes, cylinders, spheres, B-splines) and
// reports the rest as faces that failed to mesh. Faces sharing an edge share its points exactly, so the result is
// closed wherever the model is. The module's C API is native/src/tess_cadio_api.cpp.

import type { EdgeKind, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo } from 'cad-scene';
import { sha256 } from 'cad-scene';

/** The module's C API version this layer speaks (tc_api_version). */
const API_VERSION = 1;
/** The workspace's version (package.json's; a test checks they agree). */
export const VERSION = '0.3.0';
/** result.h's Status, by code. */
const STATUS = ['ok', 'unsupported', 'outOfDomain', 'singular', 'noConvergence', 'invalidModel'];
/** tess_cadio_api.cpp's edge kinds, by code. */
const KINDS: EdgeKind[] = ['shared', 'seam', 'free'];

type Fn = (...args: number[]) => number;
/** The module's exports (tess_cadio_api.cpp's functions, each with a leading underscore). */
interface CadioExports {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  UTF8ToString(p: number): string;
  _malloc(n: number): number;
  _free(p: number): void;
  _tc_api_version: Fn;
  _tc_tessellate: Fn;
  _tc_num_vertices: Fn;
  _tc_positions: Fn;
  _tc_normals: Fn;
  _tc_num_indices: Fn;
  _tc_indices: Fn;
  _tc_num_faces: Fn;
  _tc_faces: Fn;
  _tc_num_edges: Fn;
  _tc_edges: Fn;
  _tc_edge_angles: Fn;
  _tc_num_edge_points: Fn;
  _tc_edge_positions: Fn;
  _tc_diag: Fn;
  _tc_free: Fn;
}

/** Emscripten's module factory: the default export of the JavaScript glue built with the module. */
export type CadioFactory = (moduleArg: {
  instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => object;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<unknown>;

export interface CadioInitOptions {
  /** The Emscripten glue: its factory (the .mjs's default export), or its URL. Default dist/tess_cadio.mjs. */
  glue?: CadioFactory | URL | string;
  /** The module: its bytes, its URL, or compiled (then `version` is required). Default dist/tess_cadio.wasm. */
  wasm?: BufferSource | URL | string | WebAssembly.Module;
  /** Names the build in `info.version` in place of the module's hash; required with a compiled module. */
  version?: string;
}

async function fetchBytes(url: URL): Promise<Uint8Array> {
  if (url.protocol === 'file:') return new Uint8Array(await (await import('node:fs/promises')).readFile(url));
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

const toBytes = (b: BufferSource): Uint8Array => b instanceof Uint8Array ? b
  : ArrayBuffer.isView(b) ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength) : new Uint8Array(b);

/** The faces that failed, as every backend says it (cad-scene's failedMessage: the ids, at most 10). */
function failedMessage(ids: readonly number[], rows: number): string {
  const named = ids.filter((i) => i !== 0);
  return `${rows} faces failed to mesh${named.length ? ': ' : ''}${named.slice(0, 10).map((i) => `#${i}`).join(', ')}`
    + (named.length > 10 ? ', ...' : '');
}

export class CadioTessellator implements Tessellator {
  readonly info: TessellatorInfo = {
    name: 'tess-cadio', version: VERSION, license: 'AGPL-3.0-only', formats: ['cad-brep'], supportsFaceIds: true,
    supportsEdges: true, supportsCurves: false,
  };
  private m: CadioExports | undefined;

  async init(opts: CadioInitOptions = {}): Promise<void> {
    const { glue, wasm, version } = opts;
    if (wasm instanceof WebAssembly.Module && version === undefined) throw new TypeError(
      'tess-cadio: init({wasm}) with a compiled WebAssembly.Module needs a version, since it has no bytes to hash');
    const glueUrl = glue === undefined ? new URL('../dist/tess_cadio.mjs', import.meta.url).href : String(glue);
    const factory = typeof glue === 'function' ? glue : (await import(glueUrl)).default as CadioFactory;
    let bytes: Uint8Array | undefined, module: WebAssembly.Module;
    if (wasm instanceof WebAssembly.Module) {
      module = wasm;
    } else {
      bytes = wasm !== undefined && typeof wasm !== 'string' && !(wasm instanceof URL) ? toBytes(wasm)
        : await fetchBytes(wasm === undefined ? new URL('../dist/tess_cadio.wasm', import.meta.url) : new URL(wasm));
      module = await WebAssembly.compile(bytes as BufferSource);
    }
    let fail!: (e: unknown) => void;
    const failed = new Promise<never>((_, reject) => (fail = reject));
    const m = (await Promise.race([factory({
      instantiateWasm: (imports, done) => {
        WebAssembly.instantiate(module, imports).then(done, fail);
        return {};
      },
      print: () => {},
      printErr: () => {},
    }), failed])) as CadioExports;
    if (typeof m._tc_api_version !== 'function' || m._tc_api_version() !== API_VERSION) {
      throw new Error(`tess-cadio: the module's API isn't version ${API_VERSION}: rebuild it (packages/tess-cadio/`
        + 'build.sh module), with its glue from the same build');
    }
    // (The module's first 6 bytes of SHA-256 as hex, as tess-smlib names its builds.)
    const id = version ?? (bytes ? Array.from((await sha256(bytes as BufferSource)).subarray(0, 6),
      (b) => b.toString(16).padStart(2, '0')).join('') : undefined);
    this.info.version = `${VERSION}${id ? `, wasm ${id}` : ''}`;
    this.m = m;
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    const m = this.m;
    if (!m) throw new Error('CadioTessellator: call init() first');
    if (req.format !== 'cad-brep') throw new Error(`CadioTessellator: format '${req.format}' isn't taken`);
    const origin = req.origin ?? [0, 0, 0];
    // (Pointers come back as signed 32-bit numbers: unsigned, as the module's memory may pass 2 GB.)
    const ptr = m._malloc(req.data.length) >>> 0;
    m.HEAPU8.set(req.data, ptr);
    let rc: number;
    try {
      rc = m._tc_tessellate(ptr, req.data.length, req.linearDeflection, req.angularDeflection, origin[0], origin[1],
        origin[2], req.edges ? 1 : 0);
    } finally {
      m._free(ptr);
    }
    const diag = JSON.parse(m.UTF8ToString(m._tc_diag() >>> 0)) as Record<string, unknown>;
    const diagnostics: TessellationResult['diagnostics'] = [];
    if (rc !== 0) {
      m._tc_free();
      diagnostics.push({ severity: 'error', message: `tess-cadio: ${String(diag.error)}` });
      return { origin, positions: new Float32Array(), indices: new Uint32Array(), faces: [], diagnostics };
    }
    const f32 = (p: number, n: number) => m.HEAPF32.slice((p >>> 0) >>> 2, ((p >>> 0) >>> 2) + n);
    const u32 = (p: number, n: number) => m.HEAPU32.slice((p >>> 0) >>> 2, ((p >>> 0) >>> 2) + n);
    const id = (x: number) => (x === 0 ? null : x);
    const nv = m._tc_num_vertices();
    const positions = f32(m._tc_positions(), nv * 3), normals = f32(m._tc_normals(), nv * 3);
    const indices = u32(m._tc_indices(), m._tc_num_indices());
    const fd = u32(m._tc_faces(), m._tc_num_faces() * 3);
    const faces: TessellationResult['faces'] = [];
    for (let i = 0; i < fd.length; i += 3) faces.push({ entityId: id(fd[i]!), start: fd[i + 1]!, count: fd[i + 2]! });
    const result: TessellationResult = { origin, positions, normals, indices, faces, diagnostics };
    if (req.edges) {
      const ne = m._tc_num_edges();
      const ed = u32(m._tc_edges(), ne * 4), angles = f32(m._tc_edge_angles(), ne);
      result.edgePositions = f32(m._tc_edge_positions(), m._tc_num_edge_points() * 3);
      result.edges = [];
      for (let i = 0; i < ne; i++) {
        const e: NonNullable<TessellationResult['edges']>[number] = { entityId: id(ed[4 * i]!), start: ed[4 * i + 1]!,
          count: ed[4 * i + 2]!, kind: KINDS[ed[4 * i + 3]!]! };
        if (angles[i]! >= 0) e.dihedral = angles[i]!;
        result.edges.push(e);
      }
    }
    m._tc_free();
    const list = (k: string) => (Array.isArray(diag[k]) ? diag[k] as number[] : []);
    const failedIds = list('failed');
    if (failedIds.length) {
      diagnostics.push({ severity: 'error', message: failedMessage(failedIds, failedIds.length) });
      // Why, per face: result.h's Status and the backend's cause (FaceMesh::cause).
      const by = new Map<string, number[]>(), st = list('failedStatus');
      const causes = Array.isArray(diag.failedCause) ? diag.failedCause as string[] : [];
      failedIds.forEach((id, i) => {
        const k = `${STATUS[st[i] ?? -1] ?? 'unknown'}: ${causes[i] ?? 'cause not given'}`;
        by.set(k, [...(by.get(k) ?? []), id]);
      });
      diagnostics.push({ severity: 'info', message: 'faces failed to mesh, by cause: ' + [...by].map(([k, ids]) =>
        `${k} ${ids.length} (${ids.map((i) => `#${i}`).join(', ')})`)
        .join('; ') });
    }
    const note = (k: string, what: string) => {
      const ids = list(k);
      if (ids.length) diagnostics.push({ severity: 'warning', message: `${ids.length} faces ${what}` });
    };
    const refused = list('refused');
    if (refused.length) {
      diagnostics.push({ severity: 'warning', message: `${refused.length} faces meshed with triangles their criteria `
        + `still refuse: ${Number(diag.refusedTriangles)} triangles, ${Number(diag.poleSlivers)} of them slivers in a `
        + 'pole\'s fan' });
    }
    note('unsplit', 'still wanting their edges split when the rounds ran out');
    const sampled = list('sampled');
    if (sampled.length) {
      diagnostics.push({ severity: 'info', message: `${sampled.length} faces meshed with their deviation from the `
        + 'surface sampled, not bounded (their surfaces\' derivative bounds not yet tight)' });
    }
    note('unsettled', 'with a seam whose side in (u, v) their neighbours didn\'t settle');
    const against = list('againstSense');
    if (against.length) {
      diagnostics.push({ severity: 'warning', message: `${against.length} faces with a loop against the face's sense `
        + '(a seam use\'s side by the face\'s sense contradicts its loop), meshed as the face\'s sense has it: faces '
        + `${against.slice(0, 10).join(', ')}${against.length > 10 ? ', ...' : ''}` });
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
