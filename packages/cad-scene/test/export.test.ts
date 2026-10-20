import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exportView, identity, scaling, type ExportNode, type Mat4, type Mesh, type Scene } from '../src/index.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};
const at = (m: Mat4) => [m[12], m[13], m[14]];

// The plate: three faces of one triangle each, in the order face 8, face 7, an unknown face.
const plate = (): Mesh => ({
  origin: [1, 0, 0], positions: new Float32Array(27), indices: Uint32Array.from({ length: 9 }, (_, i) => i),
  faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }, { source: null, start: 6, count: 3 }],
});
// The bolt: one face, and an edge.
const bolt = (): Mesh => ({
  origin: [0, 0, 0], positions: new Float32Array(9), indices: Uint32Array.of(0, 1, 2), faces: [{ source: 3, start: 0, count: 3 }],
  edgePositions: new Float32Array(6), edges: [{ source: 4, start: 0, count: 2, kind: 'free' }],
});

// An assembly (0) with two occurrences of a subassembly (1), each holding the plate in inches (part 0, green with
// face 7 blue), a part that failed to tessellate (part 3) and a bolt component (2) with the bolt (part 1) and a
// wireframe (part 2). Materials: 0 red, 1 green, 2 blue, 3 white.
function scene(): Scene {
  const occ = (component: number, t: Mat4, name?: string) => ({ component, transform: t, sources: [], properties: {}, ...(name ? { name } : {}) });
  const brep = (name: string, unit: number) => ({ kind: 'brep' as const, name, sources: [], properties: {}, unit, origin: [0, 0, 0] as [number, number, number], format: 'step' as const, payload: () => new Uint8Array() });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [], children: [occ(1, translation(100, 0, 0), 'left'), occ(1, translation(200, 0, 0))] },
      { name: 'sub', sources: [], properties: {}, parts: [{ part: 0, transform: scaling(25.4) }, { part: 3, transform: identity() }], children: [occ(2, translation(0, 10, 0))] },
      { name: 'bolt', sources: [], properties: {}, parts: [{ part: 1, transform: identity() }, { part: 2, transform: identity() }], children: [] },
    ],
    roots: [occ(0, identity())],
    parts: [
      { ...brep('plate', 25.4), material: 1, faceMaterials: [{ face: 7, material: 2 }] },
      brep('bolt', 1),
      { kind: 'curves', name: 'wire', sources: [], properties: {}, unit: 1, origin: [5, 0, 0], positions: new Float32Array(6), polylines: [{ start: 0, count: 2, source: 9 }] },
      brep('failed', 1),
    ],
    materials: [0, 1, 2, 3].map((i) => ({ color: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 1]][i] as [number, number, number], opacity: 1, sources: [] })),
    layers: [],
    overrides: [],
    properties: {},
    diagnostics: [],
  };
}
const meshes = () => new Map([[0, plate()], [1, bolt()]]);

const flat = (nodes: ExportNode[]): ExportNode[] => nodes.flatMap((n) => [n, ...flat(n.children)]);
const summary = (nodes: ExportNode[]) => flat(nodes).map((n) => [n.path.join('/'), n.name, n.parts.map((p) => p.look), at(n.transform)]);

test('exportView: the tree, shared looks, groups by material, origins', () => {
  const s = scene();
  const v = exportView(s, meshes());
  // The failed part and (without `curves`) the wireframe have nothing to draw; both plates share look 0.
  assert.deepEqual(summary(v.roots), [
    ['0', 'asm', [], [0, 0, 0]],
    ['0/0', 'left', [0], [100, 0, 0]], ['0/0/0', 'bolt', [1], [0, 10, 0]],
    ['0/1', 'sub', [0], [200, 0, 0]], ['0/1/0', 'bolt', [1], [0, 10, 0]],
  ]);
  assert.equal(v.looks.length, 2);
  const [p, b] = v.looks;
  // Face 8 and the unknown face take the plate's green; face 7 its own blue. Reordered: green faces first.
  assert.equal(p!.material, 1);
  assert.deepEqual(p!.groups, [{ material: 1, start: 0, count: 6 }, { material: 2, start: 6, count: 3 }]);
  assert.deepEqual([...p!.indices], [0, 1, 2, 6, 7, 8, 3, 4, 5]);
  assert.deepEqual(p!.faces, [{ source: 8, start: 0, count: 3 }, { source: null, start: 3, count: 3 }, { source: 7, start: 6, count: 3 }]);
  // The bolt is unstyled: one group with the viewer's default; its own indices; no edges without `edges`.
  assert.equal(b!.material, undefined);
  assert.deepEqual(b!.groups, [{ material: undefined, start: 0, count: 3 }]);
  assert.equal(b!.indices, b!.mesh.indices);
  assert.equal(b!.edges, false);
  // The plate's transform includes its origin, in inches: 1 inch along x.
  const node = v.roots[0]!.children[0]!;
  assert.deepEqual(at(node.parts[0]!.transform), [25.4, 0, 0]);
  assert.equal(node.parts[0]!.transform[0], 25.4);
  assert.equal(node.parts[0]!.visible, true);
});

test('exportView: overrides make new looks; hidden instances; a face material equal to the default', () => {
  const s = scene();
  s.overrides.push({ path: [0, 1], material: 3, sources: [] }, { path: [0, 1, 0], visible: false, sources: [] });
  let v = exportView(s, meshes());
  assert.deepEqual(summary(v.roots).map((x) => x[2]), [[], [0], [1], [2], [3]]);
  // The overridden plate is white throughout, so one group and the mesh's own order.
  assert.deepEqual(v.looks[2]!.groups, [{ material: 3, start: 0, count: 9 }]);
  assert.equal(v.looks[2]!.indices, v.looks[2]!.mesh.indices);
  assert.equal(v.looks[2]!.faces, v.looks[2]!.mesh.faces);
  // Its bolt is white too (the override recolours the subtree) and hidden.
  assert.equal(v.looks[3]!.material, 3);
  assert.equal(v.roots[0]!.children[1]!.children[0]!.parts[0]!.visible, false);
  // The wireframe has no faces, so only its default material tells its two instances apart.
  const wires = flat(exportView(s, meshes(), { curves: true }).roots).flatMap((n) => n.parts.slice(1).map((p) => p.look));
  assert.equal(new Set(wires).size, 2);
  // Face 7 green like the rest: one group.
  s.overrides = [];
  s.parts[0]!.faceMaterials = [{ face: 7, material: 1 }];
  v = exportView(s, meshes());
  assert.deepEqual(v.looks[0]!.groups, [{ material: 1, start: 0, count: 9 }]);
});

test('exportView: edges and curves on request', () => {
  const s = scene();
  const v = exportView(s, meshes(), { edges: true, curves: true });
  assert.deepEqual(summary(v.roots)[2]![2], [1, 2]);
  assert.equal(v.looks[1]!.edges, true);
  // The wireframe: a curves-only mesh, at its origin.
  const wire = v.looks[2]!;
  assert.deepEqual([wire.curves, wire.groups, wire.mesh.curves], [true, [], [{ source: 9, start: 0, count: 2 }]]);
  assert.deepEqual(at(v.roots[0]!.children[0]!.children[0]!.parts[1]!.transform), [5, 0, 0]);
  // A brep part with only curves is dropped without `curves`, kept with it.
  const m = meshes();
  m.set(1, { origin: [0, 0, 0], positions: new Float32Array(0), indices: new Uint32Array(0), faces: [], points: new Float32Array(3), pointSources: [11] });
  assert.deepEqual(summary(exportView(s, m).roots)[2]![2], []);
  const pts = exportView(s, m, { curves: true }).looks[1]!;
  assert.deepEqual([pts.part, pts.curves], [1, true]);
});

test('exportView: a mesh part without faces is one group; a component inside itself', () => {
  const s = scene();
  s.parts[1] = { kind: 'mesh', name: 'bolt', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], material: 0, lods: [{ ...bolt(), faces: [] }] };
  s.components[2]!.children.push({ component: 1, transform: identity(), sources: [], properties: {} }); // 1 → 2 → 1
  const v = exportView(s, new Map([[0, plate()]]));
  assert.deepEqual(v.looks[1]!.groups, [{ material: 0, start: 0, count: 3 }]);
  assert.equal(flat(v.roots).length, 5);
});
