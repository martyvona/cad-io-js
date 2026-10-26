import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_MESH_PROFILE, MESH_PROFILE_NAMES, MESH_PROFILES, meshDeflections, meshProfileOf } from
  '../src/index.ts';

const degrees = (rad: number) => Math.round(rad * 180 / Math.PI * 1e9) / 1e9;

test('meshing profiles: the user\'s values (2026-10-26), medium by default', () => {
  assert.deepEqual(MESH_PROFILE_NAMES, ['coarse', 'medium', 'fine']);
  assert.deepEqual(MESH_PROFILE_NAMES.map((n) => [MESH_PROFILES[n].linearDeflection,
    degrees(MESH_PROFILES[n].angularDeflection)]), [[0.2, 30], [0.1, 15], [0.05, 7.5]]);
  assert.equal(DEFAULT_MESH_PROFILE, 'medium');
  assert.deepEqual(meshDeflections(), MESH_PROFILES.medium);
});

test('meshDeflections: a profile, each value replaced if given; an unknown profile is a caller bug', () => {
  assert.deepEqual(meshDeflections({ profile: 'coarse' }), MESH_PROFILES.coarse);
  assert.deepEqual(meshDeflections({ profile: 'fine', linearDeflection: 0.03 }),
    { linearDeflection: 0.03, angularDeflection: MESH_PROFILES.fine.angularDeflection });
  assert.deepEqual(meshDeflections({ angularDeflection: 0.5 }), { linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.throws(() => meshDeflections({ profile: 'rough' as 'fine' }), /unknown meshing profile: rough/);
});

test('meshProfileOf: the profile with exactly these deflections, else none (custom)', () => {
  for (const n of MESH_PROFILE_NAMES) assert.equal(meshProfileOf({ ...MESH_PROFILES[n] }), n);
  assert.equal(meshProfileOf({ linearDeflection: 0.1, angularDeflection: 0.5 }), undefined);
  assert.equal(meshProfileOf({ ...MESH_PROFILES.fine, linearDeflection: 0.03 }), undefined);
});
