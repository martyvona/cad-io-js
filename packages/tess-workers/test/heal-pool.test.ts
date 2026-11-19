import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { Scene } from 'cad-scene';
import { healScene, type HealedPart, type HealSceneOptions, poolHealer } from '../../cad-heal/src/index.ts';
import { healTestScene } from '../../cad-heal/test/scene.ts';
import { WorkerTessellator } from '../src/node.ts';

const job = { module: new URL('../../cad-heal/src/index.ts', import.meta.url).href, export: 'healJob' };
const digest = (b: ArrayBuffer | undefined) => b && createHash('sha256').update(new Uint8Array(b)).digest('hex');
/** Each part's model and analysis by digest, and the scene's diagnostics. */
const healed = (s: Scene) => ({ parts: s.parts.map((p) => ({ model: digest(p.brep!.model.buffer),
  analysis: digest(p.brep!.analysis?.buffer) })), diagnostics: s.diagnostics });

for (const [what, opts] of [['the default fixes', {}], ['pcurveMissing on, edgeTolerance off',
  { fixes: { pcurveMissing: true, edgeTolerance: false } }]] as [string, HealSceneOptions][]) {
  test(`healScene in a pool's workers, 3 at once, gives what it gives serially, byte for byte (${what})`, async () => {
    const serial = healTestScene(), parallel = healTestScene(), before = healed(healTestScene());
    await healScene(serial, opts);
    const pool = new WorkerTessellator({ workers: 3 });
    await pool.init();
    const said: string[] = [], done: number[] = [];
    try {
      await healScene(parallel, { ...opts, concurrency: 3, progress: (w) => said.push(w),
        onPart: (n, total) => { assert.equal(total, 4); done.push(n); },
        healer: poolHealer(pool, job.module) });
    } finally {
      pool.dispose();
    }
    assert.deepEqual(healed(parallel), healed(serial));
    assert.deepEqual(done, [1, 2, 3, 4]);
    // Healing did something (not a comparison of models as imported): the stray pole moved, the box left alone.
    const s = healed(serial);
    assert.notEqual(s.parts[0]!.model, before.parts[0]!.model);
    assert.equal(s.parts[3]!.model, before.parts[3]!.model);
    assert.ok(s.diagnostics.some((d) => /strayPole/.test(d.message)));
    // Progress from inside the workers, after the part's name.
    assert.ok(said.includes('part 0 of 4: strayPole'), said.join('\n'));
  });
}

test('healScene: a healer elsewhere that fails leaves that part as imported with a warning, the others healed',
  async () => {
  const scene = healTestScene(), before = healed(healTestScene()), reference = healTestScene();
  await healScene(reference);
  const pool = new WorkerTessellator({ workers: 2 });
  await pool.init();
  try {
    await healScene(scene, { concurrency: 2, healer: (req, progress) => req.source?.id === 100
      ? pool.run({ ...job, export: 'noSuchJob' }, req) : pool.run<HealedPart>(job, req, { onProgress: progress }) });
  } finally {
    pool.dispose();
  }
  const h = healed(scene), r = healed(reference);
  assert.equal(h.parts[0]!.model, before.parts[0]!.model);
  assert.equal(h.parts[0]!.analysis, undefined);
  assert.deepEqual(h.parts.slice(1), r.parts.slice(1));
  assert.match(h.diagnostics[0]!.message, /^healing failed \(.*has no function 'noSuchJob'\): the model as imported$/);
  assert.deepEqual(h.diagnostics[0]!.source, { format: 'step', id: 100 });
  assert.deepEqual(h.diagnostics.slice(1), r.diagnostics.filter((d) => d.source?.id !== 100));
});

test('healScene: a part past its time in a worker stays as imported, its warning naming where healing was',
  async () => {
  const scene = healTestScene(), before = healed(healTestScene());
  const pool = new WorkerTessellator({ workers: 2 });
  await pool.init();
  const hang = { module: new URL('./fake-backend.ts', import.meta.url).href, export: 'fakeJob' };
  try {
    await healScene(scene, { concurrency: 2, healer: (req, progress) => req.source?.id === 101
      ? pool.run(hang, { mode: 'hang', progress: 2 }, { onProgress: progress, timeoutMs: 300 })
      : poolHealer(pool, job.module)(req, progress) });
  } finally {
    pool.dispose();
  }
  const h = healed(scene);
  assert.equal(h.parts[1]!.model, before.parts[1]!.model);
  const w = h.diagnostics.find((d) => d.source?.id === 101)!;
  assert.equal(w.severity, 'warning');
  assert.equal(w.message, 'healing failed (job fakeJob timed out after 300 ms (last: step 2)): the model as imported');
  assert.notEqual(h.parts[0]!.model, before.parts[0]!.model);
});
