import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeTransforms, multiply, noTransformCounts, scaling, transformKinds, transformUse,
  type Mat4, type Scene } from '../src/index.ts';

/** Column-major from the 3x3's columns and a translation. */
const fromCols = (x: number[], y: number[], z: number[], t = [0, 0, 0]): Mat4 =>
  Float64Array.of(x[0]!, x[1]!, x[2]!, 0, y[0]!, y[1]!, y[2]!, 0, z[0]!, z[1]!, z[2]!, 0, t[0]!, t[1]!, t[2]!, 1);
const turn = (deg: number): Mat4 => {
  const a = deg * Math.PI / 180;
  return fromCols([Math.cos(a), Math.sin(a), 0], [-Math.sin(a), Math.cos(a), 0], [0, 0, 1]);
};
const diag = (x: number, y: number, z: number) => fromCols([x, 0, 0], [0, y, 0], [0, 0, z]);

test('the kinds: a turn and an even scale none; a mirror, uneven scales and a shear each alone and together', () => {
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [0, 1, 0], [0, 0, 1], [5, 6, 7])), []);
  assert.deepEqual(transformKinds(multiply(turn(30), scaling(25.4))), []);
  assert.deepEqual(transformKinds(diag(-1, 1, 1)), ['reflection']);
  // (A turn by 180 degrees is no mirror: two axes flipped.)
  assert.deepEqual(transformKinds(diag(-1, -1, 1)), []);
  assert.deepEqual(transformKinds(diag(-2, -2, -2)), ['reflection']);
  assert.deepEqual(transformKinds(diag(1, 2, 1)), ['nonUniformScale']);
  // (The y axis tilted towards x, its length kept; tilted and lengthened, uneven too.)
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [0.6, 0.8, 0], [0, 0, 1])), ['shear']);
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [0.5, 1, 0], [0, 0, 1])), ['nonUniformScale', 'shear']);
  // A turn after an uneven scale: glTF's TRS (no shear); before it: a shear.
  assert.deepEqual(transformKinds(multiply(turn(30), diag(1, 2, 1))), ['nonUniformScale']);
  assert.deepEqual(transformKinds(multiply(diag(1, 2, 1), turn(30))), ['nonUniformScale', 'shear']);
  assert.deepEqual(transformKinds(multiply(diag(1, 2, -1), turn(30))), ['reflection', 'nonUniformScale', 'shear']);
  // A mirror sheared far (its determinant over its lengths -0.44) is still a mirror; one nearly flat (that ratio
  // -1e-6) isn't said to be one, only sheared. A shear between y and z alone.
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [0.9, Math.sqrt(1 - 0.81), 0], [0, 0, -1])),
    ['reflection', 'shear']);
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [Math.sqrt(1 - 1e-12), 1e-6, 0], [0, 0, -1])), ['shear']);
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [0, 1, 0], [0, 0.6, 0.8])), ['shear']);
  // Degenerate: an axis of length zero, or not finite.
  assert.deepEqual(transformKinds(diag(0, 1, 1)), []);
  assert.deepEqual(transformKinds(diag(NaN, 1, 1)), []);
});

test('float32 noise in a turn is no kind; just past the tolerance is', () => {
  const f = Float32Array.from(multiply(turn(37), scaling(0.001)));
  assert.deepEqual(transformKinds(Float64Array.from(f)), []);
  assert.deepEqual(transformKinds(diag(1, 1 + 2e-5, 1)), ['nonUniformScale']);
  assert.deepEqual(transformKinds(diag(1, 1 + 5e-6, 1)), []);
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [2e-5, 1, 0], [0, 0, 1])), ['shear']);
  assert.deepEqual(transformKinds(fromCols([1, 0, 0], [5e-6, 1, 0], [0, 0, 1])), []);
});

test('a scene\'s use: its own transforms, and its placed parts\', which composition can shear', () => {
  const part = { name: 'p', sources: [], properties: {}, unit: 1, origin: [0, 0, 0] as [number, number, number],
    lods: [] };
  const occ = (component: number, transform: Mat4) => ({ component, transform, sources: [], properties: {} });
  const scene: Scene = { unit: 'millimetre', parts: [part], materials: [], layers: [], overrides: [],
    properties: {}, diagnostics: [],
    components: [
      { name: 'top', sources: [], properties: {}, parts: [],
        children: [occ(1, diag(1, 3, 1)), occ(1, diag(-1, 1, 1))] },
      { name: 'leaf', sources: [], properties: {}, parts: [{ part: 0, transform: multiply(turn(45), diag(1, 1, 2)) }],
        children: [] },
    ],
    // (Each own transform a kind of its own, so each place counted shows.)
    roots: [occ(0, diag(-1, 1, 1))],
    rootParts: [{ part: 0, transform: fromCols([1, 0, 0], [0, 1, 0], [0, 0.6, 0.8]) }] };
  const use = transformUse(scene);
  assert.deepEqual(use.own, { reflection: 2, nonUniformScale: 2, shear: 1 });
  // Placed: the root's mirror and the first child's uneven scale over the leaf's turn (sheared there); the second
  // child's mirror undoing the root's; the root part's shear.
  assert.deepEqual(use.placed, { reflection: 1, nonUniformScale: 2, shear: 2 });
  assert.equal(describeTransforms(use.placed), '1 mirrored, 2 scaled unevenly, 2 sheared');
  assert.equal(describeTransforms(use.placed, ['shear']), '2 sheared');
  assert.equal(describeTransforms(noTransformCounts()), '');
});
