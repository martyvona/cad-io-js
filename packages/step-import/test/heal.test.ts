import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HEAL_BY_DEFAULT } from '../../cad-heal/src/index.ts';
import { healTestScene, stepOf } from '../../cad-heal/test/scene.ts';
import { importStep, type ImportOptions, type ImportProgress } from '../src/index.ts';

const file = stepOf(healTestScene());
/** The import's parts by name, its healing diagnostics, its healing progress. */
async function imported(opts: ImportOptions = {}) {
  const progress: ImportProgress[] = [];
  const { scene } = await importStep(file, { ...opts, onProgress: (p) => progress.push(p) });
  const parts = new Map(scene.parts.map((p) => [p.name, p]));
  return { scene, parts, healing: progress.filter((p) => p.phase === 'healing'),
    said: scene.diagnostics.filter((d) => /^(strayPole|edgeTolerance|pcurve|vertexTolerance|tolerances grown)/.test(
      d.message)).map((d) => d.message.split(':')[0]) };
}
const asImported = await imported({ heal: { heal: false } });

test('heal: false imports the models as they are: no analysis, no healing diagnostics, no healing phase', () => {
  assert.equal(asImported.parts.size, 4);
  for (const p of asImported.parts.values()) assert.equal(p.brep!.analysis, undefined);
  assert.deepEqual(asImported.said, []);
  assert.deepEqual(asImported.healing, []);
});

test('heal: true heals every part, an analysis on each, its diagnostics the scene\'s, its progress the import\'s '
  + 'healing phase', async () => {
  const h = await imported({ heal: { heal: true } });
  for (const p of h.parts.values()) assert.ok(p.brep!.analysis, p.name);
  assert.notEqual(h.parts.get('stray')!.brep!.model, asImported.parts.get('stray')!.brep!.model);
  assert.ok(h.said.includes('strayPole') && h.said.includes('tolerances grown'), h.said.join());
  assert.deepEqual(h.healing.map((p) => p.done), [0, 1, 2, 3, 4]);
  assert.ok(h.healing.every((p) => p.total === 4));
});

test('the default is HEAL_BY_DEFAULT\'s', async () => {
  const d = await imported();
  assert.equal(d.said.length > 0, HEAL_BY_DEFAULT);
  assert.equal([...d.parts.values()].every((p) => p.brep!.analysis), HEAL_BY_DEFAULT);
});

test('per fix: one off leaves what it would do undone, the others done; one off by default turned on', async () => {
  const off = await imported({ heal: { heal: true, fixes: { strayPole: false } } });
  assert.ok(!off.said.includes('strayPole') && off.said.includes('tolerances grown'), off.said.join());
  const on = await imported({ heal: { heal: true, fixes: { pcurveMissing: true } } });
  assert.ok(on.said.includes('pcurveMissing'), on.said.join());
  assert.ok(!(await imported({ heal: { heal: true } })).said.includes('pcurveMissing'));
});
