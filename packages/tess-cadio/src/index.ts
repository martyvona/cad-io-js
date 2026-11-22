// tess-cadio's tessellator: our own (native/include/tess_cadio/part.h) behind cad-scene's Tessellator interface,
// the WebAssembly module (dist/tess_cadio.wasm, build.sh's `module`) loaded by `init`. It takes B-rep models
// (`cad-brep`) only, meshes every face whose surface cad-geom supports (planes, cylinders, spheres, B-splines) and
// reports the rest as faces that failed to mesh. Faces sharing an edge share its points exactly, so the result is
// closed wherever the model is. The module's C API is native/src/tess_cadio_api.cpp.

import type { EdgeKind, TessellationProgress, TessellationRequest, TessellationResult, Tessellator, TessellatorInfo }
  from 'cad-scene';
import { sha256 } from 'cad-scene';
import { CAUSES_HEAD } from './causes.ts';

/** The module's C API version this layer speaks (tc_api_version). */
const API_VERSION = 9;

/**
 * With countInsertions, an info diagnostic of this head then `<kind> <n>` for each of INSERTED_KINDS inserted, joined
 * by ", ": the meshed faces' Steiner points by what queued the triangle each broke (part.h's FaceMesh::inserted).
 */
export const INSERTED_HEAD = 'points inserted, by what queued their triangle: ';
export const INSERTED_KINDS = ['size', 'thinness', 'refused (no kind)', 'deviation in closed form', 'deviation sampled',
  'deviation bounded', 'deviation near a pole', 'a normal against the facet', 'normals apart', 'refused (other kind)'];
/**
 * With countRounds, an info diagnostic of this head then the part's rounds of splitting edges and meshing their faces
 * again (part.h's PartMesher::rounds; PartOptions::maxSplitRounds the most).
 */
export const ROUNDS_HEAD = 'split rounds: ';
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
      case 'edges': {
        const on = row >= 0 ? `a use on ${face}` : 'an edge';
        return onProgress({ message: `sampling edges: ${on}, ${done} of ${total} edges and uses done`,
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
const PHASES = ['surfaces', 'edges', 'criteria', 'meshing', 'splitting', 'deviation'] as const;

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
  _tc_set_count_insertions: Fn;
  _tc_set_count_angles: Fn;
  _tc_set_fail_capped: Fn;
  _tc_set_fail_turned_over: Fn;
  _tc_set_analysis: Fn;
  _tc_set_max_points: Fn;
  _tc_set_min_angle: Fn;
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
   * surface), going the failed faces' way (a fallback, where configured); default 1, 0 never.
   */
  maxDeviationFactor?: number;
  /**
   * Count the mesher's insertions by what queued them, said in an info diagnostic (INSERTED_HEAD; part.h's
   * PartOptions::countInsertions): the same mesh, up to 2 x the time; default false.
   */
  countInsertions?: boolean;
  /**
   * Count each face's triangles whose smallest angle in the metric is under minAngle (part.h's
   * PartOptions::countAngles): an info diagnostic of their totals, the per-face rows in the module's diagnostics
   * (tc_diag's "thin"); the same mesh; default false.
   */
  countAngles?: boolean;
  /** Say the part's split rounds in an info diagnostic (ROUNDS_HEAD); the same mesh; default false. */
  countRounds?: boolean;
  /**
   * Fail a face whose refinement reached its point cap (part.h's PartOptions::failCapped), and one with a triangle
   * turned against its surface (failTurnedOver); default true each. False keeps them as meshed, for measuring.
   */
  failCapped?: boolean;
  failTurnedOver?: boolean;
  /**
   * Steiner points per face at most (part.h's PartOptions::maxPointsPerFace; default 100,000): a refinement that
   * reaches it stops there, the mesh kept and said. For tests and tuning.
   */
  maxPointsPerFace?: number;
  /**
   * The smallest angle refinement aims for in each face's triangles, in radians (part.h's PartOptions::minAngle;
   * default 10 degrees, pi / 18; at most 30 degrees, more clamped; 0 none): the triangles' shape, which neither
   * deflection asks for. A request's minAngle (TessellationRequest) takes its place for that request.
   */
  minAngle?: number;
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
  private deviationFactor = 1;
  private countInsertions = false;
  private countAngles = false;
  private countRounds = false;
  private failCapped = true;
  private failTurnedOver = true;
  private maxPoints = 0;
  private minAngle = -1;
  readonly info: TessellatorInfo = {
    name: 'tess-cadio', version: VERSION, license: 'AGPL-3.0-only', formats: ['cad-brep'], supportsFaceIds: true,
    supportsEdges: true, supportsCurves: false, readsAnalysis: true,
  };
  private m: CadioExports | undefined;

  async init(opts: CadioInitOptions = {}): Promise<void> {
    const { glue, wasm, version } = opts;
    this.project = opts.projectMissingPcurves ?? true;
    this.deviationFactor = opts.maxDeviationFactor ?? 1;
    this.countInsertions = opts.countInsertions ?? false;
    this.countAngles = opts.countAngles ?? false;
    this.countRounds = opts.countRounds ?? false;
    this.failCapped = opts.failCapped ?? true;
    this.failTurnedOver = opts.failTurnedOver ?? true;
    this.maxPoints = opts.maxPointsPerFace ?? 0;
    this.minAngle = opts.minAngle ?? -1;
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
    // (The part's analysis where healing gave one: its healed p-curves placed as projected, faces through edges or
    // vertices past repair failed. malloc's blocks are 8-byte aligned, as the analysis's columns need.)
    const an = req.analysis?.length ? m._malloc(req.analysis.length) >>> 0 : 0;
    if (an) m.HEAPU8.set(req.analysis!, an);
    m._tc_set_analysis(an, an ? req.analysis!.length : 0);
    let rc: number;
    m.tcProgress = onProgress ? progressReporter(onProgress) : undefined;
    m._tc_set_project(this.project ? 1 : 0);
    m._tc_set_deviation_factor(this.deviationFactor);
    m._tc_set_count_insertions(this.countInsertions ? 1 : 0);
    m._tc_set_count_angles(this.countAngles ? 1 : 0);
    m._tc_set_fail_capped(this.failCapped ? 1 : 0);
    m._tc_set_fail_turned_over(this.failTurnedOver ? 1 : 0);
    m._tc_set_max_points(this.maxPoints);
    // (A request's own minAngle first: cad-scene's TessellationRequest; else init's.)
    m._tc_set_min_angle(req.minAngle ?? this.minAngle);
    try {
      rc = m._tc_tessellate(ptr, req.data.length, req.linearDeflection, req.angularDeflection, origin[0], origin[1],
        origin[2], req.edges ? 1 : 0);
    } finally {
      m._free(ptr);
      if (an) m._free(an);
      m._tc_set_analysis(0, 0);
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
      diagnostics.push({ severity: 'info', message: CAUSES_HEAD + [...by].map(([k, ids]) =>
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
    const inserted = list('inserted');
    if (this.countInsertions && inserted.length === INSERTED_KINDS.length) {
      diagnostics.push({ severity: 'info', message: INSERTED_HEAD + INSERTED_KINDS.map((k, i) => `${k} ${inserted[i]}`)
        .join(', ') });
    }
    // (Per face, 11 numbers: id, count, 6 bins by angle, boundary, frozen, floor.)
    const thin = list('thin'), thinArea = list('thinArea');
    if (this.countAngles && thin.length) {
      const sum = (k: number) => thin.filter((_, i) => i % 11 === k).reduce((a, x) => a + x, 0);
      const bins = ['under 1', '1-2', '2-5', '5-8', '8-10', '10 and up'].map((b, k) => `${b} ${sum(2 + k)}`).join(', ');
      diagnostics.push({ severity: 'info', message: `${thin.length / 11} faces with triangles under the minimum angle: `
        + `${sum(1)} triangles (by degrees: ${bins}), ${+thinArea.reduce((a, x) => a + x, 0).toPrecision(4)} mm^2; `
        + `every corner on the boundary ${sum(8)}, an edge frozen ${sum(9)}, within the floor ${sum(10)}` });
    }
    note('unsplit', 'still wanting their edges split when the rounds ran out');
    if (this.countRounds && typeof diag.rounds === 'number') {
      diagnostics.push({ severity: 'info', message: `${ROUNDS_HEAD}${diag.rounds}` });
    }
    // (Faces whose refinement asked for a pole ring's segment to be split, which a ring's never is: their triangles
    // there refused for good. With the rounds it asked in.)
    const blocked = list('ringBlocked'), blockedRounds = list('ringBlockedRounds');
    if (blocked.length) {
      diagnostics.push({ severity: 'warning', message: `${blocked.length} faces with refinement blocked by a fixed `
        + `ring segment: ${blocked.map((id, i) => `#${id} (${blockedRounds[i]} rounds)`).join(', ')}` });
    }
    const sampled = list('sampled');
    if (sampled.length) {
      diagnostics.push({ severity: 'info', message: `${sampled.length} faces meshed with their deviation from the `
        + 'surface sampled, not bounded (their surfaces\' derivative bounds not yet tight)' });
    }
    note('unsettled', 'with a seam whose side in (u, v) their neighbours didn\'t settle');
    note('capped', 'failed with refinement stopped at their point cap');
    // The uses without p-curves, by how they were sampled: [within 0.05 x the deflection, at the edge's tolerance,
    // by inversion]; said where any fell back from the first.
    const pc = list('projections');
    if (pc.length === 3 && pc[1]! + pc[2]! > 0) {
      diagnostics.push({ severity: 'info', message: `${pc[0]! + pc[1]! + pc[2]!} uses without p-curves: ${pc[0]} `
        + `projected within 0.05 x the deflection, ${pc[1]} at the edge's tolerance (the curve farther off its `
        + `surface), ${pc[2]} by inversion (no projection ok)` });
    }
    // The local steps of uses traced sample by sample that fell back on the global search (edges.h's TraceFallback):
    // said with the first few, [edge id, t, distance, why].
    const fallbacks = Array.isArray(diag['traceFallbacks']) ? diag['traceFallbacks'] as [number, number, number,
      string][] : [];
    if (fallbacks.length) {
      const tr = list('traces');
      const shown = fallbacks.slice(0, 5).map(([e, t, d, why]) => `edge ${e} at ${t} (${d} off): ${why}`).join('; ');
      diagnostics.push({ severity: 'info', message: `${fallbacks.length} samples of uses traced sample by sample fell `
        + `back on the global search (${tr[0] ?? 0} traced locally): ${shown}${fallbacks.length > 5 ? '; ...' : ''}` });
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
