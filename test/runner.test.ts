// corpus_checks/runner.ts: results in file order however the children finish, errors and crashes per file, and the
// same results in one process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addInto, division, runFiles } from '../corpus_checks/runner.ts';
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
