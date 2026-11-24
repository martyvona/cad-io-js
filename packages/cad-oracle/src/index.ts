// cad-oracle's TypeScript layer: the WebAssembly module (dist/cad_oracle.wasm, build.sh's `module`) loaded by `init`,
// and an Oracle per B-rep model buffer (cad-brep's format) giving its edges' lengths, its faces' areas and
// perimeters and their polynomial moments, each with its error estimate, status and flags; and points against its
// closed shells by rays, its faces' sides of their shells (shell-side.ts's ShellSide), its bodies' shells nested.
// What each means and how it's computed: native/include/cad_oracle/oracle.h; the module's C API is
// native/src/cad_oracle_api.cpp.

/** result.h's Status, by code. */
export const STATUS = ['ok', 'unsupported', 'outOfDomain', 'singular', 'noConvergence', 'invalidModel'] as const;
export type Status = (typeof STATUS)[number];
/** oracle.h's Method, by code. */
export const METHOD = ['none', 'closedForm', 'extrusion', 'revolution', 'freeForm'] as const;
export type Method = (typeof METHOD)[number];
/** oracle.h's Flag bits. */
export const FLAGS = { orientation: 1, sphereSide: 2, loose: 4, winds: 8, noLoops: 16, offSurface: 32,
  projectedBoundary: 64, cells: 128, edgesPlaced: 256 } as const;
export type OracleFlag = keyof typeof FLAGS;

/** The module's C API version this layer speaks (co_api_version). */
const API_VERSION = 6;

/** A computed real with an a posteriori estimate of its error (result.h's Estimate). */
export interface Estimate {
  value: number;
  error: number;
  status: Status;
}

export interface FaceMeasure {
  /** In the model's units squared; its error the quadrature's plus `boundary` where that's known. */
  area: Estimate;
  /** Every edge of every edge loop, a seam twice. */
  perimeter: Estimate;
  method: Method;
  /** Why the area may be wrong although computed (oracle.h's Flag). */
  flags: OracleFlag[];
  /** The largest distance of a loop's point from the surface over the loops' size (closed forms only; else NaN). */
  offSurface: number;
  /**
   * How far the area can be off for its loops' p-curves not being their edges' curves (oracle.h's
   * FaceMeasure::boundary): the sum over the uses of the p-curve's deviation from the curve (given: measured by the
   * p-curve's own parameter; healed: the analysis's; projected: the projection's error) times the edge's length; 0 on
   * closed forms; NaN where it couldn't be had.
   * Included in area.error where it's known (where it's NaN, area.error is the quadrature's alone and trusted()
   * refuses the face).
   */
  boundary: number;
  /** Why the area is unsupported or failed, where it is. */
  why: string;
}

/**
 * A measure to rely on: computed, no flags but projectedBoundary and edgesPlaced, its boundary's error known, its
 * error (the boundary's included) within `relative` of its value (oracle.h's trusted). What users see is the value and
 * its error, with the flags no estimate covers said beside them.
 */
export function trusted(m: FaceMeasure, relative = 1e-6): boolean {
  return m.area.status === 'ok' && m.flags.every((f) => f === 'projectedBoundary' || f === 'edgesPlaced')
    && Number.isFinite(m.boundary)
    && m.area.error <= relative * m.area.value;
}

type Fn = (...args: number[]) => number;
interface OracleExports {
  HEAPU8: Uint8Array;
  HEAP32: Int32Array;
  HEAPF64: Float64Array;
  UTF8ToString(ptr: number): string;
  _malloc(n: number): number;
  _free(p: number): void;
  [name: `_co_${string}`]: Fn;
}
type OracleFactory = (opts: {
  instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance) => void) => object;
  print: (text: string) => void;
  printErr: (text: string) => void;
}) => Promise<unknown>;

/** Where `init` gets its module; the glue and the module must come from the same build. */
export interface OracleInitOptions {
  /** The Emscripten glue: its factory (the .mjs's default export), or its URL. Default dist/cad_oracle.mjs. */
  glue?: OracleFactory | URL | string;
  /** The module: its bytes, its URL, or compiled. Default dist/cad_oracle.wasm. */
  wasm?: BufferSource | URL | string | WebAssembly.Module;
}

/** A loaded module: pass it to Oracle (one module serves any number of models). */
export interface OracleModule {
  readonly exports: OracleExports;
}

async function fetchBytes(url: URL): Promise<BufferSource> {
  if (url.protocol === 'file:') return (await import('node:fs/promises')).readFile(url);
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

let defaultModule: Promise<OracleModule> | undefined;

/**
 * Loads the module: a host's glue and wasm (a bundler's URLs, bytes, a compiled module), or the package's dist/ by
 * default, that one loaded once and shared.
 */
export function init(opts?: OracleInitOptions): Promise<OracleModule> {
  if (opts === undefined || (opts.glue === undefined && opts.wasm === undefined)) {
    return defaultModule ??= load({}).catch((e) => {
      defaultModule = undefined;
      throw e;
    });
  }
  return load(opts);
}

async function load(opts: OracleInitOptions): Promise<OracleModule> {
  const { glue, wasm } = opts;
  const glueUrl = glue === undefined ? new URL('../dist/cad_oracle.mjs', import.meta.url).href : String(glue);
  const factory = typeof glue === 'function' ? glue : (await import(glueUrl)).default as OracleFactory;
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(
    wasm !== undefined && typeof wasm !== 'string' && !(wasm instanceof URL) ? wasm
      : await fetchBytes(wasm === undefined ? new URL('../dist/cad_oracle.wasm', import.meta.url) : new URL(wasm)));
  let fail!: (e: unknown) => void;
  const failed = new Promise<never>((_, reject) => (fail = reject));
  const exports = (await Promise.race([factory({
    instantiateWasm: (imports, done) => {
      WebAssembly.instantiate(module, imports).then(done, fail);
      return {};
    },
    print: () => {},
    printErr: () => {},
  }), failed])) as OracleExports;
  const version = exports._co_api_version;
  if (typeof version !== 'function' || version() !== API_VERSION) {
    throw new Error(`cad-oracle: the module's API isn't version ${API_VERSION}: rebuild it (packages/cad-oracle/`
      + 'build.sh module), with its glue from the same build');
  }
  return { exports };
}

export interface OracleOptions {
  /** The quadrature's relative tolerance on each edge's and loop's integral (default oracle.h's, 1e-10). */
  relTol?: number;
  /**
   * classify and shellSide: a second usable ray must agree with the first, else the point is unknown (oracle.h's
   * checkSecondRay; for checks: a disagreement is a fault in the line's search or the faces' classification).
   */
  checkSecondRay?: boolean;
  /**
   * The model's analysis (cad-brep's, as healing gives it; its hash the model's: the caller pairs them): the
   * deviations of the p-curves healing made, which FaceMeasure.boundary takes instead of measuring them.
   */
  analysis?: { buffer: ArrayBuffer } | ArrayBuffer | Uint8Array;
  /**
   * Whether the face API projects the loops' coedges without p-curves (default true: oracle.h's
   * Options::projectMissing). False: a face with such a coedge gets no area (status not ok), the projections' cost
   * spared.
   */
  projectMissing?: boolean;
}

/** co_face's out[0..9] and its why as a FaceMeasure. */
function faceMeasure(o: Float64Array, why: string): FaceMeasure {
  return { area: { value: o[0]!, error: o[1]!, status: STATUS[o[2]!]! },
    perimeter: { value: o[3]!, error: o[4]!, status: STATUS[o[5]!]! }, method: METHOD[o[6]!]!,
    flags: flagsOf(o[7]!), offSurface: o[8]!, boundary: o[9]!, why };
}

const flagsOf = (bits: number) => (Object.keys(FLAGS) as OracleFlag[]).filter((k) => bits & FLAGS[k]);

/** The oracle of one model: its own copy of the buffer in the module, until dispose. */
/** One monomial's moments over a face: the integral of (p - c)^exponent n_j for j = x, y, z. */
export interface Moment {
  exponent: [number, number, number];
  n: [Estimate, Estimate, Estimate];
}

/** The largest degree faceMoments takes (co_face_moments). */
export const MAX_MOMENT_DEGREE = 4;

export type Vec3 = [number, number, number];

/** oracle.h's PointClass: a point against a closed shell by parity. */
export interface PointClass {
  side: 'inside' | 'outside' | 'on' | 'unknown';
  /** Why on or unknown ('' otherwise). */
  why: string;
  /** The deciding ray (from the point, along direction, for length) and its crossings; absent where none decided. */
  ray?: { direction: Vec3; length: number; crossings: number };
  /** Rays tried, and those set aside, by why. */
  tried: number;
  rejected: { boundary: number; tangency: number; overlap: number; budget: number; near: number };
  /** A second usable ray counted and agreeing (OracleOptions.checkSecondRay). */
  checked: boolean;
}

/** oracle.h's ShellSide for one face: which side of its closed shell a point just outside the face lies on. */
export interface FaceSide {
  side: 'outside' | 'inside' | 'unknown';
  why: string;
  /** The point well inside the face, the point moved off it (eps along its normal) and that point's class. */
  from: Vec3;
  point: Vec3;
  eps: number;
  classified: PointClass;
}

const SIDE = ['inside', 'outside', 'on', 'unknown'] as const;
const FACE_SIDE = ['outside', 'inside', 'unknown'] as const;
function pointClass(o: Float64Array, why: string): PointClass {
  const tried = o[6]!, crossings = o[5]!;
  const side = SIDE[o[0]!]!;
  return { side, why,
    ...(side === 'inside' || side === 'outside' ? { ray: { direction: [o[1]!, o[2]!, o[3]!] as Vec3, length: o[4]!,
      crossings } } : {}),
    tried, rejected: { boundary: o[7]!, tangency: o[8]!, overlap: o[9]!, budget: o[10]!, near: o[11]! },
    checked: o[12]! !== 0 };
}

export class Oracle {
  private readonly x: OracleExports;
  private h: number;

  constructor(module: OracleModule, buffer: ArrayBuffer | ArrayBufferView, opts: OracleOptions = {}) {
    this.x = module.exports;
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const p = this.x._malloc(Math.max(8, bytes.length));
    this.x.HEAPU8.set(bytes, p);
    const a = opts.analysis === undefined ? undefined : opts.analysis instanceof Uint8Array ? opts.analysis
      : new Uint8Array(opts.analysis instanceof ArrayBuffer ? opts.analysis : opts.analysis.buffer);
    const q = a ? this.x._malloc(Math.max(8, a.length)) : 0;
    if (a) this.x.HEAPU8.set(a, q);
    // co_model_new owns p from here on, freed even where it isn't a model; the analysis is read, then ours to free.
    this.h = this.x._co_model_new!(p, bytes.length, opts.relTol ?? 0, q, a?.length ?? 0,
      (opts.projectMissing === false ? 1 : 0) | (opts.checkSecondRay ? 2 : 0));
    if (q) this.x._free(q);
    if (this.h < 0) throw new Error('cad-oracle: not a B-rep model buffer');
  }

  /** An Oracle on the default module (init()). */
  static async of(buffer: ArrayBuffer | ArrayBufferView, opts: OracleOptions = {}): Promise<Oracle> {
    return new Oracle(await init(), buffer, opts);
  }

  dispose(): void {
    if (this.h >= 0) this.x._co_model_free!(this.h);
    this.h = -1;
  }
  [Symbol.dispose](): void { this.dispose(); }

  private live(): number {
    if (this.h < 0) throw new Error('cad-oracle: the Oracle is disposed');
    return this.h;
  }

  /** Edge row `edge`'s length (oracle.h's edgeLength). */
  edgeLength(edge: number): Estimate {
    const x = this.x, p = x._malloc(24);
    try {
      x._co_edge_length!(this.live(), edge, p);
      const o = x.HEAPF64.subarray(p / 8, p / 8 + 3);
      return { value: o[0]!, error: o[1]!, status: STATUS[o[2]!]! };
    } finally {
      x._free(p);
    }
  }

  /**
   * Face row `face`'s moments about `center` (oracle.h's faceIntegral): for every monomial (p - c)^(a, b, c) of
   * degree at most `degree` (by degree, then a, then b, descending), its integral times each component of the area
   * vector n (the face's sense applied). Over a closed shell's faces: the volume is the sum of (x n_x + y n_y + z n_z)
   * / 3 over the degree-1 monomials, a first moment x^2 n_x / 2, and so on (the divergence theorem). Unsupported
   * where the area is.
   */
  faceMoments(face: number, opts: { center?: [number, number, number]; degree?: number } = {}): Moment[] {
    const [cx, cy, cz] = opts.center ?? [0, 0, 0], degree = opts.degree ?? 1;
    if (!Number.isInteger(degree) || degree < 0 || degree > MAX_MOMENT_DEGREE) {
      throw new Error(`cad-oracle: a moment's degree is 0 to ${MAX_MOMENT_DEGREE}, not ${degree}`);
    }
    const exponents: [number, number, number][] = [];
    for (let t = 0; t <= degree; t++)
      for (let a = t; a >= 0; a--)
        for (let b = t - a; b >= 0; b--) exponents.push([a, b, t - a - b]);
    const x = this.x, p = x._malloc(72 * exponents.length);
    try {
      x._co_face_moments!(this.live(), face, cx, cy, cz, degree, p);
      const o = x.HEAPF64.subarray(p / 8, p / 8 + 9 * exponents.length);
      const at = (k: number): Estimate => ({ value: o[3 * k]!, error: o[3 * k + 1]!, status: STATUS[o[3 * k + 2]!]! });
      return exponents.map((exponent, m) => ({ exponent, n: [at(3 * m), at(3 * m + 1), at(3 * m + 2)] }));
    } finally {
      x._free(p);
    }
  }

  /**
   * Face row `face`'s flux of p - c by components: the integrals of (p - c)_j n_j, j = x, y, z (co_face_flux), the
   * three of faceMoments' degree 1 a volume needs (a closed shell's signed volume their sum over its faces / 3),
   * integrated alone, so cheaper.
   */
  faceFlux(face: number, center: [number, number, number] = [0, 0, 0]): [Estimate, Estimate, Estimate] {
    const x = this.x, p = x._malloc(72);
    try {
      x._co_face_flux!(this.live(), face, center[0], center[1], center[2], p);
      const o = x.HEAPF64.subarray(p / 8, p / 8 + 9);
      const at = (k: number): Estimate => ({ value: o[3 * k]!, error: o[3 * k + 1]!, status: STATUS[o[3 * k + 2]!]! });
      return [at(0), at(1), at(2)];
    } finally {
      x._free(p);
    }
  }

  /** Point `p` against closed shell row `shell` by rays (oracle.h's classify). */
  classify(shell: number, p: Vec3): PointClass {
    const x = this.x, o = x._malloc(13 * 8 + 8);
    try {
      x._co_classify!(this.live(), shell, p[0], p[1], p[2], o, o + 104);
      return pointClass(x.HEAPF64.slice(o / 8, o / 8 + 13), x.UTF8ToString(x.HEAP32[(o + 104) / 4]!));
    } finally {
      x._free(o);
    }
  }

  /**
   * Which side of closed shell row `shell` a point just outside face row `face` lies on, eps along its normal (its
   * sense applied; negative: against it; at least 10 x the face's tolerance, less taken as that) from a point well
   * inside it (oracle.h's shellSide).
   */
  shellSide(shell: number, face: number, eps: number): FaceSide {
    const x = this.x, o = x._malloc(21 * 8 + 8);
    try {
      x._co_shell_side!(this.live(), shell, face, eps, o, o + 168);
      const v = x.HEAPF64.slice(o / 8, o / 8 + 21), why = x.UTF8ToString(x.HEAP32[(o + 168) / 4]!);
      return { side: FACE_SIDE[v[0]!]!, why, from: [v[1]!, v[2]!, v[3]!], point: [v[4]!, v[5]!, v[6]!], eps: v[7]!,
        classified: pointClass(v.subarray(8), '') };
    } finally {
      x._free(o);
    }
  }

  /**
   * Body row `body`'s shells nested (oracle.h's nesting): per shell of the body, the index among them of the smallest
   * holding it, -1 for none, -2 where it can't be told (an open shell, a point unknown against another).
   */
  nesting(body: number): number[] {
    const x = this.x;
    for (let room = 8; ; room *= 4) {
      const o = x._malloc(4 * room);
      try {
        const n = x._co_nesting!(this.live(), body, o, room);
        if (n < 0) return [];
        if (n <= room) return Array.from(x.HEAP32.subarray(o / 4, o / 4 + n));
      } finally {
        x._free(o);
      }
    }
  }

  /** Face row `face`'s area, perimeter and flags (oracle.h's face). */
  face(face: number): FaceMeasure {
    const x = this.x, p = x._malloc(88);
    try {
      x._co_face!(this.live(), face, p, p + 80);
      return faceMeasure(x.HEAPF64.subarray(p / 8, p / 8 + 10), x.UTF8ToString(x.HEAP32[(p + 80) / 4]!));
    } finally {
      x._free(p);
    }
  }

  /**
   * face(face), with faceFlux(face, center) where it comes with the area's pass (oracle.h's face with an integrand):
   * on a free-form face one pass for both, about half their cost, the flux the same bits as faceFlux's (the area could
   * differ from face(face)'s in the last place; on the corpus it doesn't). Elsewhere the measure alone, no flux.
   */
  faceAndFlux(face: number, center: [number, number, number] = [0, 0, 0]):
    { measure: FaceMeasure; flux?: [Estimate, Estimate, Estimate] } {
    const x = this.x, p = x._malloc(168);
    try {
      x._co_face_and_flux!(this.live(), face, center[0], center[1], center[2], p, p + 160);
      const o = x.HEAPF64.subarray(p / 8, p / 8 + 20);
      const at = (k: number): Estimate => ({ value: o[10 + 3 * k]!, error: o[11 + 3 * k]!,
        status: STATUS[o[12 + 3 * k]!]! });
      const measure = faceMeasure(o, x.UTF8ToString(x.HEAP32[(p + 160) / 4]!));
      return o[19] ? { measure, flux: [at(0), at(1), at(2)] } : { measure };
    } finally {
      x._free(p);
    }
  }
}
export { AREA_ORACLE_ID, areaOracle, JUDGE_PROJECT, JUDGE_REL_TOL, JUDGE_RELATIVE, type JudgedArea, type ModelLike }
  from './judge.ts';
export { shellBox, type ShellModel, shellVolumes, type ShellVolume, solidShells } from './shells.ts';
