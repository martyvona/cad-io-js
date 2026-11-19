// cad-geom's TypeScript layer: the WebAssembly module (dist/cad_geom.wasm, build.sh's `module`) loaded by `init`, and
// a Geometry per B-rep model buffer (cad-brep's format) answering curve and surface queries in batches, results in
// typed arrays. The module's C API is native/src/cad_geom_api.cpp; the queries' meanings are the contracts'
// (native/include/cad_geom/curve.h, surface.h). A row whose curve or surface can't be made isn't an error: every
// result says so in `status` (makeCurve's), with nothing else in it. Per-item statuses and certainties are codes, the
// indices of STATUS and CERTAINTY.

/** result.h's Status, by code. */
export const STATUS = ['ok', 'unsupported', 'outOfDomain', 'singular', 'noConvergence', 'invalidModel'] as const;
export type Status = (typeof STATUS)[number];
/** result.h's Certainty, by code. */
export const CERTAINTY = ['unique', 'ambiguous', 'none'] as const;
export type Certainty = (typeof CERTAINTY)[number];
/** surface.h's Singularity kinds, by code. */
export const SINGULARITY = ['pole', 'apex', 'normalVanishes'] as const;
/** project.h's PcurveMethod, by code. */
export const PCURVE_METHOD = ['none', 'planeAffine', 'isoLine', 'affineFeet', 'traced'] as const;
/** Why a trace stopped short (project.h's StopWhy). */
export const STOP_WHY = ['none', 'noConvergence', 'jump', 'poleLine', 'degenerate', 'fold'] as const;
export type StopWhy = (typeof STOP_WHY)[number];
export type PcurveMethod = (typeof PCURVE_METHOD)[number];

/** The module's C API version this layer speaks (cg_api_version). */
const API_VERSION = 2;

type Fn = (...args: number[]) => number;
interface GeomExports {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  _malloc(n: number): number;
  _free(p: number): void;
  [name: `_cg_${string}`]: Fn;
}

/** Emscripten's module factory: the default export of the JavaScript glue built with the module. */
export type GeomFactory = (moduleArg: {
  instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => object;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<unknown>;

/** Where `init` gets its module; the glue and the module must come from the same build. */
export interface GeomInitOptions {
  /** The Emscripten glue: its factory (the .mjs's default export), or its URL. Default dist/cad_geom.mjs. */
  glue?: GeomFactory | URL | string;
  /** The module: its bytes, its URL, or compiled. Default dist/cad_geom.wasm. */
  wasm?: BufferSource | URL | string | WebAssembly.Module;
}

/** A loaded module: pass it to Geometry (one module serves any number of models). */
export interface GeomModule {
  readonly exports: GeomExports;
}

async function fetchBytes(url: URL): Promise<BufferSource> {
  if (url.protocol === 'file:') return (await import('node:fs/promises')).readFile(url);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

let defaultModule: Promise<GeomModule> | undefined;

/**
 * Loads the module: a host's glue and wasm (a bundler's URLs, bytes, a compiled module), or the package's dist/ by
 * default, that one loaded once and shared.
 */
export function init(opts?: GeomInitOptions): Promise<GeomModule> {
  if (opts === undefined || (opts.glue === undefined && opts.wasm === undefined)) {
    return defaultModule ??= load({}).catch((e) => {
      defaultModule = undefined;
      throw e;
    });
  }
  return load(opts);
}

async function load(opts: GeomInitOptions): Promise<GeomModule> {
  const { glue, wasm } = opts;
  const glueUrl = glue === undefined ? new URL('../dist/cad_geom.mjs', import.meta.url).href : String(glue);
  const factory = typeof glue === 'function' ? glue : (await import(glueUrl)).default as GeomFactory;
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(
    wasm !== undefined && typeof wasm !== 'string' && !(wasm instanceof URL) ? wasm
      : await fetchBytes(wasm === undefined ? new URL('../dist/cad_geom.wasm', import.meta.url) : new URL(wasm)));
  let fail!: (e: unknown) => void;
  const failed = new Promise<never>((_, reject) => (fail = reject));
  const exports = (await Promise.race([factory({
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(module, imports).then(done, fail);
      return {};
    },
    print: () => {},
    printErr: () => {},
  }), failed])) as GeomExports;
  const version = exports._cg_api_version;
  if (typeof version !== 'function' || version() !== API_VERSION) {
    throw new Error(`cad-geom: the module's API isn't version ${API_VERSION}: rebuild it (packages/cad-geom/build.sh `
      + 'module), with its glue from the same build');
  }
  return { exports };
}

/** Item counts and per-item statuses common to every batch result. */
export interface Batch {
  /** 'ok', or why the row's curve or surface couldn't be made (then the arrays are empty). */
  status: Status;
  /** Per item: a STATUS code. */
  statuses: Uint8Array;
}

export interface CurveInfo {
  status: Status;
  dim: number;
  /** The natural range; infinite ends as infinities. */
  lo: number;
  hi: number;
  /** 0 where not periodic. */
  period: number;
}

export interface CurveEvals extends Batch {
  /** Per parameter, (order + 1) vectors of 3: the point, then derivatives (2D curves with z = 0). */
  values: Float64Array;
}

export interface Boxes extends Batch {
  /** Per range: x lo, x hi, y lo, y hi, z lo, z hi. */
  boxes: Float64Array;
}

export interface Bounds extends Batch {
  /** Per range: the bound (curves), or order + 1 of 3 (surfaces: |S_u|, |S_v| or |S_uu|, |S_uv|, |S_vv|). */
  bounds: Float64Array;
}

export interface Inversions extends Batch {
  /** Per point: the parameter (curves: 1 each; surfaces: u, v). */
  params: Float64Array;
  distance: Float64Array;
  /** Per point, 3: the foot. */
  foot: Float64Array;
  /** Per point: a CERTAINTY code. */
  certainty: Uint8Array;
  /** Per point: how many alternatives; they are in `alternatives`, point by point (surfaces' as u, v pairs). */
  alternativeCount: Int32Array;
  alternatives: Float64Array;
  /** Curves: 1 where on the seam. Surfaces: 1 onSeamU, 2 onSeamV, 4 atSingularity. */
  flags: Uint8Array;
}

export interface Estimates extends Batch {
  value: Float64Array;
  error: Float64Array;
}

export interface SurfaceInfo {
  status: Status;
  u: [number, number];
  v: [number, number];
  uPeriod: number;
  vPeriod: number;
}

export interface SurfaceEvals extends Batch {
  /** Per (u, v): the point, then (order >= 1) S_u, S_v, then (order 2) S_uu, S_uv, S_vv, 3 each. */
  values: Float64Array;
}

export interface Singularity {
  kind: (typeof SINGULARITY)[number];
  isoU: boolean;
  at: number;
  point: [number, number, number];
}

/** geom2d.h's Side, by code. */
export const SIDE = ['in', 'out', 'on'] as const;
/**
 * A face's status: a STATUS, or the face's own (cad_geom_api.cpp): a coedge without a p-curve and none projected (no
 * 3D curve, or projection off), one whose range is neither given nor derivable, one whose derived range's ends are
 * off its vertices, one whose projection's status isn't ok.
 */
export type FaceStatus = Status | 'noPcurve' | 'noPcurveRange' | 'pcurveRangeOff' | 'pcurveProjectionFailed';
const FACE_STATUS = ['noPcurve', 'noPcurveRange', 'pcurveRangeOff', 'pcurveProjectionFailed'] as const;
function faceStatus(code: number): FaceStatus {
  return code >= 100 ? FACE_STATUS[code - 100]! : STATUS[code]!;
}

export interface FaceInfo {
  status: FaceStatus;
  /** The 3D tolerance its (u, v) ones come from. */
  tolerance: number;
  uPeriod: number;
  vPeriod: number;
  /** Its edge loops (vertex loops aside). */
  loops: number;
  /** Its pole lines: u = at (isoU) or v = at. */
  poles: { isoU: boolean; at: number }[];
  /** Its coedges whose p-curve range is the p-curve's own, its curve's parameters missing its vertices. */
  ownRanges: number;
  /** Its coedges without a p-curve, their edges' curves projected. */
  projected: number;
}

/** One piece of a p-curve (project.h's PcurvePiece): a 2D curve over t, or a jump along a pole line. */
export interface PcurvePiece {
  t: [number, number];
  /**
   * The curve in the model's form (cad-brep's CURVE_LAYOUTS, dim 2): its kind, reals and ints; kind 0 where it has
   * none, the 3D curve's image by a plane's map `affine` (u = affine[0..2] . (P - o), v = affine[3..5] . (P - o),
   * o = affine[6..8]).
   */
  kind: number;
  reals: Float64Array;
  ints: Int32Array;
  affine: Float64Array;
  /** A jump along a pole line at t[0] == t[1], from `from` to `to`, with no curve. */
  poleLine: boolean;
  from: [number, number];
  to: [number, number];
  certainty: Certainty;
  /** The largest 3D distance from the surface at the piece to the curve (mm, measured between samples too). */
  error: number;
}

/** localFoot's results, per point (Geometry.localFoot). */
export interface LocalFeet {
  status: Status;
  uv: Float64Array;
  point: Float64Array;
  distance: Float64Array;
  /** A STATUS code each. */
  statuses: Uint8Array;
  side: Int32Array;
}

export const END_FOOT_KIND = ['point', 'seamPair', 'pole'] as const;

/** A foot of a vertex on a face (project.h's EndFoot). */
export interface EndFoot {
  /** point: one (u, v); seamPair: on a seam, `twin` the other side's copy; pole: its free coordinate any in `free`. */
  kind: (typeof END_FOOT_KIND)[number];
  uv: [number, number];
  twin: [number, number];
  /** A pole's free coordinate is u (else v), over `free`. */
  poleU: boolean;
  free: [number, number];
  distance: number;
  /** unique: the only foot within tol of the nearest. */
  certainty: Certainty;
}

/** A projection (project.h's Pcurve): its status ok promises error <= tol. */
export interface Pcurve {
  status: Status;
  method: PcurveMethod;
  certainty: Certainty;
  /** On a seam: `seamTwin` is the other side's copy, a period up. */
  seamU: boolean;
  seamV: boolean;
  /**
   * The largest distance from the curve to the surface (mm, measured; where a span's control hull leaves the surface's
   * box, at least the farthest point's distance from that box).
   */
  offSurface: number;
  /** Where offSurface came from the hulls: the curve's span (between two breaks) holding it; else NaN, NaN. */
  offSpan: [number, number];
  /**
   * The trace stopped short: at stopAt, its last foot stopDistance from the curve, for stopWhy (project.h's StopWhy).
   * No pieces then; offSurface covers the feet it had (a lower bound).
   */
  stopped: boolean;
  stopAt: number;
  stopDistance: number;
  stopWhy: StopWhy;
  error: number;
  tAmbiguous: Float64Array;
  pieces: PcurvePiece[];
  seamTwin: PcurvePiece[];
  /** projectCoedge: the coedge's use takes `seamTwin`. */
  takesTwin: boolean;
  /** The curve's parameters at the start and end (projectCoedge: its edge's start and end). */
  range: [number, number];
  /** Per sample parameter asked: (u, v) of `pieces` (NaN where none covers it), and of `seamTwin` where on a seam. */
  uv: Float64Array;
  twinUv: Float64Array;
}

/** The scratch's projection (cad_geom_api.cpp) with n samples. */
function readPcurve(v: Float64Array, n: number): Pcurve {
  let at = 19;
  const tAmbiguous = v.slice(at, at + v[7]!);
  at += v[7]!;
  const read = (count: number) => {
    const out: PcurvePiece[] = [];
    for (let i = 0; i < count; i++) {
      const o = v.subarray(at, at + 21), nr = o[10]!, ni = o[11]!;
      at += 21;
      const reals = v.slice(at, at + nr);
      at += nr;
      const ints = Int32Array.from(v.subarray(at, at + ni));
      at += ni;
      out.push({ t: [o[0]!, o[1]!], kind: o[2]!, reals, ints, affine: o.slice(12, 21), poleLine: o[3] === 1,
        from: [o[4]!, o[5]!], to: [o[6]!, o[7]!], certainty: CERTAINTY[o[8]!]!, error: o[9]! });
    }
    return out;
  };
  const pieces = read(v[8]!), seamTwin = read(v[9]!);
  const uv = v.slice(at, at + 2 * n);
  at += 2 * n;
  return { status: STATUS[v[0]!]!, method: PCURVE_METHOD[v[1]!]!, certainty: CERTAINTY[v[2]!]!, seamU: v[3] === 1,
    seamV: v[4] === 1, offSurface: v[5]!, error: v[6]!, tAmbiguous, pieces, seamTwin, takesTwin: v[10] === 1,
    range: [v[11]!, v[12]!], offSpan: [v[13]!, v[14]!], stopped: v[15] === 1, stopAt: v[16]!, stopDistance: v[17]!,
    stopWhy: STOP_WHY[v[18]!]!, uv,
    twinUv: seamTwin.length ? v.slice(at, at + 2 * n) : new Float64Array() };
}

export interface ProjectOptions {
  /** (u, v) the p-curve must start or end at (a period's difference is unwrapped; a pole's free parameter). */
  start?: [number, number];
  end?: [number, number];
  /** Parameters to give the p-curve's (u, v) at (`uv`, `twinUv`). */
  samples?: ArrayLike<number>;
}

export interface FaceSides {
  status: FaceStatus;
  /** Per point: a SIDE code. */
  sides: Uint8Array;
  statuses: Uint8Array;
  /** Per point: the (u, v) tolerance it was classified at. */
  tolerance: Float64Array;
}

export interface FaceSelf {
  status: FaceStatus;
  /** selfIntersect2's status. */
  self: Status;
  crossings: number;
  touches: number;
  overlaps: number;
  points: { ta: number; tb: number; u: number; v: number; tangent: boolean }[];
}

/** An argument of a call: input numbers copied in, or an output of a type and size allocated for it. */
type In = { f64: ArrayLike<number> };
type Out = { out: 'f64' | 'u8' | 'i32'; n: number };
type Arg = number | In | Out;

/**
 * The queries on one model's buffer, copied into the module once. `dispose` frees it (the module's memory isn't
 * collected with the object).
 */
export class Geometry {
  readonly curves: number;
  readonly surfaces: number;
  private readonly x: GeomExports;
  private handle: number;

  constructor(module: GeomModule, buffer: ArrayBuffer | ArrayBufferView) {
    this.x = module.exports;
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const p = this.x._malloc(Math.max(1, bytes.length));
    this.x.HEAPU8.set(bytes, p);
    // The model owns the copy from here, freeing it if it isn't a model.
    this.handle = this.fn('model_new')(p, bytes.length);
    if (this.handle < 0) throw new TypeError('cad-geom: not a B-rep buffer (cad-brep\'s format)');
    this.curves = this.fn('model_curves')(this.handle);
    this.surfaces = this.fn('model_surfaces')(this.handle);
  }

  /** A Geometry on the default module (init()). */
  static async open(buffer: ArrayBuffer | ArrayBufferView): Promise<Geometry> {
    return new Geometry(await init(), buffer);
  }

  dispose(): void {
    if (this.handle >= 0) this.fn('model_free')(this.handle);
    this.handle = -1;
  }
  [Symbol.dispose](): void {
    this.dispose();
  }

  // -- Curves.

  curveInfo(row: number): CurveInfo {
    const [s, out] = this.call('curve_info', row, { out: 'f64', n: 4 });
    const o = out as Float64Array;
    return { status: STATUS[s]!, dim: o[0]!, lo: o[1]!, hi: o[2]!, period: o[3]! };
  }

  /** C(t) and its derivatives to `order` at each parameter. */
  evalCurve(row: number, t: ArrayLike<number>, order: 0 | 1 | 2 = 1): CurveEvals {
    const n = t.length;
    const [s, values, statuses] = this.call('curve_eval', row, { f64: t }, n, order,
      { out: 'f64', n: n * 3 * (order + 1) }, { out: 'u8', n });
    return { status: STATUS[s]!, values: values as Float64Array, statuses: statuses as Uint8Array };
  }

  /** The breaks in [lo, hi] (r's ends included), or empty with the status where there's no curve. */
  curveBreaks(row: number, lo: number, hi: number): { status: Status; breaks: Float64Array } {
    return this.list('curve_breaks', row, lo, hi);
  }

  /** The speed's zeros in [lo, hi]. */
  curveSingular(row: number, lo: number, hi: number): { status: Status; params: Float64Array } {
    const r = this.list('curve_singular', row, lo, hi);
    return { status: r.status, params: r.breaks };
  }

  /** bound() over each range, `ranges` as lo, hi pairs. */
  curveBound(row: number, ranges: ArrayLike<number>): Boxes {
    const n = ranges.length / 2;
    const [s, boxes, statuses] = this.call('curve_bound', row, { f64: ranges }, n, { out: 'f64', n: 6 * n },
      { out: 'u8', n });
    return { status: STATUS[s]!, boxes: boxes as Float64Array, statuses: statuses as Uint8Array };
  }

  /** derivBound(order) over each range. */
  curveDerivBound(row: number, ranges: ArrayLike<number>, order: 1 | 2): Bounds {
    const n = ranges.length / 2;
    const [s, bounds, statuses] = this.call('curve_deriv_bound', row, { f64: ranges }, n, order, { out: 'f64', n },
      { out: 'u8', n });
    return { status: STATUS[s]!, bounds: bounds as Float64Array, statuses: statuses as Uint8Array };
  }

  /** invertCurve for each point (x, y, z triples; 2D curves' points with z = 0) over [lo, hi] within tol. */
  invertCurve(row: number, points: ArrayLike<number>, lo: number, hi: number, tol: number): Inversions {
    const n = points.length / 3;
    const [s, params, distance, foot, statuses, certainty, alternativeCount, flags] = this.call('curve_invert', row,
      { f64: points }, n, lo, hi, tol, { out: 'f64', n }, { out: 'f64', n }, { out: 'f64', n: 3 * n },
      { out: 'u8', n }, { out: 'u8', n }, { out: 'i32', n }, { out: 'u8', n });
    return { status: STATUS[s]!, params: params as Float64Array, distance: distance as Float64Array,
      foot: foot as Float64Array, statuses: statuses as Uint8Array, certainty: certainty as Uint8Array,
      alternativeCount: alternativeCount as Int32Array, alternatives: s === 0 ? this.scratch() : new Float64Array(),
      flags: flags as Uint8Array };
  }

  /**
   * localFoot (surface.h) for each point (x, y, z triples) from its start ((u, v) pairs) on surface `row`: Gauss-Newton
   * continued from the start, no global search. Per point: uv, the surface's point there, its distance, a status
   * (ok, noConvergence, singular) and the domain's side it's held on where ok there (0 u lo, 1 u hi, 2 v lo, 3 v hi;
   * else -1).
   */
  localFoot(row: number, points: ArrayLike<number>, starts: ArrayLike<number>): LocalFeet {
    return this.localFeet('surface_local_foot', row, points, starts);
  }

  /** As localFoot on a face's surface as it closes in fact (its periods the face's). */
  faceLocalFoot(face: number, points: ArrayLike<number>, starts: ArrayLike<number>): LocalFeet {
    return this.localFeet('face_local_foot', face, points, starts);
  }

  private localFeet(name: string, row: number, points: ArrayLike<number>, starts: ArrayLike<number>): LocalFeet {
    const n = points.length / 3;
    const [s, uv, point, distance, statuses, side] = this.call(name, row, { f64: points }, { f64: starts }, n,
      { out: 'f64', n: 2 * n }, { out: 'f64', n: 3 * n }, { out: 'f64', n }, { out: 'u8', n }, { out: 'i32', n });
    return { status: STATUS[s]!, uv: uv as Float64Array, point: point as Float64Array,
      distance: distance as Float64Array, statuses: statuses as Uint8Array, side: side as Int32Array };
  }

  /** arcLength over each range (t0, t1 pairs) at relTol. */
  arcLength(row: number, ranges: ArrayLike<number>, relTol: number): Estimates {
    const n = ranges.length / 2;
    const [s, value, error, statuses] = this.call('curve_length', row, { f64: ranges }, n, relTol, { out: 'f64', n },
      { out: 'f64', n }, { out: 'u8', n });
    return { status: STATUS[s]!, value: value as Float64Array, error: error as Float64Array,
      statuses: statuses as Uint8Array };
  }

  /** paramAtLength from t0[i] forward by length[i] at relTol. */
  paramAtLength(row: number, t0: ArrayLike<number>, length: ArrayLike<number>, relTol: number): Estimates {
    const n = t0.length;
    if (length.length !== n) throw new RangeError('cad-geom: paramAtLength needs as many lengths as parameters');
    const [s, value, error, statuses] = this.call('curve_param_at_length', row, { f64: t0 }, { f64: length }, n,
      relTol, { out: 'f64', n }, { out: 'f64', n }, { out: 'u8', n });
    return { status: STATUS[s]!, value: value as Float64Array, error: error as Float64Array,
      statuses: statuses as Uint8Array };
  }

  // -- Surfaces.

  surfaceInfo(row: number): SurfaceInfo {
    const [s, out] = this.call('surface_info', row, { out: 'f64', n: 6 });
    const o = out as Float64Array;
    return { status: STATUS[s]!, u: [o[0]!, o[1]!], v: [o[2]!, o[3]!], uPeriod: o[4]!, vPeriod: o[5]! };
  }

  /** S and its partials to `order` at each (u, v) pair. */
  evalSurface(row: number, uv: ArrayLike<number>, order: 0 | 1 | 2 = 1): SurfaceEvals {
    const n = uv.length / 2, w = order === 0 ? 1 : order === 1 ? 3 : 6;
    const [s, values, statuses] = this.call('surface_eval', row, { f64: uv }, n, order, { out: 'f64', n: 3 * w * n },
      { out: 'u8', n });
    return { status: STATUS[s]!, values: values as Float64Array, statuses: statuses as Uint8Array };
  }

  /** The unit normal at each (u, v): 3 each. */
  surfaceNormal(row: number, uv: ArrayLike<number>): SurfaceEvals {
    const n = uv.length / 2;
    const [s, values, statuses] = this.call('surface_normal', row, { f64: uv }, n, { out: 'f64', n: 3 * n },
      { out: 'u8', n });
    return { status: STATUS[s]!, values: values as Float64Array, statuses: statuses as Uint8Array };
  }

  /** bound() over each box (u lo, u hi, v lo, v hi). */
  surfaceBound(row: number, boxes: ArrayLike<number>): Boxes {
    const n = boxes.length / 4;
    const [s, out, statuses] = this.call('surface_bound', row, { f64: boxes }, n, { out: 'f64', n: 6 * n },
      { out: 'u8', n });
    return { status: STATUS[s]!, boxes: out as Float64Array, statuses: statuses as Uint8Array };
  }

  /** derivBound(order) over each box: 3 each, order + 1 used. */
  surfaceDerivBound(row: number, boxes: ArrayLike<number>, order: 1 | 2): Bounds {
    const n = boxes.length / 4;
    const [s, bounds, statuses] = this.call('surface_deriv_bound', row, { f64: boxes }, n, order,
      { out: 'f64', n: 3 * n }, { out: 'u8', n });
    return { status: STATUS[s]!, bounds: bounds as Float64Array, statuses: statuses as Uint8Array };
  }

  surfaceSingularities(row: number): { status: Status; singularities: Singularity[] } {
    const n = this.fn('surface_singularities')(this.live(), row);
    if (n < 0) return { status: STATUS[-n]!, singularities: [] };
    const v = this.scratch(), out: Singularity[] = [];
    for (let i = 0; i < n; i++) {
      const o = v.subarray(6 * i, 6 * i + 6);
      out.push({ kind: SINGULARITY[o[0]!]!, isoU: o[1] === 1, at: o[2]!, point: [o[3]!, o[4]!, o[5]!] });
    }
    return { status: 'ok', singularities: out };
  }

  /** invertSurface for each point over the box [u lo, u hi] x [v lo, v hi] within tol. */
  invertSurface(row: number, points: ArrayLike<number>, box: ArrayLike<number>, tol: number): Inversions {
    const n = points.length / 3;
    const [s, params, distance, foot, statuses, certainty, alternativeCount, flags] = this.call('surface_invert', row,
      { f64: points }, n, { f64: box }, tol, { out: 'f64', n: 2 * n }, { out: 'f64', n }, { out: 'f64', n: 3 * n },
      { out: 'u8', n }, { out: 'u8', n }, { out: 'i32', n }, { out: 'u8', n });
    return { status: STATUS[s]!, params: params as Float64Array, distance: distance as Float64Array,
      foot: foot as Float64Array, statuses: statuses as Uint8Array, certainty: certainty as Uint8Array,
      alternativeCount: alternativeCount as Int32Array, alternatives: s === 0 ? this.scratch() : new Float64Array(),
      flags: flags as Uint8Array };
  }

  // -- Projection: a 3D curve's p-curve on a surface (project.h).

  /**
   * projectCurve of curve row `row` over [lo, hi] onto surface row `surface` (as it closes in fact at tol), within
   * tol (mm); only a status where the curve or surface can't be made.
   */
  project(row: number, surface: number, lo: number, hi: number, tol: number, opts: ProjectOptions = {}):
    Pcurve | { status: Status } {
    const t = opts.samples ?? [], { start, end } = opts;
    const ends = start || end ? { f64: [start ? 1 : 0, start?.[0] ?? 0, start?.[1] ?? 0, end ? 1 : 0, end?.[0] ?? 0,
      end?.[1] ?? 0] } : 0;
    const [s] = this.call('project', row, surface, lo, hi, tol, ends, { f64: t }, t.length);
    return s !== 0 ? { status: STATUS[s]! } : readPcurve(this.scratch(), t.length);
  }

  /**
   * The coedge's edge curve projected onto its face's surface as the face API does (over its edge's parameters, the
   * seam side its use takes), whether or not the model gives it a p-curve: at `tol` where given (> 0), else the
   * edge's tolerance (the face API's, kept).
   */
  projectCoedge(coedge: number, tol = NaN, samples: ArrayLike<number> = []): Pcurve | { status: FaceStatus } {
    const [s] = this.call('coedge_project', coedge, tol, { f64: samples }, samples.length);
    return s !== 0 ? { status: faceStatus(s) } : readPcurve(this.scratch(), samples.length);
  }

  /**
   * The feet of a vertex's point on a face's surface (as it closes in fact) within tol of the nearest, from the end
   * search (project.h's EndSearchCache, per model, by vertex and face: the search runs once per pair, at the largest
   * tol asked).
   */
  endFeet(face: number, vertex: number, tol: number): { status: Status; feet: EndFoot[] } {
    const [n] = this.call('face_end_feet', face, vertex, tol);
    if (n! < 0) return { status: STATUS[-n!]!, feet: [] };
    const v = this.scratch(), feet: EndFoot[] = [];
    for (let i = 0; i < n!; i++) {
      const o = v.subarray(10 * i, 10 * i + 10);
      feet.push({ kind: END_FOOT_KIND[o[0]!]!, uv: [o[1]!, o[2]!], twin: [o[3]!, o[4]!], poleU: o[5] === 1,
        free: [o[6]!, o[7]!], distance: o[8]!, certainty: CERTAINTY[o[9]!]! });
    }
    return { status: 'ok', feet };
  }

  /**
   * The coedge's p-curve as the face API takes it (the model's, else its projection) at each parameter, to `order`:
   * as evalCurve's.
   */
  evalCoedge(coedge: number, t: ArrayLike<number>, order: 0 | 1 | 2 = 1):
    { status: FaceStatus; values: Float64Array; statuses: Uint8Array } {
    const n = t.length;
    const [s, values, statuses] = this.call('coedge_eval', coedge, { f64: t }, n, order,
      { out: 'f64', n: n * 3 * (order + 1) }, { out: 'u8', n });
    return { status: faceStatus(s), values: values as Float64Array, statuses: statuses as Uint8Array };
  }

  /** Whether the face API projects coedges without p-curves (on by default; off, their faces are 'noPcurve'). */
  setProjectMissingPcurves(on: boolean): void {
    this.fn('model_options')(this.live(), on ? 0 : 1);
  }

  // -- Faces: 2D geometry on a face's loops (geom2d.h; cad_geom_api.cpp says how the loops, periods, pole lines and
  // tolerances are made). tol3d, where given (> 0), is the 3D tolerance; else the model's (tolerance.h: the largest of
  // the part's uncertainty (else 1e-5 mm), the face's or edges' own and 1e-9 x the part's size).

  /**
   * The edge's curve parameters at its start and end as the face API takes them: its range where the model gives
   * one, else its vertices inverted onto its curve, by its sense (a vertex at a closed non-periodic curve's junction
   * taking the end its sense needs); NaN both for an edge without a 3D curve.
   */
  edgeParams(edge: number): { status: FaceStatus; t0: number; t1: number } {
    const [s, out] = this.call('edge_params', edge, { out: 'f64', n: 2 });
    const o = out as Float64Array;
    return s !== 0 ? { status: faceStatus(s), t0: NaN, t1: NaN } : { status: 'ok', t0: o[0]!, t1: o[1]! };
  }

  /** The face's loops as geom2d sees them: the 3D tolerance used, the periods, the edge loops, the pole lines. */
  faceInfo(face: number, tol3d = NaN): FaceInfo {
    const [s, out] = this.call('face_info', face, tol3d, { out: 'f64', n: 7 });
    if (s !== 0) {
      return { status: faceStatus(s), tolerance: NaN, uPeriod: 0, vPeriod: 0, loops: 0, poles: [], ownRanges: 0,
        projected: 0 };
    }
    const o = out as Float64Array, v = this.scratch(), poles: FaceInfo['poles'] = [];
    for (let i = 0; i < o[4]!; i++) poles.push({ isoU: v[2 * i] === 1, at: v[2 * i + 1]! });
    return { status: 'ok', tolerance: o[0]!, uPeriod: o[1]!, vPeriod: o[2]!, loops: o[3]!, poles, ownRanges: o[5]!,
      projected: o[6]! };
  }

  /**
   * The face's loops' pieces as classifyOnFace takes them, the face on each one's left: per piece its coedge (a coedge
   * two pieces where its use crosses a closed p-curve's ends), the p-curve's parameters where it starts and ends.
   */
  facePieces(face: number): { status: FaceStatus; coedge: Int32Array; travel: Float64Array } {
    const n = this.fn('face_pieces')(this.live(), face);
    if (n < 0) return { status: faceStatus(-n), coedge: new Int32Array(), travel: new Float64Array() };
    const v = this.scratch(), coedge = new Int32Array(n), travel = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) coedge[i] = v[3 * i]!, travel[2 * i] = v[3 * i + 1]!, travel[2 * i + 1] = v[3 * i + 2]!;
    return { status: 'ok', coedge, travel };
  }

  /** classify2 of each (u, v) against the face's loops: sides as SIDE codes, each point's (u, v) tolerance. */
  classifyOnFace(face: number, uv: ArrayLike<number>, tol3d = NaN): FaceSides {
    const n = uv.length / 2;
    const [s, sides, statuses, tolerance] = this.call('face_classify', face, { f64: uv }, n, tol3d,
      { out: 'u8', n }, { out: 'u8', n }, { out: 'f64', n });
    return { status: faceStatus(s), sides: sides as Uint8Array, statuses: statuses as Uint8Array,
      tolerance: tolerance as Float64Array };
  }

  /** nest2 on the face's loops: each loop's parent among the face's loops (-1 outermost, and vertex loops). */
  nestFace(face: number, loops: number, tol3d = NaN):
    { status: FaceStatus; nest: Status; parents: Int32Array } {
    const [s, parents, status] = this.call('face_nest', face, tol3d, { out: 'i32', n: loops },
      { out: 'u8', n: 1 });
    return { status: faceStatus(s), nest: STATUS[(status as Uint8Array)[0] ?? 0]!, parents: parents as Int32Array };
  }

  /** selfIntersect2 on one of the face's loops: crossings and touches, with each one's (ta, tb, u, v, tangent). */
  selfIntersectFace(face: number, loop: number, tol3d = NaN): FaceSelf {
    const [s, counts, status] = this.call('face_self', face, loop, tol3d, { out: 'i32', n: 3 },
      { out: 'u8', n: 1 });
    if (s !== 0) return { status: faceStatus(s), self: 'ok', crossings: 0, touches: 0, overlaps: 0, points: [] };
    const c = counts as Int32Array, v = this.scratch(), points: FaceSelf['points'] = [];
    for (let i = 0; i < c[0]! + c[1]!; i++) {
      const o = v.subarray(5 * i, 5 * i + 5);
      points.push({ ta: o[0]!, tb: o[1]!, u: o[2]!, v: o[3]!, tangent: o[4] === 1 });
    }
    return { status: 'ok', self: STATUS[(status as Uint8Array)[0] ?? 0]!, crossings: c[0]!, touches: c[1]!,
      overlaps: c[2]!, points };
  }

  // -- The calls.

  /** The module's cg_<name> (cad_geom_api.cpp; build.sh exports each). */
  private fn(name: string): Fn {
    const f = this.x[`_cg_${name}`];
    if (!f) throw new Error(`cad-geom: the module lacks cg_${name}: rebuild it (packages/cad-geom/build.sh module)`);
    return f;
  }

  private live(): number {
    if (this.handle < 0) throw new Error('cad-geom: Geometry used after dispose()');
    return this.handle;
  }

  /** A copy of the module's scratch array (cg_scratch). */
  private scratch(): Float64Array {
    const n = this.fn('scratch_size')(), p = this.fn('scratch')();
    return n ? this.x.HEAPF64.slice(p / 8, p / 8 + n) : new Float64Array();
  }

  private list(name: string, row: number, lo: number, hi: number): { status: Status; breaks: Float64Array } {
    const n = this.fn(name)(this.live(), row, lo, hi);
    return n < 0 ? { status: STATUS[-n]!, breaks: new Float64Array() } : { status: 'ok', breaks: this.scratch() };
  }

  /**
   * cg_<name>(handle, row, args...): inputs copied in, outputs allocated (8-aligned, one block, freed after), the
   * call's status first, then each output copied out, in order (empty where the status isn't ok).
   */
  private call(name: string, row: number, ...args: Arg[]): [number, ...(Float64Array | Uint8Array | Int32Array)[]] {
    const x = this.x, h = this.live();
    const size = (a: In | Out) => 'f64' in a ? 8 * a.f64.length : a.n * (a.out === 'f64' ? 8 : a.out === 'i32' ? 4 : 1);
    let total = 0;
    for (const a of args) if (typeof a !== 'number') total += (size(a) + 7) & ~7;
    const base = x._malloc(Math.max(8, total));
    try {
      let at = base;
      const ptrs: number[] = [];
      for (const a of args) {
        if (typeof a === 'number') { ptrs.push(a); continue; }
        ptrs.push(at);
        if ('f64' in a) x.HEAPF64.set(a.f64, at / 8);
        at += (size(a) + 7) & ~7;
      }
      const s = this.fn(name)(h, row, ...ptrs);
      const outs: (Float64Array | Uint8Array | Int32Array)[] = [];
      args.forEach((a, i) => {
        if (typeof a === 'number' || 'f64' in a) return;
        const p = ptrs[i]!, n = s === 0 ? a.n : 0;
        // The heap's views read after the call: memory may have grown in it.
        outs.push(a.out === 'f64' ? x.HEAPF64.slice(p / 8, p / 8 + n) : a.out === 'i32'
          ? x.HEAP32.slice(p / 4, p / 4 + n) : x.HEAPU8.slice(p, p + n));
      });
      return [s, ...outs];
    } finally {
      x._free(base);
    }
  }
}
