// corpus_checks/round.ts and mesh-cache.ts: a round empties the cache first, runs its checks in order sharing it, keeps
// going past a failure, and refuses to empty a directory it didn't make; a check's mesher answers from a cache another
// process filled, and is the plain StepTessellator outside a round.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import type { TessellationRequest, TessellationResult, Tessellator } from '../packages/cad-scene/src/index.ts';
import { CachedTessellator } from '../packages/tess-cache/src/node.ts';
import { StepTessellator } from '../packages/step-export/src/index.ts';
import { MARKER, emptyCache, runRound } from '../corpus_checks/round.ts';
import { cachedMesher, stepconvCacheArgs } from '../corpus_checks/mesh-cache.ts';

// A check: prints its arguments and what the cache holds besides the marker, then adds its own name to it; exits
// with the code its name ends in (`b3` exits 3).
const FIXTURE = `import fs from 'node:fs';
import path from 'node:path';
const dir = process.env.MESH_CACHE, name = path.basename(process.argv[1], '.ts');
console.log(JSON.stringify({ args: process.argv.slice(2), seen: fs.readdirSync(dir).filter((e) => e !== '${MARKER}')
  .sort() }));
process.stderr.write('progress ' + name + '\\n');
fs.writeFileSync(path.join(dir, name), '');
process.exit(Number(/\\d$/.exec(name)?.[0] ?? 0));
`;

const quiet = () => new Writable({ write(_c, _e, cb) { cb(); } });

test('runRound: the cache emptied first, then shared by the checks in order; a failure does not stop it',
  { timeout: 60_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-test-'));
    try {
      const checksDir = path.join(root, 'checks'), cacheDir = path.join(root, 'cache'), outDir = path.join(root, 'out');
      fs.mkdirSync(checksDir);
      for (const c of ['a', 'b3', 'c']) fs.writeFileSync(path.join(checksDir, `${c}.ts`), FIXTURE);
      // A previous round's entry, which must be gone.
      emptyCache(cacheDir);
      fs.writeFileSync(path.join(cacheDir, 'stale'), '');
      const codes = await runRound({ checks: ['c', 'b3', 'a'], checksDir, cacheDir, outDir, args: ['list', '7'],
        stderr: quiet() });
      assert.deepEqual(codes, [0, 3, 0]);
      const log = (c: string) => JSON.parse(fs.readFileSync(path.join(outDir, `${c}.log`), 'utf8'));
      assert.deepEqual(log('c'), { args: ['list', '7'], seen: [] });
      assert.deepEqual(log('b3').seen, ['c']);
      assert.deepEqual(log('a').seen, ['b3', 'c']);
      assert.equal(fs.readFileSync(path.join(outDir, 'b3.err'), 'utf8'), 'progress b3\n');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test('runRound: refuses an unknown check, and a cache directory it did not make, before emptying anything', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'round-test-'));
  try {
    const checksDir = path.join(root, 'checks'), cacheDir = path.join(root, 'cache');
    fs.mkdirSync(checksDir);
    fs.writeFileSync(path.join(checksDir, 'a.ts'), FIXTURE);
    // (A script outside the checks' directory, which a name with a path would reach.)
    fs.writeFileSync(path.join(root, 'a.ts'), FIXTURE);
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, 'precious'), '');
    const o = { checksDir, cacheDir, outDir: path.join(root, 'out'), args: [], stderr: quiet() };
    await assert.rejects(runRound({ ...o, checks: ['a', 'nope'] }), /no check nope/);
    await assert.rejects(runRound({ ...o, checks: ['../a'] }), /no check/);
    await assert.rejects(runRound({ ...o, checks: ['a'] }), /isn't a round's mesh cache/);
    assert.ok(fs.existsSync(path.join(cacheDir, 'precious')));
    assert.ok(!fs.existsSync(path.join(root, 'out')));
    // An empty directory is taken.
    fs.rmSync(path.join(cacheDir, 'precious'));
    emptyCache(cacheDir);
    assert.ok(fs.existsSync(path.join(cacheDir, MARKER)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** A backend that reads the model itself (so StepTessellator passes requests through), counting its calls. */
function fakePool(): Tessellator & { calls: number } {
  const t = {
    calls: 0,
    info: { name: 'fake', version: '1', license: 'none', formats: ['cad-brep' as const], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    timeoutMs: 120_000,
    async init() {},
    async tessellate(req: TessellationRequest): Promise<TessellationResult> {
      t.calls++;
      return { origin: [0, 0, 0], positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, req.data[0]!, 0]),
        indices: new Uint32Array([0, 1, 2]), faces: [{ entityId: 1, start: 0, count: 1 }], diagnostics: [] };
    },
    dispose() {},
  };
  return t;
}

test('cachedMesher: in a round, a second pool (another process) is answered from the cache the first filled',
  async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mesh-cache-test-'));
    process.env.MESH_CACHE = dir;
    process.env.MESH_CACHE_MB = '5';
    try {
      assert.deepEqual(stepconvCacheArgs(), ['--cache', dir, '--cache-size', '5']);
      const req = (x: number): TessellationRequest => ({ format: 'cad-brep', data: new Uint8Array([x]),
        linearDeflection: 0.1, angularDeflection: 0.5 });
      const p1 = fakePool(), m1 = cachedMesher(p1);
      assert.ok(m1 instanceof CachedTessellator);
      assert.equal(cachedMesher(p1), m1, 'one per pool');
      await m1.tessellate(req(2));
      const p2 = fakePool(), m2 = cachedMesher(p2);
      assert.notEqual(m2, m1);
      const r = await m2.tessellate(req(2));
      assert.equal(p2.calls, 0);
      assert.equal(r.positions[7], 2);
      // Another model is meshed.
      await m2.tessellate(req(3));
      assert.equal(p2.calls, 1);
    } finally {
      delete process.env.MESH_CACHE;
      delete process.env.MESH_CACHE_MB;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

test('cachedMesher: outside a round, the pool behind a StepTessellator and nothing else', async () => {
  delete process.env.MESH_CACHE;
  assert.deepEqual(stepconvCacheArgs(), []);
  const p = fakePool(), m = cachedMesher(p);
  assert.ok(m instanceof StepTessellator);
  await m.tessellate({ format: 'cad-brep', data: new Uint8Array([1]), linearDeflection: 0.1, angularDeflection: 0.5 });
  await m.tessellate({ format: 'cad-brep', data: new Uint8Array([1]), linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.equal(p.calls, 2);
});
