// The cache in front of the real backends, on this thread and in a worker pool (needs the built modules,
// packages/tess-occt/build.sh and packages/tess-truck/build.sh, and the corpus, test_corpus/third_party/pull.sh;
// skipped without them), and in front of a pool of tess-workers' fake backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { TessellationError, tessellateScene, type TessellationRequest, type Tessellator } from 'cad-scene';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { TruckTessellator } from 'tess-truck';
import { WorkerTessellator } from 'tess-workers';
import { CachedTessellator, FileStore, MemoryStore } from 'tess-cache';

const root = path.resolve(import.meta.dirname, '../../..');
const file = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const built = ['packages/tess-occt/dist/occt_tess.wasm', 'packages/tess-truck/dist/tess_truck.wasm'].every((f) => fs.existsSync(path.join(root, f)));
const skip = !built ? 'backends not built' : !fs.existsSync(file) ? 'corpus not fetched' : false;
const opts = { linearDeflection: 0.5, angularDeflection: 0.5, edges: true };

test("each backend's results from a directory, in a new process's store, equal the backend's own", { skip }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { scene } = await importStep(fs.readFileSync(file));
  for (const C of [OcctTessellator, TruckTessellator]) {
    const direct: Tessellator = new C();
    await direct.init();
    assert.match(direct.info.version, /, wasm [0-9a-f]{12}(, adapter \d+)?$/);
    const expected = await tessellateScene(scene, direct, opts);
    assert.ok(expected.meshes.size >= 5, `${direct.info.name}: ${expected.meshes.size} meshes`);
    const first = new CachedTessellator(direct, new FileStore({ dir }));
    assert.deepEqual(await tessellateScene(scene, first, opts), expected);
    const second = new CachedTessellator(direct, new FileStore({ dir }));
    assert.deepEqual(await tessellateScene(scene, second, opts), expected);
    assert.deepEqual(second.stats(), { hits: expected.meshes.size, failureHits: 0, misses: 0, errors: 0 });
    direct.dispose();
  }
});

test('in front of a worker pool, a cached part never reaches a worker', { skip }, async () => {
  const { scene } = await importStep(fs.readFileSync(file));
  const pool = new WorkerTessellator({ backend: { module: import.meta.resolve('tess-occt'), export: 'OcctTessellator' }, workers: 2 });
  let sent = 0;
  const counted: Tessellator = { get info() { return pool.info; }, init: () => pool.init(), tessellate: (r) => (sent++, pool.tessellate(r)), dispose: () => pool.dispose() };
  const t = new CachedTessellator(counted, new MemoryStore());
  await t.init();
  try {
    assert.match(t.info.version, /^OCCT .*, wasm [0-9a-f]{12}, adapter \d+$/);
    const a = await tessellateScene(scene, t, { ...opts, concurrency: 2 });
    const n = sent;
    assert.ok(n >= 5);
    const b = await tessellateScene(scene, t, { ...opts, concurrency: 2 });
    assert.equal(sent, n);
    assert.deepEqual(b, a);
    await tessellateScene(scene, t, { ...opts, linearDeflection: 0.25, concurrency: 2 });
    assert.equal(sent, 2 * n);
  } finally {
    t.dispose();
  }
});

test("through a worker pool, timeouts and traps are cached, a worker's exit isn't, and a longer limit retries a timeout", async () => {
  const backend = { module: import.meta.resolve('../../tess-workers/test/fake-backend.ts'), export: 'FakeTessellator' };
  const req = (...data: number[]): TessellationRequest => ({ format: 'step', data: new Uint8Array(data), linearDeflection: 0.1, angularDeflection: 0.5 });
  const store = new MemoryStore();
  const counting = (timeoutMs: number) => {
    const pool = new WorkerTessellator({ backend, workers: 1, timeoutMs });
    const c = { sent: 0 };
    const t: Tessellator = { get info() { return pool.info; }, get timeoutMs() { return pool.timeoutMs; }, init: () => pool.init(), tessellate: (r) => (c.sent++, pool.tessellate(r)), dispose: () => pool.dispose() };
    return Object.assign(new CachedTessellator(t, store), { c });
  };
  const a = counting(300);
  await a.init();
  try {
    for (let i = 0; i < 2; i++) {
      await assert.rejects(a.tessellate(req(1)), (e) => e instanceof TessellationError && e.timeoutMs === 300);
      await assert.rejects(a.tessellate(req(2)), (e) => e instanceof TessellationError && /RuntimeError: unreachable/.test(e.message));
      await assert.rejects(a.tessellate(req(5)), (e) => !(e instanceof TessellationError) && /exited with code 3/.test((e as Error).message));
    }
    assert.equal(a.c.sent, 4);
    assert.deepEqual(a.stats(), { hits: 2, failureHits: 2, misses: 4, errors: 0 });
  } finally {
    a.dispose();
  }
  const b = counting(600);
  await b.init();
  try {
    const t0 = performance.now();
    await assert.rejects(b.tessellate(req(1)), (e) => e instanceof TessellationError && e.timeoutMs === 600 && !/cached/.test(e.message));
    assert.ok(performance.now() - t0 >= 550);
    await assert.rejects(b.tessellate(req(2)), /cached/);
    assert.equal(b.c.sent, 1);
  } finally {
    b.dispose();
  }
  // The 600 ms timeout replaced the 300 ms one, so a pool with a 300 ms limit again doesn't retry.
  const c = counting(300);
  await c.init();
  try {
    await assert.rejects(c.tessellate(req(1)), (e) => e instanceof TessellationError && e.timeoutMs === 600 && /cached/.test(e.message));
    assert.equal(c.c.sent, 0);
  } finally {
    c.dispose();
  }
});
