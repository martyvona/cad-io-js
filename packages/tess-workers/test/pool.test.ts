import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TessellationError, type TessellationRequest } from 'cad-scene';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolTessellator, spawnNodeWorker, WorkerTessellator, type PoolOptions } from '../src/node.ts';

const backend = { module: new URL('./fake-backend.ts', import.meta.url).href, export: 'FakeTessellator' };
const req = (...data: number[]): TessellationRequest => ({ format: 'step', data: new Uint8Array(data), rootId: 7, origin: [1, 2, 3], linearDeflection: 0.1, angularDeflection: 0.5 });
const instance = (r: { diagnostics: { message: string }[] }) => r.diagnostics[0]!.message;

async function pool(opts: PoolOptions & { options?: Record<string, unknown> } = {}) {
  const t = new WorkerTessellator({ ...opts, backend: { ...backend, options: opts.options } });
  await t.init();
  return t;
}

test('results come back whole, with the backend info, and requests run in parallel across workers', async () => {
  const t = await pool({ workers: 2 });
  try {
    assert.equal(t.info.name, 'fake');
    const rs = await Promise.all([1, 2, 3, 4].map(() => t.tessellate(req(4, 20))));
    for (const r of rs) {
      assert.ok(r.positions instanceof Float32Array && r.indices instanceof Uint32Array);
      assert.deepEqual([...r.indices], [0, 1, 2]);
      assert.deepEqual(r.origin, [1, 2, 3]);
      assert.deepEqual(r.faces, [{ entityId: 7, start: 0, count: 3 }]);
    }
    // Four 200 ms requests on two workers: both workers took some.
    assert.equal(new Set(rs.map(instance)).size, 2);
  } finally {
    t.dispose();
  }
});

test('a request that hangs times out, and the next one gets a new worker', async () => {
  const t = await pool({ workers: 1, timeoutMs: 300 });
  try {
    const before = instance(await t.tessellate(req(0)));
    await assert.rejects(t.tessellate(req(1)), (e) => e instanceof TessellationError && /timed out after 300 ms/.test(e.message) && e.timeoutMs === 300);
    assert.equal(t.timeoutMs, 300);
    const after = instance(await t.tessellate(req(0)));
    assert.notEqual(after, before);
  } finally {
    t.dispose();
  }
});

test('a backend error rejects the request and replaces the worker; requests queued behind it still run', async () => {
  const t = await pool({ workers: 1 });
  try {
    const before = instance(await t.tessellate(req(0)));
    const [bad, good] = await Promise.allSettled([t.tessellate(req(2)), t.tessellate(req(0))]);
    assert.equal(bad.status, 'rejected');
    assert.match((bad as PromiseRejectedResult).reason.message, /RuntimeError: unreachable/);
    assert.ok((bad as PromiseRejectedResult).reason instanceof TessellationError);
    assert.equal((bad as PromiseRejectedResult).reason.timeoutMs, undefined);
    assert.equal(good.status, 'fulfilled');
    assert.notEqual(instance((good as PromiseFulfilledResult<{ diagnostics: { message: string }[] }>).value), before);
  } finally {
    t.dispose();
  }
});

test("only the part's failures reject with a TessellationError, which keeps its time limit across the worker", async () => {
  const t = await pool({ workers: 1 });
  try {
    await assert.rejects(t.tessellate(req(6)), (e) => /Error: ordinary/.test((e as Error).message) && !(e instanceof TessellationError));
    await assert.rejects(t.tessellate(req(7)), (e) => e instanceof TessellationError && /own limit/.test(e.message) && e.timeoutMs === 50);
    assert.equal(t.timeoutMs, 120_000);
  } finally {
    t.dispose();
  }
});

test('a worker that exits rejects its request, and the pool carries on', async () => {
  const t = await pool({ workers: 1 });
  try {
    const exit = t.tessellate(req(5));
    const queued = t.tessellate(req(0));
    await assert.rejects(exit, (e) => /worker exited with code 3/.test((e as Error).message) && !(e instanceof TessellationError));
    assert.deepEqual([...(await queued).indices], [0, 1, 2]);
    assert.deepEqual([...(await t.tessellate(req(0))).indices], [0, 1, 2]);
  } finally {
    t.dispose();
  }
});

test('workers are recycled after maxPartsPerWorker parts', async () => {
  const t = await pool({ workers: 1, maxPartsPerWorker: 2 });
  try {
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(instance(await t.tessellate(req(0))));
    assert.equal(ids[0], ids[1]);
    assert.notEqual(ids[1], ids[2]);
    assert.equal(ids[2], ids[3]);
    assert.notEqual(ids[3], ids[4]);
  } finally {
    t.dispose();
  }
});

test('workers are recycled once the backend reports more than maxMemoryBytes', async () => {
  const t = await pool({ workers: 1, maxMemoryBytes: 3 * 2 ** 20 });
  try {
    const a = instance(await t.tessellate(req(3, 2)));
    const b = instance(await t.tessellate(req(3, 2))); // now 4 MiB: retired after this result
    const c = instance(await t.tessellate(req(3, 2)));
    assert.equal(a, b);
    assert.notEqual(b, c);
  } finally {
    t.dispose();
  }
});

test('a backend that fails to load rejects init, and so does a missing export', async () => {
  await assert.rejects(pool({ options: { fail: true } }), /backend init failed: Error: init refused/);
  const t = new WorkerTessellator({ backend: { ...backend, export: 'Nope' } });
  await assert.rejects(t.init(), /has no export 'Nope'/);
  t.dispose();
});

test('dispose rejects pending requests; requests before init and after dispose are refused', async () => {
  const fresh = new WorkerTessellator({ backend });
  await assert.rejects(fresh.tessellate(req(0)), /call init\(\) first/);
  assert.throws(() => fresh.info, /call init\(\) first/);
  const t = await pool({ workers: 1, timeoutMs: 0 });
  const pending = [t.tessellate(req(1)), t.tessellate(req(0))];
  t.dispose();
  for (const p of pending) await assert.rejects(p, /disposed/);
  await assert.rejects(t.tessellate(req(0)), /disposed/);
});

test("when a replacement worker can't load the backend, queued requests fail instead of respawning forever", async () => {
  let spawns = 0;
  const t = new PoolTessellator(() => { spawns++; return spawnNodeWorker(); }, { backend: { ...backend, options: { failAfter: Date.now() + 500 } }, workers: 1, maxPartsPerWorker: 1 });
  await t.init();
  try {
    await t.tessellate(req(0)); // the first worker retires after this
    await new Promise((r) => setTimeout(r, 600));
    const queued = [t.tessellate(req(0)), t.tessellate(req(0)), t.tessellate(req(0))];
    for (const p of queued) await assert.rejects(p, /backend init failed: Error: init refused/);
    assert.equal(spawns, 2);
    // A later request tries one worker again.
    await assert.rejects(t.tessellate(req(0)), /init refused/);
    assert.equal(spawns, 3);
  } finally {
    t.dispose();
  }
});

test('while another worker is busy, a replacement that fails to load is not retried until that worker is done', async () => {
  let spawns = 0;
  const t = new PoolTessellator(() => { spawns++; return spawnNodeWorker(); }, { backend: { ...backend, options: { failAfter: Date.now() + 500 } }, workers: 2, maxPartsPerWorker: 1 });
  await t.init();
  try {
    await new Promise((r) => setTimeout(r, 600));
    const busy = t.tessellate(req(4, 50)); // 500 ms on the first worker, which then retires
    const queued = [t.tessellate(req(0)), t.tessellate(req(0))];
    await busy;
    for (const p of queued) await assert.rejects(p, /init refused/);
    // The first worker, one replacement while it was busy, and one more once no worker was left.
    assert.equal(spawns, 3);
  } finally {
    t.dispose();
  }
});

test("idle workers don't keep Node running when the pool isn't disposed", () => {
  const script = `
    import { WorkerTessellator } from ${JSON.stringify(new URL('../src/node.ts', import.meta.url).href)};
    const t = new WorkerTessellator({ backend: ${JSON.stringify(backend)}, workers: 2 });
    await t.init();
    const req = { format: 'step', data: new Uint8Array([0]), linearDeflection: 0.1, angularDeflection: 0.5 };
    await Promise.all([t.tessellate(req), t.tessellate(req)]);
    console.log('done');`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-workers-'));
  const file = path.join(dir, 'undisposed.mjs');
  fs.writeFileSync(file, script);
  try {
    const out = execFileSync(process.execPath, [file], { timeout: 10_000, encoding: 'utf8' });
    assert.equal(out.trim(), 'done');
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test('workers start whatever flags the process has: process-wide ones, and --input-type with node -e', () => {
  const script = `
    import { WorkerTessellator } from ${JSON.stringify(new URL('../src/node.ts', import.meta.url).href)};
    const t = new WorkerTessellator({ backend: ${JSON.stringify(backend)}, workers: 1 });
    await t.init();
    await t.tessellate({ format: 'step', data: new Uint8Array([0]), linearDeflection: 0.1, angularDeflection: 0.5 });
    t.dispose();
    console.log('done');`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tess-workers-'));
  const file = path.join(dir, 'flags.mjs');
  fs.writeFileSync(file, script);
  const flags = ['--max-old-space-size=4096', '--stack-size=2000'];
  try {
    for (const args of [[...flags, file], [...flags, '--input-type=module', '-e', script], ['--input-type=module', '-e', script]]) {
      const out = execFileSync(process.execPath, args, { timeout: 20_000, encoding: 'utf8' });
      assert.equal(out.trim(), 'done', args.slice(0, 3).join(' '));
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
