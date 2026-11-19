import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder } from '../../cad-brep/src/index.ts';
import { box } from '../../cad-brep/test/models.ts';
import { fixesOn, HEAL_FIXES, healPart } from '../src/index.ts';

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
