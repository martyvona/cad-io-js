// Caching tessellation results per part: a Tessellator that answers from a store when it has seen the request, keyed
// by a hash of the payload, the backend's name and version, and the request's meshing options (not edges or measures,
// which don't change the triangles: an entry records whether its request asked for them). Failures are cached too.

import { failedPart, sha256 as digest, TessellationError, type TessellationRequest, type TessellationResult,
  type Tessellator, type TessellatorInfo } from 'cad-scene';

/** Where cached results live: bytes by key, the least recently used evicted beyond `maxBytes`. */
export interface CacheStore {
  /** The most bytes the store holds; 0 disables it. */
  readonly maxBytes: number;
  get(key: string): Promise<Uint8Array | undefined>;
  /** Stores nothing if the value alone is larger than `maxBytes`. */
  set(key: string, value: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
  /** Deletes every entry whose key `drop` accepts, including those other processes or pages wrote. */
  deleteWhere(drop: (key: string) => boolean): Promise<void>;
  clear(): Promise<void>;
  /** The bytes held. */
  size(): Promise<number>;
}

/** Changes whenever the key's contents or the encoding change, so old entries are never read. */
const FORMAT = 4;
const MAGIC = 0x34524354; // "TCR4", little-endian
/**
 * The start of every key of this format. Keys of earlier formats never start so (those before 4 are lower case), so a
 * store holding any key without it holds old entries, and is cleared (CachedTessellator).
 */
export const FORMAT_TAG = `F${FORMAT}_`;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array<ArrayBuffer>) => hex(await digest(b));

/**
 * The start of a backend's keys: the format's tag (`FORMAT_TAG`), then `<name>_` for every version of the backend
 * (its name in lower case, other characters than letters and digits as `-`, at most 32), then `<version>_` for this
 * version (12 hex digits of a hash of the cache format, the name and the version).
 */
export async function keyPrefix(info: TessellatorInfo): Promise<{ backend: string; version: string }> {
  const backend = `${FORMAT_TAG}${info.name.toLowerCase().replace(/[^0-9a-z]+/g, '-').slice(0, 32) || '-'}_`;
  const version = (await sha256(
    new TextEncoder().encode(JSON.stringify([FORMAT, info.name, info.version])))).slice(0, 12);
  return { backend, version: `${backend}${version}_` };
}

/**
 * The key for a request to a backend: the backend's prefix (`keyPrefix`), then SHA-256 (hex) over the cache format,
 * the backend's name and version, the request's options and its payload. Not whether it asks for edges or measures:
 * a backend's triangles don't depend on them (`Tessellator`), so one entry serves requests with and without.
 */
export async function cacheKey(info: TessellatorInfo, req: TessellationRequest): Promise<string> {
  const head = new TextEncoder().encode(JSON.stringify([
    FORMAT, info.name, info.version, req.format, req.rootId ?? null, req.origin ?? [0, 0, 0],
    req.linearDeflection, req.angularDeflection,
  ]));
  const all = new Uint8Array(head.length + 1 + req.data.length);
  all.set(head);
  all.set(req.data, head.length + 1);
  return `${(await keyPrefix(info)).version}${await sha256(all)}`;
}

/**
 * What a cache holds for a request, and when (milliseconds since the epoch): the backend's result, with what the
 * request asked for besides the triangles (`edges`, `measures`: the result has what the backend could give of
 * them), or the TessellationError (or WebAssembly trap) the request threw, with its time limit if it ran out of time.
 */
export type CacheEntry =
  | { at: number; result: TessellationResult; edges: boolean; measures: boolean }
  | { at: number; thrown: { message: string; timeoutMs?: number } };

type Header = Partial<Pick<TessellationResult, 'origin' | 'faces' | 'edges' | 'curves' | 'pointIds'
  | 'outlines' | 'measures' | 'oracle' | 'diagnostics'>> & {
  at: number;
  /** What a result's request asked for. */
  asked?: { edges: boolean; measures: boolean };
  thrown?: { message: string; timeoutMs?: number };
  /**
   * Lengths of positions, normals, indices, edgePositions, curvePositions, points, outlinePositions (-1: absent).
   */
  n: [number, number, number, number, number, number, number];
};

/**
 * An entry as bytes: the magic number, the JSON header's length, the header, then the result's arrays (positions,
 * normals, indices, edge positions, curve positions, points, outline positions) 4-byte aligned, in the platform's
 * byte order (a store is local to its machine).
 */
export function encodeEntry(e: CacheEntry): Uint8Array {
  const r = 'result' in e ? e.result : undefined;
  const arrays = [r?.positions, r?.normals, r?.indices, r?.edgePositions, r?.curvePositions, r?.points,
    r?.outlinePositions];
  const header: Header = { at: e.at, n: arrays.map((a) => a?.length ?? -1) as Header['n'] };
  if (r) {
    header.asked = { edges: (e as { edges: boolean }).edges, measures: (e as { measures: boolean }).measures };
    Object.assign(header, { origin: r.origin, faces: r.faces, diagnostics: r.diagnostics },
      r.edges ? { edges: r.edges } : {});
    Object.assign(header, r.curves ? { curves: r.curves } : {}, r.pointIds ? { pointIds: r.pointIds } : {},
      r.outlines ? { outlines: r.outlines } : {}, r.measures ? { measures: r.measures } : {},
      r.oracle ? { oracle: r.oracle } : {});
  }
  else if ('thrown' in e) header.thrown = e.thrown;
  const json = new TextEncoder().encode(JSON.stringify(header));
  let offset = align(8 + json.length);
  const out = new Uint8Array(offset + arrays.reduce((n, a) => n + (a?.byteLength ?? 0), 0));
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, json.length, true);
  out.set(json, 8);
  for (const a of arrays) {
    if (!a) continue;
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), offset);
    offset += a.byteLength;
  }
  return out;
}

/** The entry `encodeEntry` encoded, its arrays each in a buffer of its own. Throws if the bytes aren't one. */
export function decodeEntry(bytes: Uint8Array): CacheEntry {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('not a cache entry');
  const jsonLength = view.getUint32(4, true);
  if (8 + jsonLength > bytes.length) throw new Error('truncated cache entry');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + jsonLength))) as Header;
  let offset = align(8 + jsonLength);
  if (offset + header.n.reduce<number>((s, k) => s + 4 * Math.max(k ?? -1, 0), 0) !== bytes.length) throw new Error(
    'truncated cache entry');
  if (header.thrown) return { at: header.at, thrown: header.thrown };
  const take = <T>(k: number, C: new (b: ArrayBuffer) => T): T | undefined => {
    if (k < 0) return undefined;
    const a = new C(bytes.slice(offset, offset + 4 * k).buffer);
    offset += 4 * k;
    return a;
  };
  const [np, nn, ni, ne, nc, nq, no] = header.n;
  const positions = take(np, Float32Array)!;
  const normals = take(nn, Float32Array);
  const indices = take(ni, Uint32Array)!;
  const edgePositions = take(ne, Float32Array);
  const curvePositions = take(nc, Float32Array);
  const points = take(nq, Float32Array);
  const outlinePositions = take(no, Float32Array);
  const r: TessellationResult = { origin: header.origin!, positions, indices, faces: header.faces!,
    diagnostics: header.diagnostics! };
  if (normals) r.normals = normals;
  if (edgePositions) r.edgePositions = edgePositions;
  if (header.edges) r.edges = header.edges;
  if (curvePositions) r.curvePositions = curvePositions;
  if (header.curves) r.curves = header.curves;
  if (points) r.points = points;
  if (header.pointIds) r.pointIds = header.pointIds;
  if (outlinePositions) r.outlinePositions = outlinePositions;
  if (header.outlines) r.outlines = header.outlines;
  if (header.measures) r.measures = header.measures;
  if (header.oracle) r.oracle = header.oracle;
  return { at: header.at, result: r, edges: header.asked!.edges, measures: header.asked!.measures };
}

const align = (n: number) => (n + 3) & ~3;

/**
 * Whether an entry records a failure: a request that threw, or a failed part's result (cad-scene's failedPart; not one
 * only some of whose faces failed).
 */
export const isFailure = (e: CacheEntry) => 'thrown' in e || failedPart(e.result);

export interface CachedTessellatorOptions {
  /** Send requests whose cached entry is a failure to the backend again (and cache what it answers). Default false. */
  retryFailures?: boolean;
  /**
   * Keep the entries of this backend's other versions. By default they're deleted when the cache first sees a version
   * (once per CachedTessellator), since they'd never be read again; other backends' entries are kept either way. (A
   * store holding entries of an older cache format is cleared whatever this says.)
   */
  keepOtherVersions?: boolean;
}

export interface CacheStats {
  /** Requests answered from the store, failures included. */
  hits: number;
  /** Of the hits, cached failures. */
  failureHits: number;
  misses: number;
  /**
   * Store failures (a read, a write, an entry that didn't decode, deleting other versions), each answered by the
   * backend instead.
   */
  errors: number;
}

/**
 * A Tessellator that caches `inner`'s results in `store`, failures included: failed parts' results (isFailure), and
 * requests that throw a TessellationError (`cad-scene`; the worker pool's timeouts and backend traps) or a WebAssembly
 * trap. Other errors (a worker that died, a pool disposed) aren't the part's, and aren't cached. A cached timeout
 * answers only when `inner`'s time limit (`timeoutMs`) is no longer than the one that ran out; a cached failure says
 * so in a diagnostic (a result) or its message (a throw). A store holding entries of an older cache format is cleared
 * on first use. The store's failures never fail a request: the backend
 * answers instead. A store can be shared by several backends; dispose() doesn't close it.
 */
export class CachedTessellator implements Tessellator {
  readonly memoryBytes?: () => number;
  private readonly inner: Tessellator;
  private readonly store: CacheStore;
  private readonly opts: CachedTessellatorOptions;
  private counts: CacheStats = { hits: 0, failureHits: 0, misses: 0, errors: 0 };
  private pruned = new Map<string, Promise<void>>();
  private swept?: Promise<void>;

  constructor(inner: Tessellator, store: CacheStore, opts: CachedTessellatorOptions = {}) {
    this.inner = inner;
    this.store = store;
    this.opts = opts;
    if (inner.memoryBytes) this.memoryBytes = () => inner.memoryBytes!();
  }

  get info(): TessellatorInfo {
    return this.inner.info;
  }

  get timeoutMs(): number | undefined {
    return this.inner.timeoutMs;
  }

  init(opts?: Record<string, unknown>): Promise<void> {
    return this.inner.init(opts);
  }

  async tessellate(req: TessellationRequest): Promise<TessellationResult> {
    if (this.store.maxBytes <= 0) return this.inner.tessellate(req);
    const info = this.inner.info;
    await this.sweep();
    if (!this.opts.keepOtherVersions) await this.prune(await keyPrefix(info));
    const key = await cacheKey(info, req);
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.store.get(key);
    } catch {
      this.counts.errors++;
    }
    let entry: CacheEntry | undefined;
    if (bytes) {
      try {
        entry = decodeEntry(bytes);
      } catch {
        this.counts.errors++;
        await this.store.delete(key).catch(() => {});
      }
    }
    if (entry && this.reusable(entry, req)) {
      this.counts.hits++;
      if (isFailure(entry)) this.counts.failureHits++;
      return answer(entry, req);
    }
    this.counts.misses++;
    let r: TessellationResult;
    try {
      r = await this.inner.tessellate(req);
    } catch (e) {
      if (e instanceof TessellationError) await this.put(key,
        { at: Date.now(), thrown: e.timeoutMs === undefined ? { message: e.message } : { message: e.message,
        timeoutMs: e.timeoutMs } });
      else if (e instanceof WebAssembly.RuntimeError) await this.put(key,
        { at: Date.now(), thrown: { message: `${e.name}: ${e.message}` } });
      throw e;
    }
    await this.put(key, { at: Date.now(), result: r, edges: req.edges ?? false, measures: req.measures ?? false });
    return r;
  }

  /** Hits, misses and store failures since construction. */
  stats(): CacheStats {
    return { ...this.counts };
  }

  dispose(): void {
    this.inner.dispose();
  }

  /**
   * Whether an entry answers a request: a result if its request asked for at least the edges and measures this one
   * does (a backend that gave none when asked had none to give: a part without faces, a backend that can't measure),
   * else the part is meshed again and the new entry replaces it; a failure, as the options and time limit say (edges
   * and measures don't change how meshing fails).
   */
  private reusable(e: CacheEntry, req: TessellationRequest): boolean {
    if ('result' in e && !isFailure(e)) return (!req.edges || e.edges) && (!req.measures || e.measures);
    if (this.opts.retryFailures) return false;
    const ran = 'thrown' in e ? e.thrown.timeoutMs : undefined;
    if (ran === undefined) return true;
    const limit = this.inner.timeoutMs;
    return limit !== undefined && limit > 0 && limit <= ran;
  }

  private async put(key: string, e: CacheEntry): Promise<void> {
    try {
      await this.store.set(key, encodeEntry(e));
    } catch {
      this.counts.errors++;
    }
  }

  /**
   * Clears the store if it holds any entry of an older cache format (a key without `FORMAT_TAG`), once per
   * CachedTessellator: they'd never be read again, and other backends' would never be pruned.
   */
  private sweep(): Promise<void> {
    this.swept ??= (async () => {
      let old = false;
      await this.store.deleteWhere((k) => { if (!k.startsWith(FORMAT_TAG)) old = true; return false; });
      if (old) await this.store.clear();
    })().catch(() => { this.counts.errors++; });
    return this.swept;
  }

  /** Deletes the entries of the backend's other versions, once per version seen. */
  private prune(p: { backend: string; version: string }): Promise<void> {
    let done = this.pruned.get(p.version);
    if (!done) {
      done = this.store.deleteWhere((k) => k.startsWith(p.backend) && !k.startsWith(p.version)).catch(
        () => { this.counts.errors++; });
      this.pruned.set(p.version, done);
    }
    return done;
  }
}

/**
 * A cached entry as the backend's answer to the request: the result (without edges if the request didn't ask for
 * them, as the backend gives it), or the error thrown again, a failure saying it's from the cache.
 */
function answer(e: CacheEntry, req: TessellationRequest): TessellationResult {
  const when = new Date(e.at).toISOString();
  if ('thrown' in e) throw new TessellationError(
    `${e.thrown.message} (a cached failure from ${when}; retryFailures retries it)`, e.thrown.timeoutMs);
  let r = e.result;
  if (!req.edges && (r.edges || r.edgePositions)) {
    const { edges: _e, edgePositions: _p, ...rest } = r;
    r = rest;
  }
  if (!isFailure(e)) return r;
  return { ...r, diagnostics: [...r.diagnostics,
    { severity: 'info', message: `a cached failure from ${when}; retryFailures retries it` }] };
}
