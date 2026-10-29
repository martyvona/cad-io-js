// Caching tessellation results per part: a Tessellator that answers from a store when it has seen the request, keyed
// by a hash of the payload, the backend's name and version, and the request's options. Failures are cached too.

import { sha256 as digest, TessellationError, type TessellationRequest, type TessellationResult, type Tessellator,
  type TessellatorInfo } from 'cad-scene';

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
const FORMAT = 3;
const MAGIC = 0x33524354; // "TCR3", little-endian

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array<ArrayBuffer>) => hex(await digest(b));

/**
 * The start of a backend's keys: `<name>_` for every version of the backend (its name in lower case, other characters
 * than letters and digits as `-`, at most 32), then `<version>_` for this version (12 hex digits of a hash of the
 * cache format, the name and the version).
 */
export async function keyPrefix(info: TessellatorInfo): Promise<{ backend: string; version: string }> {
  const backend = `${info.name.toLowerCase().replace(/[^0-9a-z]+/g, '-').slice(0, 32) || '-'}_`;
  const version = (await sha256(
    new TextEncoder().encode(JSON.stringify([FORMAT, info.name, info.version])))).slice(0, 12);
  return { backend, version: `${backend}${version}_` };
}

/**
 * The key for a request to a backend: the backend's prefix (`keyPrefix`), then SHA-256 (hex) over the cache format,
 * the backend's name and version, the request's options and its payload.
 */
export async function cacheKey(info: TessellatorInfo, req: TessellationRequest): Promise<string> {
  const head = new TextEncoder().encode(JSON.stringify([
    FORMAT, info.name, info.version, req.format, req.rootId ?? null, req.origin ?? [0, 0, 0],
    req.linearDeflection, req.angularDeflection, req.edges ?? false,
  ]));
  const all = new Uint8Array(head.length + 1 + req.data.length);
  all.set(head);
  all.set(req.data, head.length + 1);
  return `${(await keyPrefix(info)).version}${await sha256(all)}`;
}

/**
 * What a cache holds for a request, and when (milliseconds since the epoch): the backend's result, or the
 * TessellationError (or WebAssembly trap) the request threw, with its time limit if it ran out of time.
 */
export type CacheEntry =
  | { at: number; result: TessellationResult }
  | { at: number; thrown: { message: string; timeoutMs?: number } };

type Header = Partial<Pick<TessellationResult, 'origin' | 'faces' | 'edges' | 'curves' | 'pointIds'
  | 'outlines' | 'diagnostics'>> & {
  at: number;
  thrown?: { message: string; timeoutMs?: number };
  /**
   * Lengths of positions, normals, indices, edgePositions, curvePositions, points, outlinePositions (-1: absent; the
   * last missing in entries before 2026-10-28).
   */
  n: [number, number, number, number, number, number, number?];
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
    Object.assign(header, { origin: r.origin, faces: r.faces, diagnostics: r.diagnostics },
      r.edges ? { edges: r.edges } : {});
    Object.assign(header, r.curves ? { curves: r.curves } : {}, r.pointIds ? { pointIds: r.pointIds } : {},
      r.outlines ? { outlines: r.outlines } : {});
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
  const [np, nn, ni, ne, nc, nq, no = -1] = header.n;
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
  return { at: header.at, result: r };
}

const align = (n: number) => (n + 3) & ~3;

/** Whether an entry records a failure: a request that threw, or a result with an error diagnostic. */
export const isFailure = (e: CacheEntry) => 'thrown' in e || e.result.diagnostics.some((d) => d.severity === 'error');

export interface CachedTessellatorOptions {
  /** Send requests whose cached entry is a failure to the backend again (and cache what it answers). Default false. */
  retryFailures?: boolean;
  /**
   * Keep the entries of this backend's other versions. By default they're deleted when the cache first sees a version
   * (once per CachedTessellator), since they'd never be read again; other backends' entries are kept either way.
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
 * A Tessellator that caches `inner`'s results in `store`, failures included: results with an error diagnostic, and
 * requests that throw a TessellationError (`cad-scene`; the worker pool's timeouts and backend traps) or a WebAssembly
 * trap. Other errors (a worker that died, a pool disposed) aren't the part's, and aren't cached. A cached timeout
 * answers only when `inner`'s time limit (`timeoutMs`) is no longer than the one that ran out; a cached failure says
 * so in a diagnostic (a result) or its message (a throw). The store's failures never fail a request: the backend
 * answers instead. A store can be shared by several backends; dispose() doesn't close it.
 */
export class CachedTessellator implements Tessellator {
  readonly memoryBytes?: () => number;
  private readonly inner: Tessellator;
  private readonly store: CacheStore;
  private readonly opts: CachedTessellatorOptions;
  private counts: CacheStats = { hits: 0, failureHits: 0, misses: 0, errors: 0 };
  private pruned = new Map<string, Promise<void>>();

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
    if (entry && this.reusable(entry)) {
      this.counts.hits++;
      if (isFailure(entry)) this.counts.failureHits++;
      return answer(entry);
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
    await this.put(key, { at: Date.now(), result: r });
    return r;
  }

  /** Hits, misses and store failures since construction. */
  stats(): CacheStats {
    return { ...this.counts };
  }

  dispose(): void {
    this.inner.dispose();
  }

  private reusable(e: CacheEntry): boolean {
    if (!isFailure(e)) return true;
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

/** A cached entry as the backend's answer: the result, or the error thrown again, each saying it's from the cache. */
function answer(e: CacheEntry): TessellationResult {
  const when = new Date(e.at).toISOString();
  if ('thrown' in e) throw new TessellationError(
    `${e.thrown.message} (a cached failure from ${when}; retryFailures retries it)`, e.thrown.timeoutMs);
  if (!isFailure(e)) return e.result;
  return { ...e.result, diagnostics: [...e.result.diagnostics,
    { severity: 'info', message: `a cached failure from ${when}; retryFailures retries it` }] };
}
