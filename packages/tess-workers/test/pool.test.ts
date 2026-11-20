import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TessellationError, type TessellationRequest } from 'cad-scene';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolTessellator, spawnNodeWorker, WorkerTessellator, type PoolOptions } from '../src/node.ts';

const backend = { module: new URL('./fake-backend.ts', import.meta.url).href, export: 'FakeTessellator' };
const req = (...data: number[]): TessellationRequest => (
  { format: 'step', data: new Uint8Array(data), rootId: 7, origin: [1, 2, 3], linearDeflection: 0.1,
  angularDeflection: 0.5 });
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

const job = { module: backend.module, export: 'fakeJob' };
type JobOut = { input: { mode: string }; values: Float64Array; instance: string };

test('run: a job runs in a worker with its progress, its output whole, alongside tessellation requests', async () => {
  const t = await pool({ workers: 2 });
  try {
    const seen: string[] = [];
    const [a, r, b] = await Promise.all([
      t.run<JobOut>(job, { mode: 'echo', n: 5, progress: 2 }, { onProgress: (m) => seen.push(m) }),
      t.tessellate(req(4, 10)), t.run<JobOut>(job, { mode: 'wait', ms: 100 })]);
    assert.deepEqual(a.input, { mode: 'echo', n: 5, progress: 2 });
    assert.ok(a.values instanceof Float64Array);
    assert.deepEqual([...a.values], [0, 1, 2, 3, 4]);
    assert.deepEqual(seen, ['step 1', 'step 2']);
    assert.deepEqual([...r.indices], [0, 1, 2]);
    assert.equal(b.values.length, 0);
  } finally {
    t.dispose();
  }
});

test('run: a job that throws rejects with its message (not as a part failure), the worker replaced; one that '
  + 'hangs has no timeout of its own unless given one, then names its last progress', async () => {
  const t = await pool({ workers: 1, timeoutMs: 200 });
  try {
    const before = (await t.run<JobOut>(job, { mode: 'echo' })).instance;
    await assert.rejects(t.run(job, { mode: 'throw' }),
      (e) => !(e instanceof TessellationError) && /job refused/.test((e as Error).message));
    assert.notEqual((await t.run<JobOut>(job, { mode: 'echo' })).instance, before);
    // Longer than the pool's 200 ms for parts: not killed.
    assert.equal((await t.run<JobOut>(job, { mode: 'wait', ms: 400 })).input.mode, 'wait');
    await assert.rejects(t.run(job, { mode: 'hang' }, { timeoutMs: 300 }),
      (e) => !(e instanceof TessellationError) && (e as Error).message === 'job fakeJob timed out after 300 ms');
    await assert.rejects(t.run(job, { mode: 'hang', progress: 2 }, { timeoutMs: 300 }),
      (e) => (e as Error).message === 'job fakeJob timed out after 300 ms (last: step 2)');
  } finally {
    t.dispose();
  }
});

test('run: a job limited on CPU time is stopped at the first progress past it, naming it; one waiting with little '
  + 'CPU runs past that limit in wall time', async () => {
  // (The CPU timer off in effect: the progress path alone.)
  const t = await pool({ workers: 1, cpuPollMs: 60_000 });
  try {
    await assert.rejects(t.run(job, { mode: 'spin', ms: 5000 }, { cpuTimeoutMs: 150, timeoutMs: 10_000 }),
      (e) => !(e instanceof TessellationError)
        && /^job fakeJob timed out after 150 ms of CPU time \(last: spin \d+\)$/.test((e as Error).message));
    assert.equal((await t.run<JobOut>(job, { mode: 'idle', ms: 400 }, { cpuTimeoutMs: 150 })).input.mode, 'idle');
    // Without one, the same spin finishes.
    assert.equal((await t.run<JobOut>(job, { mode: 'spin', ms: 300 })).input.mode, 'spin');
  } finally {
    t.dispose();
  }
});

test('run: a job busy without progress is stopped by the CPU timer at its own limit, naming its last message; a job '
  + 'without a limit isn\'t, in a pool whose requests have one', async () => {
  const t = await pool({ workers: 1, cpuTimeoutMs: 100, cpuPollMs: 50 });
  try {
    const t0 = performance.now();
    await assert.rejects(t.run(job, { mode: 'hang', progress: 2 }, { cpuTimeoutMs: 250, timeoutMs: 20_000 }),
      (e) => !(e instanceof TessellationError)
        && (e as Error).message === 'job fakeJob timed out after 250 ms of CPU time (last: step 2)');
    const took = performance.now() - t0;
    assert.ok(took >= 250 && took < 2000, `stopped after ${took} ms`);
    // 400 ms of CPU, past the pool's 100 ms for requests: a job has its own limit, here none.
    assert.equal((await t.run<JobOut>(job, { mode: 'spin', ms: 400 })).input.mode, 'spin');
  } finally {
    t.dispose();
  }
});

test("serve's outputBuffers: each typed array's buffer once, in plain objects and arrays, not in other objects",
  async () => {
  const { outputBuffers } = await import('../src/serve.ts');
  const shared = new ArrayBuffer(16), own = new Float64Array(2);
  const inClass = new (class { a = new Uint8Array(4); })();
  const out = outputBuffers({ a: new Uint8Array(shared, 0, 8), b: [new Int32Array(shared, 8, 2), { c: own }],
    d: shared, e: inClass, f: 'x', g: null });
  assert.deepEqual(out, [shared, own.buffer]);
});

test('run: a missing export rejects; a pool without a backend runs jobs, its info NO_BACKEND', async () => {
  const { NO_BACKEND } = await import('../src/node.ts');
  const t = new WorkerTessellator({ workers: 1 });
  await t.init();
  try {
    assert.deepEqual(t.info, NO_BACKEND);
    assert.equal((await t.run<JobOut>(job, { mode: 'echo', n: 2 })).values.length, 2);
    await assert.rejects(t.run({ ...job, export: 'noSuchJob' }, {}), /has no function 'noSuchJob'/);
    await assert.rejects(t.tessellate(req(0)), /no backend loaded/);
  } finally {
    t.dispose();
  }
});

test('a timeout says where the backend last was: its last progress, which the caller saw as it came', async () => {
  const t = await pool({ workers: 1, timeoutMs: 300 });
  try {
    const seen: number[] = [];
    await assert.rejects(t.tessellate(req(8, 3), (p) => seen.push(p.faceId!)),
      (e) => e instanceof TessellationError && e.message === 'tessellation timed out after 300 ms (last: face #3)');
    assert.deepEqual(seen, [1, 2, 3]);
    // Without progress, the message as it was.
    await assert.rejects(t.tessellate(req(1)),
      (e) => e instanceof Error && e.message === 'tessellation timed out after 300 ms');
  } finally {
    t.dispose();
  }
});

test('cpuTimeoutMs: a request past it in its thread\'s CPU time is stopped at its next progress; one long in wall '
  + 'time but light on CPU (a loaded host) is not; one waiting without progress still meets the wall-clock backstop; '
  + 'each result\'s wall and CPU times', async () => {
  // (The CPU timer off in effect: the progress path alone.)
  const t = await pool({ workers: 1, cpuTimeoutMs: 300, timeoutMs: 1500, cpuPollMs: 60_000 });
  try {
    assert.equal(t.cpuTimeoutMs, 300);
    // 2 s of CPU wanted: stopped at about 300 ms of it, well before the 1.5 s backstop.
    const t0 = performance.now();
    await assert.rejects(t.tessellate(req(9, 200)), (e) => e instanceof TessellationError && e.timeoutMs === 300
      && /^tessellation timed out after 300 ms of CPU time \(last: spin \d+\)$/.test(e.message));
    const took = performance.now() - t0;
    assert.ok(took < 1200, `stopped after ${took} ms`);
    // 1 s of wall time at little CPU: past the CPU limit in wall time, under it in CPU, so it completes; its times.
    const r = await t.tessellate(req(10, 100));
    const times = t.timesOf(r)!;
    assert.ok(times.wallMs >= 950, `wall ${times.wallMs}`);
    assert.ok(times.cpuMs !== undefined && times.cpuMs < 300, `cpu ${times.cpuMs}`);
    // 100 ms of CPU, under the limit: completes, its CPU time about that and at most its wall time.
    const s = await t.tessellate(req(9, 10));
    const ts = t.timesOf(s)!;
    assert.ok(ts.cpuMs! >= 100 && ts.cpuMs! <= ts.wallMs + 5, JSON.stringify(ts));
    // No progress and little CPU (waiting 2 s): the wall-clock backstop.
    await assert.rejects(t.tessellate(req(4, 200)), (e) => e instanceof TessellationError && e.timeoutMs === 1500
      && e.message === 'tessellation timed out after 1500 ms');
    assert.equal(t.timesOf({ ...r }), undefined);
  } finally {
    t.dispose();
  }
});

test('cpuTimeoutMs: a request busy in a step that reports nothing is stopped by the CPU timer, naming its last '
  + 'progress where it had one, long before the wall-clock backstop; the next request gets a new worker; the timer '
  + 'counts only the request\'s own CPU time', async () => {
  const t = await pool({ workers: 1, cpuTimeoutMs: 300, cpuPollMs: 50, timeoutMs: 20_000 });
  try {
    assert.equal(t.cpuPollMs, 50);
    // Spins with no progress at all.
    let t0 = performance.now();
    await assert.rejects(t.tessellate(req(1)), (e) => e instanceof TessellationError && e.timeoutMs === 300
      && e.message === 'tessellation timed out after 300 ms of CPU time');
    let took = performance.now() - t0;
    assert.ok(took >= 300 && took < 2000, `stopped after ${took} ms`);
    // Three progresses, then spins silently: named by the last.
    const seen: string[] = [];
    t0 = performance.now();
    await assert.rejects(t.tessellate(req(8, 3), (p) => seen.push(p.message)), (e) => e instanceof TessellationError
      && e.message === 'tessellation timed out after 300 ms of CPU time (last: face #3)');
    took = performance.now() - t0;
    assert.ok(took < 2000, `stopped after ${took} ms`);
    assert.deepEqual(seen, ['face #1', 'face #2', 'face #3']);
    // A worker that has already spent CPU on earlier requests: each request starts from zero. Four of 200 ms each
    // (800 ms on one worker, past the limit together) all complete.
    const before = instance(await t.tessellate(req(0)));
    for (let k = 0; k < 4; k++) assert.equal(instance(await t.tessellate(req(9, 20))), before);
  } finally {
    t.dispose();
  }
});

/** Node's worker handle, its CPU readings counted and each delayed by `lag.ms` as it was when the reading was asked. */
function laggingHandles() {
  const lag = { ms: 0, reads: 0 };
  const spawn = () => {
    const h = spawnNodeWorker();
    return { ...h, cpuUsageMs: async () => {
      const ms = lag.ms;
      lag.reads++;
      await new Promise((r) => setTimeout(r, ms));
      return h.cpuUsageMs!();
    } };
  };
  return { lag, spawn };
}

test('the CPU timer reads every cpuPollMs while a request runs, and not at all without a limit; a reading that '
  + 'arrives after its request ended doesn\'t stop the next one; a silent step stops near the limit', async () => {
  const { lag, spawn } = laggingHandles();
  const t = new PoolTessellator(spawn, { backend, workers: 1, cpuTimeoutMs: 300, cpuPollMs: 50, timeoutMs: 20_000 });
  await t.init();
  try {
    // A 200 ms spin: about 4 readings at 50 ms, and the one at the start.
    lag.reads = 0;
    await t.tessellate(req(9, 20));
    assert.ok(lag.reads >= 3 && lag.reads <= 12, `${lag.reads} readings`);
    // Readings delayed 400 ms: those asked during A (250 ms of CPU, under the limit) come back while B runs, past
    // the limit counted from A's start; they're A's, so B (also 250 ms) completes.
    const a = t.tessellate(req(9, 25));
    lag.ms = 400;
    const b = t.tessellate(req(9, 25));
    assert.ok(instance(await a) && instance(await b));
    lag.ms = 0;
    // A silent spin stops by about the limit and a poll: well under twice it (wall time is never less than CPU time).
    const t0 = performance.now();
    await assert.rejects(t.tessellate(req(1)), (e) => e instanceof TessellationError && e.timeoutMs === 300);
    const took = performance.now() - t0;
    assert.ok(took < 550, `stopped after ${took} ms`);
  } finally {
    t.dispose();
  }
  const u = new PoolTessellator(spawn, { backend, workers: 1, cpuPollMs: 50 });
  await u.init();
  try {
    lag.reads = 0;
    await u.tessellate(req(9, 20));
    assert.equal(lag.reads, 0);
  } finally {
    u.dispose();
  }
});

test('cpuPollMs 0: no CPU timer, so a silent spin meets only the wall-clock backstop; a pool without a CPU limit '
  + 'never stops a request on CPU', async () => {
  const t = await pool({ workers: 1, cpuTimeoutMs: 200, cpuPollMs: 0, timeoutMs: 1000 });
  try {
    await assert.rejects(t.tessellate(req(1)), (e) => e instanceof TessellationError && e.timeoutMs === 1000
      && e.message === 'tessellation timed out after 1000 ms');
  } finally {
    t.dispose();
  }
  const u = await pool({ workers: 1, cpuPollMs: 50 });
  try {
    assert.equal(u.cpuTimeoutMs, 0);
    assert.equal(u.cpuPollMs, 50);
    // 500 ms of CPU with no limit: completes.
    assert.ok(instance(await u.tessellate(req(9, 50))));
  } finally {
    u.dispose();
  }
});

test('a request that hangs times out, and the next one gets a new worker', async () => {
  const t = await pool({ workers: 1, timeoutMs: 300 });
  try {
    const before = instance(await t.tessellate(req(0)));
    await assert.rejects(t.tessellate(req(1)),
      (e) => e instanceof TessellationError && /timed out after 300 ms/.test(e.message) && e.timeoutMs === 300);
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

test("only the part's failures reject with a TessellationError, which keeps its time limit across the worker",
  async () => {
  const t = await pool({ workers: 1 });
  try {
    await assert.rejects(t.tessellate(req(6)),
      (e) => /Error: ordinary/.test((e as Error).message) && !(e instanceof TessellationError));
    await assert.rejects(t.tessellate(req(7)),
      (e) => e instanceof TessellationError && /own limit/.test(e.message) && e.timeoutMs === 50);
    assert.equal(t.timeoutMs, 120_000);  // DEFAULT_TIMEOUT_MS
  } finally {
    t.dispose();
  }
});

test('a worker that exits rejects its request, and the pool carries on', async () => {
  const t = await pool({ workers: 1 });
  try {
    const exit = t.tessellate(req(5));
    const queued = t.tessellate(req(0));
    await assert.rejects(exit,
      (e) => /worker exited with code 3/.test((e as Error).message) && !(e instanceof TessellationError));
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

test("when a replacement worker can't load the backend, queued requests fail instead of respawning forever",
  async () => {
  let spawns = 0;
  const t = new PoolTessellator(() => { spawns++; return spawnNodeWorker(); },
    { backend: { ...backend, options: { failAfter: Date.now() + 500 } }, workers: 1, maxPartsPerWorker: 1 });
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

test('while another worker is busy, a replacement that fails to load is not retried until that worker is done',
  async () => {
  let spawns = 0;
  const t = new PoolTessellator(() => { spawns++; return spawnNodeWorker(); },
    { backend: { ...backend, options: { failAfter: Date.now() + 500 } }, workers: 2, maxPartsPerWorker: 1 });
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
    for (const args of [[...flags, file], [...flags, '--input-type=module', '-e', script],
      ['--input-type=module', '-e', script]]) {
      const out = execFileSync(process.execPath, args, { timeout: 20_000, encoding: 'utf8' });
      assert.equal(out.trim(), 'done', args.slice(0, 3).join(' '));
    }
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("serve: a backend module passed in `modules` is used as it is, not imported", async () => {
  const { serve } = await import('../src/serve.ts');
  const { FakeTessellator } = await import('./fake-backend.ts');
  const posted: { type: string; info?: { name: string }; message?: string }[] = [];
  let send!: (msg: unknown) => void;
  const port = { post: (msg: never) => void posted.push(msg), onMessage: (cb: (msg: never) => void) => {
    send = cb as (msg: unknown) => void; } };
  serve(port as never, { 'no-such-module': { FakeTessellator } });
  send({ type: 'init', backend: { module: 'no-such-module', export: 'FakeTessellator' } });
  for (let t = 0; t < 100 && !posted.length; t++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted[0]?.type, 'ready', JSON.stringify(posted));
  // Not in `modules`: imported, which fails here.
  serve(port as never, {});
  send({ type: 'init', backend: { module: 'no-such-module', export: 'FakeTessellator' } });
  for (let t = 0; t < 100 && posted.length < 2; t++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(posted[1]?.type, 'initError');
});
