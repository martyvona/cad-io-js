import assert from 'node:assert/strict';
import { test } from 'node:test';
import { transformsLost } from '../src/export-formats.ts';

test('what a format can\'t hold of the transforms: glTF a shear of the tree\'s own; three.js and 3MF ' +
  'everything', () => {
  const c = (reflection: number, nonUniformScale: number, shear: number) => ({ reflection, nonUniformScale, shear });
  // (The tree's own counts for glTF, which writes the tree: a shear only where placed is a turn under an uneven scale,
  // which its nodes hold.)
  assert.equal(transformsLost('glb', { own: c(1, 1, 0), placed: c(1, 1, 3) }), '');
  assert.equal(transformsLost('gltf', { own: c(2, 1, 1), placed: c(2, 1, 1) }), 'This model has 1 sheared ' +
    'transform, which glTF can\'t hold: written without the shear, what\'s below it misshapen.');
  assert.equal(transformsLost('glb', { own: c(0, 0, 2), placed: c(0, 0, 5) }), 'This model has 2 sheared ' +
    'transforms, which glTF can\'t hold: written without the shear, what\'s below them misshapen.');
  for (const f of ['threejs', '3mf'] as const) assert.equal(transformsLost(f, { own: c(1, 1, 1), placed: c(1, 1, 1) }),
    '');
});
