import assert from 'node:assert/strict';
import { test } from 'node:test';
import { identity, leafParts, partInstances, validate, type Mat4, type Scene } from '../src/index.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
const src = (id: number) => ({ format: 'step', id });

// An assembly (0) holding a subassembly (1) between two placements of a leaf (2, part 0, moved within it); the
// subassembly a leaf (3, part 1) and a part of its own beside a child; a component with an external reference (4)
// and one with a colour of its own (5), each with one part, which stay; a root leaf (2 again).
function scene(): Scene {
  const occ = (component: number, t: Mat4, name?: string, id?: number) => ({ component, transform: t,
    ...(name ? { name } : {}), sources: id === undefined ? [] : [src(id)],
    properties: (id === undefined ? {} : { id }) as Record<string, number> });
  const one = (name: string, part: number, t = identity()) => ({ name, sources: [src(100 + part)],
    properties: { partNumber: `pn-${name}` }, parts: [{ part, transform: t }], children: [] });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [], children: [occ(2, translation(10, 0, 0), 'leaf.1', 1),
        occ(1, translation(0, 20, 0)), occ(2, translation(30, 0, 0), undefined, 2), occ(4, identity()),
        occ(5, identity())] },
      { name: 'sub', sources: [], properties: {}, parts: [{ part: 2, transform: identity() }],
        children: [occ(3, translation(0, 0, 5), 'bolt.1', 3)] },
      one('leaf', 0, translation(1, 0, 0)),
      one('bolt', 1),
      { ...one('ext', 2), external: { uri: 'x.stp' } },
      { ...one('coloured', 2), material: 0 },
    ],
    roots: [occ(0, identity()), occ(2, translation(0, 0, 100), 'top', 4)],
    parts: ['plate', 'bolt', 'plain'].map((name) => ({ name, sources: [], properties: {},
      origin: [0, 0, 0] as [number, number, number], lods: [] })),
    materials: [{ color: [1, 0, 0], opacity: 1, sources: [] }, { color: [0, 1, 0], opacity: 1, sources: [] }],
    layers: [],
    overrides: [
      // The second leaf placement hidden, the subassembly's bolt green, the root leaf green, the subassembly hidden.
      { path: [0, 2], visible: false, sources: [] },
      { path: [0, 1, 0], material: 1, sources: [] },
      { path: [1], material: 1, sources: [] },
      { path: [0, 1], ref: 0, visible: false, sources: [] },
    ],
    properties: {},
    diagnostics: [],
  };
}

/** What's drawn, in order: each placed part's part, world translation, material and visibility. */
const drawn = (s: Scene) => [...partInstances(s)].map((p) => ({ part: p.part, at: [...p.transform].slice(12, 15),
  material: p.material, visible: p.visible })).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

test('leafParts: leaf products placed as part references, the drawing unchanged', () => {
  const before = scene(), s = scene();
  leafParts(s);
  assert.deepEqual(validate(s), []);
  assert.deepEqual(drawn(s), drawn(before));
  // The leaf components gone; the external and coloured ones kept, renumbered.
  assert.deepEqual(s.components.map((c) => c.name), ['asm', 'sub', 'ext', 'coloured']);
  const asm = s.components[0]!, sub = s.components[1]!;
  assert.deepEqual(asm.children.map((o) => s.components[o.component]!.name), ['sub', 'ext', 'coloured']);
  // The asm's two placements of the leaf, in their order, with the occurrences' names, sources and properties,
  // the product's apart, the transforms composed.
  assert.equal(asm.parts.length, 2);
  const [a, b] = asm.parts;
  assert.equal(a!.name, 'leaf.1');
  assert.deepEqual(a!.sources, [src(1)]);
  assert.deepEqual(a!.properties, { id: 1 });
  assert.deepEqual(a!.product, { name: 'leaf', sources: [src(100)], properties: { partNumber: 'pn-leaf' } });
  assert.deepEqual([...a!.transform].slice(12, 15), [11, 0, 0]);
  assert.equal(b!.name, undefined);
  assert.deepEqual([...b!.transform].slice(12, 15), [31, 0, 0]);
  // The subassembly's bolt after its own part.
  assert.deepEqual(sub.parts.map((r) => r.part), [2, 1]);
  assert.equal(sub.parts[1]!.name, 'bolt.1');
  // The root leaf a root part.
  assert.equal(s.roots.length, 1);
  assert.equal(s.rootParts?.length, 1);
  assert.equal(s.rootParts![0]!.name, 'top');
  assert.deepEqual([...s.rootParts![0]!.transform].slice(12, 15), [1, 0, 100]);
  // The overrides at the part references now: path and index.
  assert.deepEqual(s.overrides.map((o) => ({ path: o.path, ref: o.ref })), [
    { path: [0], ref: 1 }, { path: [0, 0], ref: 1 }, { path: [], ref: 0 }, { path: [0, 0], ref: 0 }]);
});

test('leafParts: a scene without leaves unchanged; a second pass changes nothing', () => {
  const s = scene();
  leafParts(s);
  const once = JSON.stringify(s, (_, v) => v instanceof Float64Array ? [...v] : v);
  leafParts(s);
  assert.equal(JSON.stringify(s, (_, v) => v instanceof Float64Array ? [...v] : v), once);
  assert.equal(s.components[0]!.parts[0]!.product?.name, 'leaf');
});

test('leafParts: a shared leaf placed under a placed subassembly, overrides along the path', () => {
  const s = scene();
  // The subassembly placed twice; the bolt in the second hidden.
  s.components[0]!.children.push({ component: 1, transform: translation(0, 40, 0), sources: [], properties: {} });
  s.overrides.push({ path: [0, 5, 0], visible: false, sources: [] });
  const before = structuredClone(s);
  leafParts(s);
  assert.deepEqual(drawn(s), drawn(before));
  assert.deepEqual(s.overrides.at(-1)!.path, [0, 3]);
  assert.equal(s.overrides.at(-1)!.ref, 1);
});

test('leafParts: an assembly of one placed product stays an assembly, a second pass too', () => {
  // An assembly (0) placing one leaf product (1): the leaf a part reference of it, the assembly kept.
  const s: Scene = {
    unit: 'millimetre',
    components: [
      { name: 'one', sources: [], properties: {}, parts: [], children: [{ component: 1, transform: identity(),
        name: 'only', sources: [], properties: {} }] },
      { name: 'leaf', sources: [], properties: {}, parts: [{ part: 0, transform: identity() }], children: [] },
    ],
    roots: [{ component: 0, transform: identity(), sources: [], properties: {} }],
    parts: [{ name: 'p', sources: [], properties: {}, origin: [0, 0, 0], lods: [] }],
    materials: [], layers: [], overrides: [], properties: {}, diagnostics: [],
  };
  leafParts(s);
  assert.deepEqual(s.components.map((c) => [c.name, c.parts.map((r) => r.name)]), [['one', ['only']]]);
  assert.equal(s.rootParts, undefined);
  leafParts(s);
  assert.deepEqual(s.components.map((c) => c.name), ['one']);
});
