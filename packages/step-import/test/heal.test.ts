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
  // Each part done, and between them where healing is within a part (`detail`, as healScene's progress says it).
  const counts = h.healing.filter((p) => p.detail === undefined), details = h.healing.filter((p) => p.detail);
  assert.deepEqual(counts.map((p) => p.done), [0, 1, 2, 3, 4]);
  assert.ok(h.healing.every((p) => p.total === 4));
  assert.ok(details.length >= 4 * 6, `${details.length}`);
  for (const p of details) assert.match(p.detail!, /^part \d+ of \d+(: .+)?$/);
  assert.ok(details.some((p) => /: orientShells: faces$/.test(p.detail!)));
  // A detail's done is the parts done when it was said: never past the next count.
  let k = 0;
  for (const p of h.healing) {
    if (p.detail === undefined) k = p.done!;
    else assert.equal(p.done, k);
  }
});

test('heal.progress is still told healing\'s own progress beside the import\'s', async () => {
  const told: string[] = [];
  const h = await imported({ heal: { heal: true, progress: (w) => told.push(w) } });
  assert.deepEqual(told, h.healing.filter((p) => p.detail).map((p) => p.detail));
});

test('the default is HEAL_BY_DEFAULT\'s', async () => {
  const d = await imported();
  assert.equal(d.said.length > 0, HEAL_BY_DEFAULT);
  assert.equal([...d.parts.values()].every((p) => p.brep!.analysis), HEAL_BY_DEFAULT);
});

test('per fix: one off leaves what it would do undone, the others done; one off by default turned on', async () => {
  const off = await imported({ heal: { heal: true, fixes: { strayPole: false } } });
  assert.ok(!off.said.includes('strayPole') && off.said.includes('tolerances grown'), off.said.join());
  const on = await imported({ heal: { heal: true, fixes: { pcurveMissingOnElementary: true } } });
  assert.ok(on.said.includes('pcurveMissingOnElementary'), on.said.join());
  assert.ok(!(await imported({ heal: { heal: true } })).said.includes('pcurveMissingOnElementary'));
});
