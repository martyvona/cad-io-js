// cad-oracle's TypeScript layer: the WebAssembly module (dist/cad_oracle.wasm, build.sh's `module`) loaded by `init`,
// and an Oracle per B-rep model buffer (cad-brep's format) giving its edges' lengths, its faces' areas and
// perimeters and their polynomial moments, each with its error estimate, status and flags. What each measure means
// and how it's computed: native/include/cad_oracle/oracle.h; the module's C API is native/src/cad_oracle_api.cpp.

/** result.h's Status, by code. */
export const STATUS = ['ok', 'unsupported', 'outOfDomain', 'singular', 'noConvergence', 'invalidModel'] as const;
export type Status = (typeof STATUS)[number];
/** oracle.h's Method, by code. */
export const METHOD = ['none', 'closedForm', 'extrusion', 'revolution', 'freeForm'] as const;
export type Method = (typeof METHOD)[number];
/** oracle.h's Flag bits. */
export const FLAGS = { orientation: 1, sphereSide: 2, loose: 4, winds: 8, noLoops: 16, offSurface: 32,
  projectedBoundary: 64, cells: 128 } as const;
export type OracleFlag = keyof typeof FLAGS;

/** The module's C API version this layer speaks (co_api_version). */
const API_VERSION = 2;

/** A computed real with an a posteriori estimate of its error (result.h's Estimate). */
export interface Estimate {
  value: number;
  error: number;
  status: Status;
}

export interface FaceMeasure {
  /** In the model's units squared. */
  area: Estimate;
  /** Every edge of every edge loop, a seam twice. */
  perimeter: Estimate;
  method: Method;
  /** Why the area may be wrong although computed (oracle.h's Flag). */
  flags: OracleFlag[];
  /** The largest distance of a loop's point from the surface over the loops' size (closed forms only; else NaN). */
  offSurface: number;
  /** Why the area is unsupported or failed, where it is. */
  why: string;
}

/** A measure to rely on: computed, no flags, its error within `relative` of its value (oracle.h's trusted). */
export function trusted(m: FaceMeasure, relative = 1e-6): boolean {
  return m.area.status === 'ok' && m.flags.length === 0 && m.area.error <= relative * m.area.value;
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

export class Oracle {
  private readonly x: OracleExports;
  private h: number;

  constructor(module: OracleModule, buffer: ArrayBuffer | ArrayBufferView, opts: OracleOptions = {}) {
    this.x = module.exports;
    const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const p = this.x._malloc(Math.max(8, bytes.length));
    this.x.HEAPU8.set(bytes, p);
    // co_model_new owns p from here on, freed even where it isn't a model.
    this.h = this.x._co_model_new!(p, bytes.length, opts.relTol ?? 0);
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

  /** Face row `face`'s area, perimeter and flags (oracle.h's face). */
  face(face: number): FaceMeasure {
    const x = this.x, p = x._malloc(80);
    try {
      x._co_face!(this.live(), face, p, p + 72);
      const o = x.HEAPF64.subarray(p / 8, p / 8 + 9);
      const why = x.UTF8ToString(x.HEAP32[(p + 72) / 4]!);
      return { area: { value: o[0]!, error: o[1]!, status: STATUS[o[2]!]! },
        perimeter: { value: o[3]!, error: o[4]!, status: STATUS[o[5]!]! }, method: METHOD[o[6]!]!,
        flags: flagsOf(o[7]!), offSurface: o[8]!, why };
    } finally {
      x._free(p);
    }
  }
}
