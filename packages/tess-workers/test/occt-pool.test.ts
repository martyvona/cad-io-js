// OCCT in the pool against OCCT on this thread. Needs the built module (packages/tess-occt/build.sh) and the corpus
// (test_corpus/third_party/pull.sh); skipped without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tessellateScene } from 'cad-scene';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { WorkerTessellator } from '../src/node.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const file = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const built = fs.existsSync(path.join(root, 'packages/tess-occt/dist/occt_tess.wasm'));
const skip = !built ? 'tess-occt not built (run packages/tess-occt/build.sh)' : !fs.existsSync(file) ? 'corpus not fetched' : false;

test('an assembly tessellated by OCCT in two workers, a fresh one per part, equals OCCT on this thread', { skip }, async () => {
  const { scene } = await importStep(fs.readFileSync(file));
  const opts = { linearDeflection: 0.5, angularDeflection: 0.5, edges: true };
  const direct = new OcctTessellator();
  await direct.init();
  const expected = await tessellateScene(scene, direct, opts);
  direct.dispose();
  const pool = new WorkerTessellator({ backend: { module: import.meta.resolve('tess-occt'), export: 'OcctTessellator' }, workers: 2, maxPartsPerWorker: 1 });
  await pool.init();
  try {
    assert.deepEqual(pool.info, direct.info);
    const done: number[] = [];
    const got = await tessellateScene(scene, pool, { ...opts, concurrency: 2, onPart: (i) => done.push(i) });
    assert.ok(expected.meshes.size >= 5, `${expected.meshes.size} meshes`);
    assert.deepEqual([...got.meshes.keys()], [...expected.meshes.keys()]);
    assert.deepEqual(got.meshes, expected.meshes);
    assert.deepEqual(got.diagnostics, expected.diagnostics);
    assert.deepEqual(done.sort((a, b) => a - b), [...expected.meshes.keys()].sort((a, b) => a - b));
  } finally {
    pool.dispose();
  }
});
