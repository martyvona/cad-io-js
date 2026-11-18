import assert from 'node:assert/strict';
import test from 'node:test';
import { BrepBuilder } from '../../cad-brep/src/index.ts';
import { box } from '../../cad-brep/test/models.ts';
import { fixesOn, HEAL_FIXES, healPart } from '../src/index.ts';

test('fixesOn: every fix by default, none with heal false, each one off by name, unknown names refused', () => {
  assert.deepEqual(fixesOn(), [...HEAL_FIXES]);
  assert.deepEqual(fixesOn({ heal: true }), [...HEAL_FIXES]);
  assert.deepEqual(fixesOn({ heal: false }), []);
  assert.deepEqual(fixesOn({ heal: false, fixes: { pcurveMissing: true } }), []);
  for (const f of HEAL_FIXES) {
    assert.deepEqual(fixesOn({ fixes: { [f]: false } }), HEAL_FIXES.filter((g) => g !== f), f);
  }
  assert.deepEqual(fixesOn({ fixes: { edgeTolerance: true } }), [...HEAL_FIXES]);
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
