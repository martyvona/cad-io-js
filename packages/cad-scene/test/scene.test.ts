import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity, instances, multiply, partInstances, scaling, validate, type Mat4,
  type Scene } from '../src/index.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
const at = (m: Mat4) => [m[12], m[13], m[14]];

// An assembly (0) with two occurrences of a subassembly (1), each holding a part in inches (part 0) and a bolt
// component (2, part 1). Materials: 0 red, 1 green, 2 blue, 3 white.
function scene(): Scene {
  const occ = (component: number, t: Mat4) => ({ component, transform: t, sources: [], properties: {} });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [{ format: 'step', id: 1 }], properties: {}, parts: [],
        children: [occ(1, translation(100, 0, 0)), occ(1, translation(200, 0, 0))] },
      { name: 'sub', sources: [], properties: {}, parts: [{ part: 0, transform: scaling(25.4) }],
        children: [occ(2, translation(0, 10, 0))] },
      { name: 'bolt', sources: [], properties: {}, parts: [{ part: 1, transform: identity() }], children: [] },
    ],
    roots: [occ(0, identity())],
    parts: [
      { name: 'plate', sources: [], properties: {}, unit: 25.4, origin: [0, 0, 0], lods: [], material: 1,
        faceMaterials: [{ face: 7, material: 2 }] },
      { name: 'bolt', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] },
    ],
    materials: [0, 1, 2, 3].map(
      (i) => ({ color: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]][i] as [number, number, number], opacity: 1,
      sources: [] })),
    layers: [],
    overrides: [],
    properties: {},
    diagnostics: [],
  };
}

test('instances: the expanded tree with world transforms', () => {
  const s = scene();
  assert.deepEqual([...instances(s)].map((i) => [i.path.join('/'), i.component, at(i.transform)]), [
    ['0', 0, [0, 0, 0]], ['0/0', 1, [100, 0, 0]], ['0/0/0', 2, [100, 10, 0]], ['0/1', 1, [200, 0, 0]],
    ['0/1/0', 2, [200, 10, 0]],
  ]);
  const parts = [...partInstances(s)];
  assert.deepEqual(parts.map((p) => [p.path.join('/'), p.part, at(p.transform), p.transform[0]]), [
    ['0/0', 0, [100, 0, 0], 25.4], ['0/0/0', 1, [100, 10, 0], 1], ['0/1', 0, [200, 0, 0], 25.4],
    ['0/1/0', 1, [200, 10, 0], 1],
  ]);
  assert.deepEqual(at(multiply(translation(1, 2, 3), translation(10, 20, 30))), [11, 22, 33]);
});

test('materials resolve top down; instance overrides win; hidden instances', () => {
  const s = scene();
  const look = () => [...partInstances(s)].map(
    (p) => [p.path.join('/'), p.part, p.material, [...p.faceMaterials], p.visible]);
  // Part-level: the plate green with face 7 blue; the bolt unstyled.
  assert.deepEqual(look(), [
    ['0/0', 0, 1, [[7, 2]], true], ['0/0/0', 1, undefined, [], true], ['0/1', 0, 1, [[7, 2]], true],
    ['0/1/0', 1, undefined, [], true],
  ]);
  // A material on the subassembly component recolours everything in it, faces included.
  s.components[1]!.material = 0;
  assert.deepEqual(look().map((x) => [x[0], x[2], x[3]]),
    [['0/0', 0, []], ['0/0/0', 0, []], ['0/1', 0, []], ['0/1/0', 0, []]]);
  // The topmost component wins over a lower one.
  s.components[0]!.material = 3;
  assert.deepEqual(look().map((x) => x[2]), [3, 3, 3, 3]);
  // An instance override on one subassembly instance beats them, for that instance only; a deeper override beats it.
  s.overrides.push({ path: [0, 1], material: 2, sources: [] },
    { path: [0, 1, 0], material: 1, visible: false, sources: [] });
  s.overrides.push({ path: [0, 0], faceMaterials: [{ part: 0, face: 9, material: 1 }], sources: [] });
  assert.deepEqual(look(), [
    ['0/0', 0, 3, [[9, 1]], true], ['0/0/0', 1, 3, [], true], ['0/1', 0, 2, [], true], ['0/1/0', 1, 1, [], false],
  ]);
});

test('validate', () => {
  const s = scene();
  assert.deepEqual(validate(s), []);
  s.components[2]!.children.push({ component: 1, transform: identity(), sources: [], properties: {} }); // 1 -> 2 -> 1
  s.components[1]!.parts.push({ part: 5, transform: new Float64Array(16).fill(NaN), material: 9 });
  s.parts[1]!.unit = 0;
  assert.deepEqual(validate(s), [
    'components[1].parts[1]: part 5 out of range',
    'components[1].parts[1]: transform is not 16 finite numbers',
    'components[1].parts[1]: material 9 out of range',
    'parts[1]: unit 0 is not positive',
    'component 1 contains itself',
  ]);
  // The cycle doesn't make the walk loop.
  s.components[1]!.parts.pop();
  assert.equal([...instances(s)].length, 5);
});

test('an override for one part reference: only that placement; validate checks paths and references', () => {
  const s = scene();
  // The sub's plate gets a second reference; the second sub's first reference red and the second hidden.
  s.components[1]!.parts.push({ part: 0, transform: multiply(translation(0, 50, 0), scaling(25.4)) });
  s.overrides.push({ path: [0, 1], ref: 0, material: 0, sources: [] }, { path: [0, 1], ref: 1, visible: false,
    sources: [] });
  const placed = [...partInstances(s)].map((p) => [p.path.join('/'), p.part, p.material, p.visible]);
  assert.deepEqual(placed, [
    ['0/0', 0, 1, true], ['0/0', 0, 1, true], ['0/0/0', 1, undefined, true],
    ['0/1', 0, 0, true], ['0/1', 0, 1, false], ['0/1/0', 1, undefined, true],
  ]);
  // Without a reference, the whole subtree, the bolt below included.
  s.overrides = [{ path: [0, 1], visible: false, sources: [] }];
  assert.deepEqual([...partInstances(s)].filter((p) => !p.visible).map((p) => p.path.join('/')), ['0/1', '0/1',
    '0/1/0']);
  assert.deepEqual(validate(s), []);
  s.overrides = [{ path: [0, 5], sources: [] }, { path: [0, 1], ref: 2, sources: [] }, { path: [], sources: [] },
    { path: [0], material: 9, sources: [] }];
  assert.deepEqual(validate(s), ['overrides[0]: path 0/5 leads nowhere',
    'overrides[1]: part reference 2 out of range', 'overrides[2]: path  leads nowhere',
    'overrides[3]: material 9 out of range']);
});
