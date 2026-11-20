// corpus_checks/runner.ts: results in file order however the children finish, errors and crashes per file, and the
// same results in one process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import zlib from 'node:zlib';
import { addInto, admit, division, initAll, runFiles, uncompressedSize } from '../corpus_checks/runner.ts';
import { check } from './runner-fixture.ts';

const FIXTURE = new URL('./runner-fixture.ts', import.meta.url).href;
// Later files finish first (shorter jobs); one throws, one kills its process.
const files = Array.from({ length: 9 }, (_, k) => ({ path: `f${k}`,
  job: { ms: 10 * (9 - k), ...(k === 3 ? { fail: 'throw' as const } : k === 5 ? { fail: 'crash' as const } : {}) } }));

async function run(children: string) {
  process.env.CHILDREN = children;
  const got: { path: string; out: Awaited<ReturnType<typeof check.file>> | string }[] = [];
  await runFiles(FIXTURE, check, files, [], (path, r) => got.push({ path, out: 'result' in r ? r.result : r.error }));
  delete process.env.CHILDREN;
  return got;
}

test('runFiles: in file order from several processes, each set up once; a throw or a crash fails its file only',
  { timeout: 60_000 }, async () => {
    const got = await run('3');
    assert.deepEqual(got.map((g) => g.path), files.map((f) => f.path));
    assert.match(got[3]!.out as string, /thrown for f3/);
    assert.match(got[5]!.out as string, /the child process ended \(exit 3\)/);
    const ok = got.filter((g) => typeof g.out !== 'string').map((g) => g.out as { path: string; pid: number;
      setups: number });
    assert.equal(ok.length, 7);
    // (Before the crash, whose child is replaced.)
    assert.ok(new Set(ok.filter((r) => r.path < 'f5').map((r) => r.pid)).size > 1, 'several processes');
    assert.ok(ok.every((r) => r.pid !== process.pid && r.setups === 1), 'each child set up once');
  });

test('runFiles with one child: a crash replaces it, the files after are done', { timeout: 60_000 }, async () => {
  const got = await run('1');
  assert.deepEqual(got.map((g) => g.path), files.map((f) => f.path));
  assert.equal(got.filter((g) => typeof g.out === 'string').length, 2);
  const pids = got.filter((g) => typeof g.out !== 'string').map((g) => (g.out as { pid: number }).pid);
  assert.equal(new Set(pids).size, 2);
});

test('runFiles watchdogs: a child silent on a file is killed and the file retried once; one that won\'t exit after '
  + 'its last file is killed', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-watchdog-'));
  const saved = { idle: process.env.IDLE_MS, grace: process.env.EXIT_GRACE_MS, hang: process.env.FIXTURE_EXIT_HANG };
  try {
    process.env.IDLE_MS = '1500';
    process.env.EXIT_GRACE_MS = '1000';
    process.env.FIXTURE_EXIT_HANG = '1';
    process.env.CHILDREN = '2';
    const jobs = [{ path: 'g0', job: { ms: 5 } }, { path: 'g1', job: { ms: 5, hangOnce: path.join(dir, 'g1') } },
      { path: 'g2', job: { ms: 5, fail: 'hang' as const } }, { path: 'g3', job: { ms: 5 } }];
    const got: { path: string; out: unknown }[] = [];
    const t0 = Date.now();
    await runFiles(FIXTURE, check, jobs, [], (p, r) => got.push({ path: p, out: 'result' in r ? r.result : r.error }));
    assert.deepEqual(got.map((g) => g.path), ['g0', 'g1', 'g2', 'g3']);
    assert.equal(typeof got[1]!.out, 'object', 'hung once, then done');
    assert.match(got[2]!.out as string, /silent for 1.5 s, twice/);
    assert.equal(typeof got[0]!.out, 'object');
    assert.equal(typeof got[3]!.out, 'object');
    assert.ok(Date.now() - t0 < 30_000, 'the exits that hang are killed');
    // A file's silence counts from when it's given: files that answer in time aren't killed, however long the run.
    process.env.CHILDREN = '1';
    const tries = path.join(dir, 'tries');
    const steady = [{ path: 'h0', job: { ms: 5, tries } }, { path: 'h1', job: { ms: 1000, tries } },
      { path: 'h2', job: { ms: 1000, tries } }];
    const out: unknown[] = [];
    await runFiles(FIXTURE, check, steady, [], (_p, r) => out.push('result' in r ? r.result : r.error));
    assert.ok(out.every((o) => typeof o === 'object'));
    assert.deepEqual(fs.readFileSync(tries, 'utf8').trim().split('\n'), ['h0', 'h1', 'h2']);
    // A file busy past the idle time (never yielding) but saying where it is: not killed; one that goes quiet after
    // saying where it was: killed twice, the kill naming that.
    const said: string[] = [], write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (said.push(String(s)), true)) as typeof process.stderr.write;
    const busy: unknown[] = [];
    try {
      await runFiles(FIXTURE, check, [{ path: 'b0', job: { ms: 0, busy: { ms: 4000, every: 500 } } },
        { path: 'b1', job: { ms: 0, busy: { ms: 600, every: 500, hang: true } } }], [],
        (_p, r) => busy.push('result' in r ? r.result : r.error));
    } finally {
      process.stderr.write = write;
    }
    assert.equal(typeof busy[0], 'object', `busy 4 s against 1.5 s idle, saying where: ${busy[0]}`);
    assert.match(busy[1] as string, /silent for 1.5 s, twice/);
    assert.ok(said.some((s) => /killing a child silent for 1.5 s on \S*b1, last at b1 step 2 \(retrying it\)/.test(s)),
      said.join(''));
  } finally {
    delete process.env.CHILDREN;
    for (const [k, v] of [['IDLE_MS', saved.idle], ['EXIT_GRACE_MS', saved.grace], ['FIXTURE_EXIT_HANG', saved.hang]]) {
      if (v === undefined) delete process.env[k!];
      else process.env[k!] = v;
    }
    fs.rmSync(dir, { recursive: true });
  }
});

test('runFiles hands out the largest files first, and merges in file order', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-test-'));
  try {
    const sizes = [3, 50, 0, 20, 7];
    const real = sizes.map((n, k) => {
      const p = path.join(dir, `f${k}`);
      fs.writeFileSync(p, Buffer.alloc(n));
      return { path: p, job: { ms: 0 } };
    });
    process.env.CHILDREN = '1';
    const got: { path: string; seq: number }[] = [];
    await runFiles(FIXTURE, check, real, [], (p, r) => got.push({ path: p, seq: 'result' in r ? r.result.seq : -1 }));
    delete process.env.CHILDREN;
    assert.deepEqual(got.map((g) => g.path), real.map((f) => f.path));
    // Handed out by size, largest first: 50, 20, 7, 3, 0.
    assert.deepEqual(got.map((g) => g.seq), [3, 0, 4, 1, 2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runFiles with CHILDREN=0: every file in this process, the same order and outcomes (but the crash)',
  { timeout: 60_000 }, async () => {
  const exit = process.exit;
  process.exit = ((code: number) => { throw new Error(`exit ${code}`); }) as never;
  try {
    const got = await run('0');
    assert.deepEqual(got.map((g) => g.path), files.map((f) => f.path));
    assert.match(got[3]!.out as string, /thrown for f3/);
    assert.ok(got.filter((_, k) => k !== 3 && k !== 5).every((g) => (g.out as { pid: number }).pid === process.pid));
  } finally {
    process.exit = exit;
  }
});

test('runFiles: a backend that won\'t start in a child\'s setup fails the run, naming it; so does a child that ends '
  + 'before it\'s ready; no file merged as if it had run', { timeout: 60_000 }, async () => {
  const saved = process.env.FIXTURE_SETUP;
  try {
    for (const children of ['3', '1']) {
      process.env.FIXTURE_SETUP = 'pool';
      const got: string[] = [];
      process.env.CHILDREN = children;
      await assert.rejects(runFiles(FIXTURE, check, files, [], (p) => got.push(p)),
        (e: Error) => e.message.startsWith('runner: a child\'s setup failed, so the run stopped: Error: backend init '
          + 'failed: fake (tess-workers): backend init failed: Error: init refused'));
      assert.equal(got.length, 0, `CHILDREN=${children}: nothing merged`);
      process.env.FIXTURE_SETUP = 'exit';
      await assert.rejects(runFiles(FIXTURE, check, files, [], (p) => got.push(p)),
        /runner: a child ended before it was ready \(exit 4\), so the run stopped/);
      assert.equal(got.length, 0);
    }
    // One child of three failing stops the others' long files at once.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-setup-'));
    process.env.FIXTURE_SETUP = `once:${path.join(dir, 'failed')}`;
    process.env.CHILDREN = '3';
    const slow = Array.from({ length: 6 }, (_, k) => ({ path: `s${k}`, job: { ms: 20_000 } }));
    const t0 = Date.now();
    await assert.rejects(runFiles(FIXTURE, check, slow, [], () => {}), /a child's setup failed/);
    assert.ok(Date.now() - t0 < 15_000, `stopped at once (${Date.now() - t0} ms)`);
    fs.rmSync(dir, { recursive: true, force: true });
    // In this process: setup's error as it is.
    process.env.FIXTURE_SETUP = 'pool';
    process.env.CHILDREN = '0';
    await assert.rejects(runFiles(FIXTURE, check, files, [], () => {}),
      /^Error: backend init failed: fake \(tess-workers\): backend init failed: Error: init refused$/);
  } finally {
    delete process.env.CHILDREN;
    if (saved === undefined) delete process.env.FIXTURE_SETUP;
    else process.env.FIXTURE_SETUP = saved;
  }
});

test('initAll: every pool started; those that fail named in one error, after all have settled', async () => {
  const order: string[] = [];
  const pool = (name: string, ms: number, fail?: string) => ({ init: () => new Promise<void>((ok, no) =>
    setTimeout(() => { order.push(name); if (fail) no(new Error(fail)); else ok(); }, ms)) });
  await initAll({ a: pool('a', 5), b: pool('b', 1) });
  await assert.rejects(initAll({ x: pool('x', 1, 'no module'), y: pool('y', 20), z: pool('z', 5, 'bad API') }),
    (e: Error) => e.message === 'backend init failed: x: no module; z: bad API' && order.includes('y'));
});

test('addInto: numbers, pairs element by element, rows appended, maps by key, objects by field; nothing else', () => {
  const total = { n: 1, pair: [1, 2], rows: ['a'], none: [] as string[], by: new Map([['x', { k: 1 }]]),
    deep: { m: 2 } } as Record<string, unknown>;
  const file = { n: 2, pair: [10, 20], rows: ['b', 'c'], none: ['d'], by: new Map([['x', { k: 4 }], ['y', { k: 1 }]]),
    deep: { m: 3, extra: 5 } };
  assert.equal(addInto(total, file), total);
  assert.deepEqual(total, { n: 3, pair: [11, 22], rows: ['a', 'b', 'c'], none: ['d'],
    by: new Map([['x', { k: 5 }], ['y', { k: 1 }]]), deep: { m: 5, extra: 5 } });
  assert.throws(() => addInto({ s: 'a' }, { s: 'b' }), /aren't tallies/);
  assert.throws(() => addInto({ b: true }, { b: false }), /aren't tallies/);
  assert.throws(() => addInto({ n: 1 }, { n: [1] } as never), /aren't tallies/);
});

test('division: a third of the threads as children, fewer where memory is short; CHILDREN and MESH_WORKERS override',
  () => {
    const GiB = 2 ** 30, saved = { c: process.env.CHILDREN, m: process.env.MESH_WORKERS };
    delete process.env.CHILDREN;
    delete process.env.MESH_WORKERS;
    try {
      // An Apple M4 (10 threads), a 14-core i9 with 28, 8 threads (a third rounded down), a 64-thread machine short of
      // memory, the smallest.
      assert.deepEqual(division(10, 16 * GiB), { children: 3, meshWorkers: 2 });
      assert.deepEqual(division(28, 62.5 * GiB), { children: 9, meshWorkers: 2 });
      assert.deepEqual(division(8, 16 * GiB), { children: 2, meshWorkers: 2 });
      assert.deepEqual(division(64, 32 * GiB), { children: 8, meshWorkers: 6 });
      assert.deepEqual(division(64, 31.9 * GiB), { children: 7, meshWorkers: 8 });
      assert.deepEqual(division(1, 1 * GiB), { children: 1, meshWorkers: 1 });
      process.env.CHILDREN = '0';
      assert.deepEqual(division(28, 62.5 * GiB), { children: 0, meshWorkers: 26 });
      process.env.CHILDREN = '5';
      process.env.MESH_WORKERS = '7';
      assert.deepEqual(division(28, 62.5 * GiB), { children: 5, meshWorkers: 7 });
    } finally {
      for (const [k, v] of [['CHILDREN', saved.c], ['MESH_WORKERS', saved.m]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

test('admit: the first in line that fits beside the running files and the children\'s base; any file alone', () => {
  const est = (k: number) => [60, 50, 40, 30, 10, 0][k]!, terms = { budget: 100, childBase: 5 };
  const queue = [0, 1, 2, 3, 4, 5];
  assert.equal(admit(queue, est, 0, 0, 3, terms), 0);
  // (Room 100 - 15 - 60 = 25: the 10 is the first that fits.)
  assert.equal(admit(queue.slice(1), est, 60, 1, 3, terms), 3);
  assert.equal(admit([1, 2], est, 60, 1, 3, terms), -1);
  assert.equal(admit([2, 3], est, 45, 1, 1, terms), 0);
  assert.equal(admit([2, 3], est, 56, 1, 1, terms), 1);
  // A file larger than the whole budget starts when nothing runs.
  assert.equal(admit([0], (k) => 1e9 * (k + 1), 0, 0, 6, terms), 0);
  assert.equal(admit([], est, 0, 0, 3, terms), -1);
});

test('uncompressedSize: a file\'s size, a gzip file\'s by its trailer, a missing file 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-size-'));
  try {
    const plain = path.join(dir, 'a.stp'), gz = path.join(dir, 'a.stpZ');
    fs.writeFileSync(plain, Buffer.alloc(1234, 65));
    fs.writeFileSync(gz, zlib.gzipSync(Buffer.alloc(100_000, 65)));
    assert.equal(uncompressedSize(plain), 1234);
    assert.ok(fs.statSync(gz).size < 1000);
    assert.equal(uncompressedSize(gz), 100_000);
    assert.equal(uncompressedSize(path.join(dir, 'none')), 0);
    // (Data gzip can't shrink: its compressed size, the larger, as for a trailer wrapped past 4 GiB.)
    const noise = path.join(dir, 'noise.gz');
    fs.writeFileSync(noise, zlib.gzipSync(Buffer.from(Array.from({ length: 200 }, (_, k) => (k * 7919 + 13) % 251))));
    assert.ok(fs.statSync(noise).size > 200);
    assert.equal(uncompressedSize(noise), fs.statSync(noise).size);
    fs.writeFileSync(path.join(dir, 'tiny'), Buffer.from([0x1f, 0x8b]));
    assert.equal(uncompressedSize(path.join(dir, 'tiny')), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runFiles within MEM_BUDGET: running files\' estimates never past it, the largest that fits started, a file '
  + 'past the budget run alone, every file done in file order', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-budget-'));
  const keys = ['CHILDREN', 'MEM_BUDGET', 'MEM_FACTOR', 'MEM_CHILD_BASE'] as const;
  const saved = keys.map((k) => process.env[k]);
  const said: string[] = [], write = process.stderr.write.bind(process.stderr);
  try {
    // Sizes in bytes, the factor 2 and the base 2 a child: a budget of 106 leaves 100 for 3 children's files' twice
    // their sizes (below, the estimates).
    const sizes = [30, 60, 10, 150, 50, 40, 0], halved = sizes.map((n) => n / 2);
    const spans = path.join(dir, 'spans');
    const real = halved.map((n, k) => {
      const p = path.join(dir, `f${k}`);
      fs.writeFileSync(p, Buffer.alloc(n));
      return { path: p, job: { ms: 150, spans } };
    });
    Object.assign(process.env, { CHILDREN: '3', MEM_BUDGET: String(106 / 2 ** 30), MEM_FACTOR: '2',
      MEM_CHILD_BASE: String(2 / 2 ** 30) });
    process.stderr.write = ((s: string) => (said.push(String(s)), true)) as typeof process.stderr.write;
    const got: string[] = [];
    await runFiles(FIXTURE, check, real, [], (p, r) => got.push('result' in r ? p : r.error));
    process.stderr.write = write;
    assert.deepEqual(got, real.map((f) => f.path));
    const size = new Map(real.map((f, k) => [path.basename(f.path), sizes[k]!]));
    const running = new Set<string>();
    let alone = false;
    for (const l of fs.readFileSync(spans, 'utf8').trim().split('\n')) {
      const f = path.basename(l.slice(1));
      if (l[0] === '-') { running.delete(f); continue; }
      if (running.size === 0 && size.get(f)! > 100) alone = true;
      else {
        const total = [...running, f].reduce((s, g) => s + size.get(g)!, 0);
        assert.ok(total <= 100, `${[...running, f]}: ${total}`);
      }
      running.add(f);
    }
    assert.ok(alone, 'the file past the budget ran, alone');
    // (The 150 starts first and alone; then the 60 and, the 50 not fitting beside it, the 40 and the 0, whose starts
    // two processes note in either order: the 50 only once the 60 has ended. A file's end is noted before its result
    // is sent and its start after it's given, so the noted overlaps are within the runner's.)
    const lines = fs.readFileSync(spans, 'utf8').trim().split('\n').map((l) => l[0] + path.basename(l.slice(1)));
    assert.deepEqual(lines.slice(0, 3), ['+f3', '-f3', '+f1']);
    assert.deepEqual(new Set(lines.slice(3, 5)), new Set(['+f5', '+f6']));
    assert.ok(lines.indexOf('+f4') > lines.indexOf('-f1'), lines.join(' '));
    assert.ok(said.some((s) => /memory budget 0\.0 GiB, a file estimated at 2 x its uncompressed size/.test(s)),
      said.join(''));
    assert.ok(said.some((s) => /runner: \d+ files waited for room in the memory budget/.test(s)), said.join(''));
  } finally {
    process.stderr.write = write;
    keys.forEach((k, i) => { if (saved[i] === undefined) delete process.env[k]; else process.env[k] = saved[i]; });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
