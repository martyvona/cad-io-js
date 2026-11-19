// tess-cadio's tessellator: our own (native/include/tess_cadio/part.h) behind cad-scene's Tessellator interface,
// the WebAssembly module (dist/tess_cadio.wasm, build.sh's `module`) loaded by `init`. It takes B-rep models
// (`cad-brep`) only, meshes every face whose surface cad-geom supports (planes, cylinders, spheres, B-splines) and
// reports the rest as faces that failed to mesh. Faces sharing an edge share its points exactly, so the result is
// closed wherever the model is. The module's C API is native/src/tess_cadio_api.cpp.

import type { EdgeKind, TessellationProgress, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo }
  from 'cad-scene';
import { sha256 } from 'cad-scene';

/** The module's C API version this layer speaks (tc_api_version). */
const API_VERSION = 3;
/** The workspace's version (package.json's; a test checks they agree). */
export const VERSION = '0.3.0';
/** result.h's Status, by code. */
const STATUS = ['ok', 'unsupported', 'outOfDomain', 'singular', 'noConvergence', 'invalidModel'];
/** tess_cadio_api.cpp's edge kinds, by code. */
const KINDS: EdgeKind[] = ['shared', 'seam', 'free'];

type Fn = (...args: number[]) => number;
/**
 * The backend's progress (part.h's PartProgress: its phase, and each face as its meshing starts and as a long one
 * goes) to `onProgress`, at most one report every `everyMs` (a part of 60,000 faces would otherwise post as many
 * messages): a face's own repeats as it goes report it once it has run that long, so a timeout names the face it
 * stopped in.
 */
export function progressReporter(onProgress: (p: TessellationProgress) => void, everyMs = 100,
  now: () => number = () => performance.now()): ProgressHook {
  let last = -Infinity;
  return (phase, id, row, round, done, total) => {
    const t = now();
    if (t - last < everyMs) return;
    last = t;
    const faceId = id === 0 ? null : id;
    const face = `${faceId === null ? 'a face with no id' : `face #${faceId}`} (row ${row})`;
    const pass = round ? `split round ${round}` : 'first pass';
    const faces = { faceId, row, round, facesDone: done, facesTotal: total };
    switch (PHASES[phase]) {
      case 'surfaces': return onProgress({ message: `making surfaces: ${face}, ${done} of ${total} done`, ...faces });
      case 'boxEdges': case 'edges': {
        const what = PHASES[phase] === 'edges' ? 'sampling edges' : 'sampling edges for the faces\' boxes';
        const on = row >= 0 ? `a use on ${face}` : 'an edge';
        return onProgress({ message: `${what}: ${on}, ${done} of ${total} edges and uses done`,
          ...(row >= 0 ? { faceId, row } : {}), round });
      }
      case 'criteria': return onProgress({ message: `criteria: ${face}, ${done} of ${total} done`, ...faces });
      case 'splitting': return onProgress({ message: `${pass}: splitting ${total} edge spans`, round });
      case 'deviation': return onProgress({ message: `checking meshes' deviation: ${face}, ${done} of ${total} faces `
        + 'done', ...faces });
      default: return onProgress({ message: `${face}, ${pass}, ${done} of ${total} faces done`, ...faces });
    }
  };
}

/** tess_cadio_api.cpp's js_progress: PartProgress's phase (PHASES), the face's id and row, round, done, total. */
type ProgressHook = (phase: number, id: number, row: number, round: number, done: number, total: number) => void;
/** part.h's PartProgress::Phase, in order. */
const PHASES = ['surfaces', 'boxEdges', 'criteria', 'edges', 'meshing', 'splitting', 'deviation'] as const;

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
  _tc_set_project: Fn;
  _tc_set_deviation_factor: Fn;
  /** Set for a call: tess_cadio_api.cpp's progress (js_progress, progressReporter's). */
  tcProgress?: ProgressHook;
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
  /**
   * Uses without p-curves given one projected from their edge's 3D curve (part.h's PartOptions::projectMissingPcurves;
   * default true), else placed by inversion: for comparing the two, and tests.
   */
  projectMissingPcurves?: boolean;
  /**
   * A face whose mesh is farther from its surface than this times the larger of the linear deflection and the face's
   * tolerance fails (part.h's PartOptions::maxDeviationFactor: its refused triangles' points inverted onto its
   * surface), going the failed faces' way (a fallback, where configured); default 1.1, 0 never.
   */
  maxDeviationFactor?: number;
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
  private project = true;
  private deviationFactor = 1.1;
  readonly info: TessellatorInfo = {
    name: 'tess-cadio', version: VERSION, license: 'AGPL-3.0-only', formats: ['cad-brep'], supportsFaceIds: true,
    supportsEdges: true, supportsCurves: false,
  };
  private m: CadioExports | undefined;

  async init(opts: CadioInitOptions = {}): Promise<void> {
    const { glue, wasm, version } = opts;
    this.project = opts.projectMissingPcurves ?? true;
    this.deviationFactor = opts.maxDeviationFactor ?? 1.1;
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

  async tessellate(req: TessellationRequest, onProgress?: (p: TessellationProgress) => void):
    Promise<TessellationResult> {
    const m = this.m;
    if (!m) throw new Error('CadioTessellator: call init() first');
    if (req.format !== 'cad-brep') throw new Error(`CadioTessellator: format '${req.format}' isn't taken`);
    const origin = req.origin ?? [0, 0, 0];
    // (Pointers come back as signed 32-bit numbers: unsigned, as the module's memory may pass 2 GB.)
    const ptr = m._malloc(req.data.length) >>> 0;
    m.HEAPU8.set(req.data, ptr);
    let rc: number;
    m.tcProgress = onProgress ? progressReporter(onProgress) : undefined;
    m._tc_set_project(this.project ? 1 : 0);
    m._tc_set_deviation_factor(this.deviationFactor);
    try {
      rc = m._tc_tessellate(ptr, req.data.length, req.linearDeflection, req.angularDeflection, origin[0], origin[1],
        origin[2], req.edges ? 1 : 0);
    } finally {
      m._free(ptr);
      m.tcProgress = undefined;
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
      // (By why, criteria.h's Refusal in order: [0] unused.)
      const by = list('refusedBy');
      const why = ['', 'deviation in closed form', 'deviation sampled', 'deviation bounded', 'deviation near a pole',
        'a normal against the facet', 'normals apart'];
      const reasons = why.map((w, k) => (k && by[k] ? `${w} ${by[k]}` : '')).filter(Boolean).join(', ');
      diagnostics.push({ severity: 'warning', message: `${refused.length} faces meshed with triangles their criteria `
        + `still refuse: ${Number(diag.refusedTriangles)} triangles, ${Number(diag.poleSlivers)} of them slivers in a `
        + `pole's fan${reasons ? `; by why: ${reasons}` : ''}` });
    }
    note('unsplit', 'still wanting their edges split when the rounds ran out');
    const sampled = list('sampled');
    if (sampled.length) {
      diagnostics.push({ severity: 'info', message: `${sampled.length} faces meshed with their deviation from the `
        + 'surface sampled, not bounded (their surfaces\' derivative bounds not yet tight)' });
    }
    note('unsettled', 'with a seam whose side in (u, v) their neighbours didn\'t settle');
    // The uses without p-curves, by how they were sampled: [within 0.05 x the deflection, at the edge's tolerance,
    // by inversion]; said where any fell back from the first.
    const pc = list('projections');
    if (pc.length === 3 && pc[1]! + pc[2]! > 0) {
      diagnostics.push({ severity: 'info', message: `${pc[0]! + pc[1]! + pc[2]!} uses without p-curves: ${pc[0]} `
        + `projected within 0.05 x the deflection, ${pc[1]} at the edge's tolerance (the curve farther off its `
        + `surface), ${pc[2]} by inversion (no projection ok)` });
    }
    const folded = list('folded');
    if (folded.length) {
      const folds = typeof diag['folds'] === 'number' ? diag['folds'] : 0;
      diagnostics.push({ severity: 'info', message: `${folds} boundary folds repaired in ${folded.length} faces`
        + ' (a point convex in (u, v) turning the other way in 3D, its (u, v) moved onto its '
        + 'neighbours\' chord within the face\'s tolerance)' });
    }
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
