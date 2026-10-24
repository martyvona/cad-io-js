import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { TessellationError, type Diagnostic, type TessellationRequest, type TessellationResult, type Tessellator,
  type TessellatorInfo } from 'cad-scene';
import { CachedTessellator, cacheKey, decodeEntry, encodeEntry, keyPrefix, MemoryStore, type CacheEntry,
  type CacheStore } from 'tess-cache';

const result = (full: boolean, diagnostics: Diagnostic[] = []): TessellationResult => {
  const r: TessellationResult = {
    origin: [1, 2, 3],
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1.5, 0]),
    indices: new Uint32Array([0, 1, 2]),
    faces: [{ entityId: 12, start: 0, count: 3 }],
    diagnostics,
  };
  if (full) {
    r.normals = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, -1]);
    r.edgePositions = new Float32Array([0, 0, 0, 1, 0, 0]);
    r.edges = [{ entityId: null, start: 0, count: 2, kind: 'seam', dihedral: 0.25 }];
    r.curvePositions = new Float32Array([0, 0, 1, 1, 0, 1, 1, 1, 1]);
    r.curves = [{ entityId: 40, start: 0, count: 2 }, { entityId: null, start: 2, count: 1 }];
    r.points = new Float32Array([5, 6, 7]);
    r.pointIds = [41];
  }
  return r;
};

const resultOf = (e: CacheEntry) => (e as { result: TessellationResult }).result;

test('a result survives encoding, with or without normals, edges, curves and points, in arrays of its own', () => {
  for (const full of [false, true]) {
    const r = result(full, [{ severity: 'warning', message: 'w', source: { format: 'step', id: 7 } }]);
    const bytes = encodeEntry({ at: 1234, result: r });
    const back = decodeEntry(bytes);
    assert.deepEqual(back, { at: 1234, result: r });
    assert.equal('normals' in resultOf(back), full);
    assert.equal('edges' in resultOf(back), full);
    assert.equal('curves' in resultOf(back) && 'points' in resultOf(back), full);
    resultOf(back).positions[0] = 99;
    assert.equal(resultOf(decodeEntry(bytes)).positions[0], 0);
    // Decoding works on a view into a larger buffer, at any offset.
    const shifted = new Uint8Array(bytes.length + 3);
    shifted.set(bytes, 3);
    assert.deepEqual(decodeEntry(shifted.subarray(3)), { at: 1234, result: r });
  }
});

test('a thrown error survives encoding, with or without its time limit', () => {
  for (const thrown of [{ message: 'RuntimeError: unreachable' }, { message: 'timed out', timeoutMs: 500 }]) {
    assert.deepEqual(decodeEntry(encodeEntry({ at: 5, thrown })), { at: 5, thrown });
  }
});

test("bytes that aren't a whole encoded entry don't decode", () => {
  const bytes = encodeEntry({ at: 0, result: result(true) });
  assert.throws(() => decodeEntry(bytes.subarray(0, bytes.length - 4)), /truncated/);
  assert.throws(() => decodeEntry(new Uint8Array([...bytes, 0, 0, 0, 0])), /truncated/);
  assert.throws(() => decodeEntry(new Uint8Array(bytes.length)), /not a cache entry/);
  assert.throws(() => decodeEntry(new Uint8Array(3)), /not a cache entry/);
  const thrown = encodeEntry({ at: 0, thrown: { message: 'x' } });
  assert.throws(() => decodeEntry(new Uint8Array([...thrown, 0, 0, 0, 0])), /truncated/);
});

const info: TessellatorInfo = { name: 'fake', version: '1', license: 'MIT', formats: ['step'], supportsFaceIds: true,
  supportsEdges: true, supportsCurves: true };
const req: TessellationRequest = { format: 'step', data: new Uint8Array([1, 2, 3]), rootId: 5, origin: [1, 2, 3],
  linearDeflection: 0.1, angularDeflection: 0.5, edges: true };

test('keys are the same where crypto.subtle is missing (insecure contexts), and are SHA-256', async () => {
  const k = await cacheKey(info, req);
  const p = await keyPrefix(info);
  const own = Object.getOwnPropertyDescriptor(globalThis, 'crypto')!;
  Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true });
  try {
    assert.equal(await cacheKey(info, req), k);
    assert.deepEqual(await keyPrefix(info), p);
  } finally { Object.defineProperty(globalThis, 'crypto', own); }
  const prefix = createHash('sha256').update(JSON.stringify([3, 'fake', '1'])).digest('hex').slice(0, 12);
  assert.equal(p.version, `fake_${prefix}_`);
});

test('the key changes with the backend, every request option and the payload, and only with them', async () => {
  const k = await cacheKey(info, req);
  assert.match(k, /^fake_[0-9a-f]{12}_[0-9a-f]{64}$/);
  const p = await keyPrefix(info);
  assert.equal(p.backend, 'fake_');
  assert.ok(k.startsWith(p.version) && p.version.startsWith(p.backend));
  assert.equal((await keyPrefix({ ...info, version: '2' })).backend, 'fake_');
  assert.notEqual((await keyPrefix({ ...info, version: '2' })).version, p.version);
  assert.equal((await keyPrefix({ ...info, name: 'OCCT 8.1 (x)_y' })).backend, 'occt-8-1-x-y_');
  assert.equal((await keyPrefix({ ...info, name: '' })).backend, '-_');
  assert.equal((await keyPrefix({ ...info, name: 'a'.repeat(40) })).backend, `${'a'.repeat(32)}_`);
  assert.equal(await cacheKey({ ...info }, { ...req, data: new Uint8Array([1, 2, 3]) }), k);
  const changed: [TessellatorInfo, TessellationRequest][] = [
    [{ ...info, name: 'other' }, req],
    [{ ...info, version: '2' }, req],
    [info, { ...req, format: 'iges' }],
    [info, { ...req, rootId: 6 }],
    [info, { ...req, rootId: undefined }],
    [info, { ...req, origin: [1, 2, 4] }],
    [info, { ...req, origin: undefined }],
    [info, { ...req, linearDeflection: 0.2 }],
    [info, { ...req, angularDeflection: 0.4 }],
    [info, { ...req, edges: false }],
    [info, { ...req, data: new Uint8Array([1, 2, 4]) }],
    [info, { ...req, data: new Uint8Array([1, 2]) }],
  ];
  const keys = await Promise.all(changed.map(([i, r]) => cacheKey(i, r)));
  assert.equal(new Set([k, ...keys]).size, changed.length + 1);
  // Defaults are spelled out: no origin is (0, 0, 0), no edges is false.
  assert.equal(await cacheKey(info, { ...req, origin: undefined }),
    await cacheKey(info, { ...req, origin: [0, 0, 0] }));
  assert.equal(await cacheKey(info, { ...req, edges: undefined }), await cacheKey(info, { ...req, edges: false }));
});

/**
 * A backend that counts its requests. The payload's first byte picks a result (0), an error diagnostic (1), an ordinary
 * throw (2), a TessellationError (3), a WebAssembly trap (4), or running out of a time limit of data[1] x 10 ms (5).
 */
class Fake implements Tessellator {
  info = { ...info };
  calls = 0;
  disposed = false;
  initOpts: unknown;
  timeoutMs?: number;
  async init(opts?: Record<string, unknown>) { this.initOpts = opts; }
  async tessellate(r: TessellationRequest): Promise<TessellationResult> {
    this.calls++;
    const [mode, arg = 0] = r.data;
    if (mode === 2) throw new Error('boom');
    if (mode === 3) throw new TessellationError('bad part');
    if (mode === 4) throw new WebAssembly.RuntimeError('unreachable');
    if (mode === 5) throw new TessellationError('timed out', arg * 10);
    return result(true, mode === 1 ? [{ severity: 'error', message: 'panicked' }] : [
      { severity: 'info', message: `call ${this.calls}` }]);
  }
  memoryBytes() { return 42; }
  dispose() { this.disposed = true; }
}

const r0 = (...extra: number[]) => ({ ...req, data: new Uint8Array([0, ...extra]) });

test('a repeated request is answered from the store, and a different one by the backend', async () => {
  const fake = new Fake();
  const t = new CachedTessellator(fake, new MemoryStore());
  await t.init({ a: 1 });
  assert.deepEqual(fake.initOpts, { a: 1 });
  assert.equal(t.info, fake.info);
  assert.equal(t.memoryBytes?.(), 42);
  const a = await t.tessellate(r0());
  const b = await t.tessellate(r0());
  assert.equal(fake.calls, 1);
  assert.deepEqual(b, a);
  assert.notEqual(b.positions, a.positions);
  await t.tessellate({ ...r0(), linearDeflection: 0.2 });
  await t.tessellate(r0(9));
  assert.equal(fake.calls, 3);
  // A new backend version (a rebuilt module) misses.
  fake.info.version = '2';
  await t.tessellate(r0());
  assert.equal(fake.calls, 4);
  assert.deepEqual(t.stats(), { hits: 1, failureHits: 0, misses: 4, errors: 0 });
  t.dispose();
  assert.ok(fake.disposed);
  const plain: Tessellator = { info, init: async () => {}, tessellate: (q) => fake.tessellate(q), dispose: () => {} };
  assert.equal(new CachedTessellator(plain, new MemoryStore()).memoryBytes, undefined);
});

const data = (...d: number[]) => ({ ...req, data: new Uint8Array(d) });
const cachedNote = /^a cached failure from \d{4}-\d\d-\d\dT[\d:.]+Z; retryFailures retries it$/;

test("failures are cached: error results, TessellationErrors and traps, each said to be cached; other throws aren't",
  async () => {
  const fake = new Fake();
  const store = new MemoryStore();
  const t = new CachedTessellator(fake, store);
  const first = await t.tessellate(data(1));
  assert.deepEqual(first.diagnostics, [{ severity: 'error', message: 'panicked' }]);
  const again = await t.tessellate(data(1));
  assert.equal(fake.calls, 1);
  assert.deepEqual(again.diagnostics.slice(0, 1), first.diagnostics);
  assert.equal(again.diagnostics.length, 2);
  assert.equal(again.diagnostics[1]!.severity, 'info');
  assert.match(again.diagnostics[1]!.message, cachedNote);
  assert.deepEqual({ ...again, diagnostics: first.diagnostics }, first);
  for (const [mode, message] of [[3, 'bad part'], [4, 'RuntimeError: unreachable']] as const) {
    await assert.rejects(t.tessellate(data(mode)),
      (e) => (e as Error).message === (mode === 3 ? 'bad part' : 'unreachable'));
    const calls: number = fake.calls;
    await assert.rejects(t.tessellate(data(mode)), (e) => e instanceof TessellationError && e.timeoutMs === undefined
      && e.message.startsWith(`${message} (a cached failure from `) && e.message.endsWith(
        '; retryFailures retries it)'));
    assert.equal(fake.calls, calls);
  }
  for (let i = 0; i < 2; i++) await assert.rejects(t.tessellate(data(2)), /^Error: boom$/);
  assert.equal(fake.calls, 5);
  // A success read back carries no note.
  await t.tessellate(data(0));
  assert.deepEqual((await t.tessellate(data(0))).diagnostics, [{ severity: 'info', message: 'call 6' }]);
  assert.deepEqual(t.stats(), { hits: 4, failureHits: 3, misses: 6, errors: 0 });
});

test('retryFailures sends cached failures to the backend again, and caches what it answers', async () => {
  const fake = new Fake();
  const store = new MemoryStore();
  await new CachedTessellator(fake, store).tessellate(data(1));
  await assert.rejects(new CachedTessellator(fake, store).tessellate(data(3)));
  await new CachedTessellator(fake, store).tessellate(data(0));
  const t = new CachedTessellator(fake, store, { retryFailures: true });
  assert.deepEqual((await t.tessellate(data(1))).diagnostics, [{ severity: 'error', message: 'panicked' }]);
  await assert.rejects(t.tessellate(data(3)), (e) => (e as Error).message === 'bad part');
  // Successes still come from the store.
  await t.tessellate(data(0));
  assert.equal(fake.calls, 5);
  assert.deepEqual(t.stats(), { hits: 1, failureHits: 0, misses: 2, errors: 0 });
  // The new answers replaced the old ones.
  const at = async (d: number) => decodeEntry((await store.get(await cacheKey(fake.info, data(d))))!).at;
  const [a1, a3] = [await at(1), await at(3)];
  await new Promise((r) => setTimeout(r, 5));
  await new CachedTessellator(fake, store, { retryFailures: true }).tessellate(data(1));
  await assert.rejects(new CachedTessellator(fake, store, { retryFailures: true }).tessellate(data(3)));
  assert.ok((await at(1)) > a1 && (await at(3)) > a3);
  assert.equal(fake.calls, 7);
});

test("a cached timeout answers only when the backend's time limit is no longer than the one that ran out", async () => {
  const fake = new Fake();
  const store = new MemoryStore();
  fake.timeoutMs = 50;
  const t = new CachedTessellator(fake, store);
  assert.equal(t.timeoutMs, 50);
  await assert.rejects(t.tessellate(data(5, 5)),
    (e) => e instanceof TessellationError && e.timeoutMs === 50 && e.message === 'timed out');
  for (const [limit, sent] of [[50, false], [20, false], [1, false], [51, true], [0, true],
    [undefined, true]] as const) {
    fake.timeoutMs = limit;
    const calls = fake.calls;
    await assert.rejects(t.tessellate(data(5, 5)),
      (e) => e instanceof TessellationError && e.timeoutMs === 50 && /cached/.test(e.message) !== sent);
    assert.equal(fake.calls - calls, sent ? 1 : 0, `limit ${limit}`);
  }
});

test('a request retried under a longer time limit that succeeds replaces the cached timeout', async () => {
  let limit = 10;
  const fake = new Fake();
  const backend: Tessellator = {
    info, init: async () => {}, dispose: () => {}, get timeoutMs() { return limit; },
    tessellate: (r) => (fake.calls++,
      limit < 100 ? Promise.reject(new TessellationError('timed out', limit)) : Promise.resolve(result(false))),
  };
  const t = new CachedTessellator(backend, new MemoryStore());
  await assert.rejects(t.tessellate(req));
  limit = 100;
  assert.deepEqual(await t.tessellate(req), result(false));
  limit = 10;
  assert.deepEqual(await t.tessellate(req), result(false));
  assert.equal(fake.calls, 2);
});

test('a store with maxBytes 0 disables caching: no key computed, nothing stored', async () => {
  const fake = new Fake();
  let touched = 0;
  const store: CacheStore = {
    maxBytes: 0,
    get: async () => { touched++; return undefined; }, set: async () => { touched++; },
    delete: async () => { touched++; }, deleteWhere: async () => { touched++; }, clear: async () => {},
    size: async () => 0,
  };
  const t = new CachedTessellator(fake, store);
  // A backend whose info throws would fail the key; with caching off it's never read.
  Object.defineProperty(fake, 'info', { get: () => { throw new Error('info read'); } });
  await t.tessellate(r0());
  await t.tessellate(r0());
  assert.equal(fake.calls, 2);
  assert.equal(touched, 0);
  assert.deepEqual(t.stats(), { hits: 0, failureHits: 0, misses: 0, errors: 0 });
});

test("the store's failures are answered by the backend, and a corrupt entry is deleted", async () => {
  const fake = new Fake();
  const mem = new MemoryStore();
  let failGet = false, failSet = false;
  const store: CacheStore = {
    maxBytes: mem.maxBytes,
    get: (k) => (failGet ? Promise.reject(new Error('read')) : mem.get(k)),
    set: (k, v) => (failSet ? Promise.reject(new Error('write')) : mem.set(k, v)),
    delete: (k) => mem.delete(k), deleteWhere: (d) => mem.deleteWhere(d), clear: () => mem.clear(),
    size: () => mem.size(),
  };
  const t = new CachedTessellator(fake, store);
  failSet = true;
  await t.tessellate(r0());
  failSet = false;
  assert.equal(await mem.size(), 0);
  await t.tessellate(r0());
  failGet = true;
  await t.tessellate(r0());
  failGet = false;
  assert.equal(fake.calls, 3);
  const key = await cacheKey(fake.info, r0());
  await mem.set(key, new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  const r = await t.tessellate(r0());
  assert.equal(r.diagnostics[0]!.message, 'call 4');
  // The corrupt entry was replaced by the backend's result.
  assert.equal(resultOf(decodeEntry((await mem.get(key))!)).diagnostics[0]!.message, 'call 4');
  assert.deepEqual(t.stats(), { hits: 0, failureHits: 0, misses: 4, errors: 3 });
  // Deleted, not just overwritten: with writes failing, nothing is left under the key.
  await mem.set(key, new Uint8Array(8));
  failSet = true;
  await t.tessellate(r0());
  assert.equal(await mem.get(key), undefined);
});

test("a backend's other versions are deleted when a version is first seen, once; other backends' entries stay",
  async () => {
  const store = new MemoryStore();
  let pruning = 0;
  const counted: CacheStore = {
    ...Object.fromEntries((['get', 'set', 'delete', 'clear', 'size'] as const).map(
    (m) => [m, (...a: unknown[]) => (store[m] as (...x: unknown[]) => unknown)(...a)])) as unknown as CacheStore,
    maxBytes: store.maxBytes, deleteWhere: (d) => (pruning++, store.deleteWhere(d)) };
  const v1 = new Fake(), other = new Fake();
  other.info.name = 'other';
  await new CachedTessellator(v1, counted).tessellate(r0(1));
  await new CachedTessellator(v1, counted).tessellate(r0(2));
  await new CachedTessellator(other, counted).tessellate(r0(1));
  // Keys of a backend whose name starts with another's aren't the other's.
  const longer = new Fake();
  longer.info.name = 'fakeish';
  await new CachedTessellator(longer, counted).tessellate(r0(1));
  const [k1, k2, ko, kl] = await Promise.all(
    [cacheKey(v1.info, r0(1)), cacheKey(v1.info, r0(2)), cacheKey(other.info, r0(1)), cacheKey(longer.info, r0(1))]);
  const has = async (k: string) => (await store.get(k)) !== undefined;
  const v2 = new Fake();
  v2.info.version = '2';
  await new CachedTessellator(v2, counted, { keepOtherVersions: true }).tessellate(r0(1));
  assert.ok((await has(k1)) && (await has(k2)));
  pruning = 0;
  const t = new CachedTessellator(v2, counted);
  await Promise.all([t.tessellate(r0(1)), t.tessellate(r0(3))]);
  await t.tessellate(r0(1));
  assert.equal(pruning, 1);
  assert.ok(!(await has(k1)) && !(await has(k2)));
  assert.ok((await has(ko)) && (await has(kl)) && (await has(await cacheKey(v2.info, r0(1)))) && (
    await has(await cacheKey(v2.info, r0(3)))));
  assert.deepEqual(t.stats(), { hits: 2, failureHits: 0, misses: 1, errors: 0 });
  // Back to version 1 in the same tessellator: version 2's entries go.
  v2.info.version = '1';
  await t.tessellate(r0(1));
  assert.equal(pruning, 2);
  assert.ok(!(await has(await cacheKey({ ...v2.info, version: '2' }, r0(3)))));
  // A failure to delete is counted, and the request still answered.
  const failing: CacheStore = { ...counted, deleteWhere: () => Promise.reject(new Error('no')) };
  const f = new CachedTessellator(v2, failing);
  assert.equal((await f.tessellate(r0(1))).diagnostics[0]!.severity, 'info');
  assert.deepEqual(f.stats(), { hits: 1, failureHits: 0, misses: 0, errors: 1 });
});

const bytes = (n: number, fill = 0) => new Uint8Array(n).fill(fill);

test('the memory store evicts the least recently used beyond maxBytes, and skips values larger than that', async () => {
  const s = new MemoryStore(10);
  await s.set('a', bytes(4, 1));
  await s.set('b', bytes(4, 2));
  assert.deepEqual(await s.get('a'), bytes(4, 1));
  await s.set('c', bytes(4, 3));
  assert.equal(await s.get('b'), undefined);
  assert.ok(await s.get('a') && await s.get('c'));
  assert.equal(await s.size(), 8);
  await s.set('a', bytes(2));
  assert.equal(await s.size(), 6);
  await s.set('big', bytes(11));
  assert.equal(await s.get('big'), undefined);
  assert.equal(await s.size(), 6);
  await s.set('d', bytes(4));
  assert.ok(await s.get('c'));
  assert.equal(await s.size(), 10);
  await s.set('e', bytes(1));
  assert.equal(await s.get('a'), undefined);
  assert.equal(await s.size(), 9);
  await s.delete('c');
  assert.equal(await s.size(), 5);
  await s.set('dx', bytes(1));
  await s.deleteWhere((k) => k.startsWith('d'));
  assert.equal(await s.size(), 1);
  assert.ok(await s.get('e'));
  await s.set('d', bytes(4));
  await s.clear();
  assert.equal(await s.size(), 0);
  assert.equal(await s.get('d'), undefined);
  assert.equal(new MemoryStore().maxBytes, 256 * 2 ** 20);
});
