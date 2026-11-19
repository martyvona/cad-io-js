import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder } from '../../cad-brep/src/index.ts';
import { box } from '../../cad-brep/test/models.ts';
import { fixesOn, HEAL_FIXES, healPart, healScene } from '../src/index.ts';

test('fixesOn: every fix but pcurveMissing by default, none with heal false, each one off by name, unknown names '
  + 'refused', () => {
  const byDefault = HEAL_FIXES.filter((f) => f !== 'pcurveMissing');
  assert.deepEqual(fixesOn(), byDefault);
  assert.deepEqual(fixesOn({ heal: true }), byDefault);
  assert.deepEqual(fixesOn({ heal: false }), []);
  assert.deepEqual(fixesOn({ heal: false, fixes: { pcurveMissing: true } }), []);
  for (const f of HEAL_FIXES) {
    assert.deepEqual(fixesOn({ fixes: { pcurveMissing: true, [f]: false } }), HEAL_FIXES.filter((g) => g !== f), f);
  }
  assert.deepEqual(fixesOn({ fixes: { edgeTolerance: true } }), byDefault);
  assert.throws(() => fixesOn({ fixes: { noSuchFix: false } as never }), /no fix named noSuchFix/);
});

test('healPart with heal false gives the model as it is', async () => {
  const b = new BrepBuilder();
  box(b);
  const d = b.finish();
  const r = await healPart(d, { heal: false });
  assert.equal(r.model, d);
  assert.equal(r.changed, false);
  assert.deepEqual(r.diagnostics, []);
});

test('progress: each part, each step, and every PROGRESS_EVERY coedges through the curves', async () => {
  const { PROGRESS_EVERY } = await import('../src/curves.ts');
  const { cylinderSide } = await import('./models.ts');
  const said: string[] = [];
  const scene = { parts: [{ brep: { model: cylinderSide().finish(), format: 'step' }, sources: [] }],
    diagnostics: [] } as unknown as import('cad-scene').Scene;
  await healScene(scene, { progress: (w) => said.push(w) }, await (await import('cad-geom')).init());
  assert.deepEqual(said, ['part 0 of 1', 'strayPole', 'ranges and vertexTolerance', 'the healed model and its analysis'],
    `fewer than ${PROGRESS_EVERY} coedges: no coedge line`);
});

test('progress through a part of more than PROGRESS_EVERY coedges: a line every PROGRESS_EVERY, naming where', async () => {
  const { PROGRESS_EVERY } = await import('../src/curves.ts');
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  // Enough boxes for a few hundred coedges (24 each).
  for (let k = 0; k < Math.ceil(2.5 * PROGRESS_EVERY / 24); k++) box(b, [1, 2, 3], [3 * k, 0, 0], 100 * k);
  const said: string[] = [], d = b.finish();
  await healPart(d, { progress: (w) => said.push(w) }, await (await import('cad-geom')).init());
  const lines = said.filter((w) => w.startsWith('curves: coedge'));
  assert.equal(lines.length, Math.floor(d.coedge.edge.length / PROGRESS_EVERY));
  assert.match(lines[0]!, new RegExp(`^curves: coedge ${PROGRESS_EVERY} of ${d.coedge.edge.length} \\(face \\d+, `
    + `coedge #\\d+ \\(edge #\\d+\\)\\)$`));
});
