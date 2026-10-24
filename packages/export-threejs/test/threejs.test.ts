import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { exportView, identity, multiply, scaling, type Mat4, type Mesh, type Scene } from 'cad-scene';
import { formatFloat32, threejsChunks, threejsJson } from '../src/index.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};

// The plate: two triangles (faces 7 and 8) on a unit square, with normals; one shared edge and one seam.
const plate = (): Mesh => ({
  origin: [1, 0, 0],
  positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.1),
  normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3),
  faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }],
  edgePositions: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 2, 2, 2),
  edges: [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 },
    { source: null, start: 2, count: 3, kind: 'seam' }],
});
// A wireframe: one curve of three points, and a point.
const wire = (): Mesh => ({
  origin: [0, 0, 0], positions: new Float32Array(0), indices: new Uint32Array(0), faces: [],
  curvePositions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), curves: [{ source: 9, start: 0, count: 3 }],
  points: Float32Array.of(5, 5, 5), pointSources: [11],
});

// An assembly with two instances of a subassembly holding the plate (in inches; green, face 7 blue, 50% opaque
// red for its second instance by override) and the wireframe. Materials: 0 red half opaque, 1 green, 2 blue.
function scene(): Scene {
  const occ = (component: number, t: Mat4, name?: string) => (
    { component, transform: t, sources: [{ format: 'step', id: 100 + component }], properties: {},
    ...(name ? { name } : {}) });
  const brep = (name: string, unit: number) => (
    { kind: 'brep' as const, name, sources: [{ format: 'step', id: 50 }], properties: { pn: 'X-1' }, unit,
    origin: [0, 0, 0] as [number, number, number], format: 'step' as const, payload: () => new Uint8Array() });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [],
        children: [occ(1, translation(100, 0, 0), 'left'), occ(1, translation(200, 0, 0))] },
      { name: 'sub', sources: [{ format: 'step', id: 7 }], properties: { rev: 'B' },
        parts: [{ part: 0, transform: scaling(25.4) }, { part: 1, transform: identity() }], children: [] },
    ],
    roots: [occ(0, identity())],
    parts: [{ ...brep('plate', 25.4), material: 1, faceMaterials: [{ face: 7, material: 2 }] }, brep('wire', 1)],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.5, sources: [] },
      { color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [],
    overrides: [{ path: [0, 1], material: 0, sources: [] }],
    properties: { schema: 'AP214' },
    diagnostics: [],
  };
}
const meshes = () => new Map([[0, plate()], [1, wire()]]);
const load = (json: string) => new THREE.ObjectLoader().parse(JSON.parse(json));
const byName = (root: THREE.Object3D, name: string) => { const out: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.name === name) out.push(o); }); return out; };

test('three.js JSON loads with ObjectLoader: tree, transforms, shared geometry, materials, userData', () => {
  const s = scene();
  const view = exportView(s, meshes());
  const root = load(threejsJson(s, view, { name: 'model', extras: true }));
  root.updateMatrixWorld(true);
  assert.equal(root.name, 'model');
  assert.deepEqual(root.userData, { unit: 'millimetre', properties: { schema: 'AP214' } });
  assert.deepEqual(root.children.map((c) => c.name), ['asm']);
  assert.deepEqual(root.children[0]!.children.map((c) => c.name), ['left', 'sub']);
  const left = root.children[0]!.children[0]!;
  assert.deepEqual(left.userData,
    { sources: [{ format: 'step', id: 101 }],
    component: { index: 1, name: 'sub', sources: [{ format: 'step', id: 7 }], properties: { rev: 'B' } } });

  // Without edges and curves, the wireframe has nothing to draw: each subassembly holds just the plate.
  const plates = byName(root, 'plate') as THREE.Mesh[];
  assert.equal(plates.length, 2);
  assert.ok(plates.every((p) => p instanceof THREE.Mesh) && byName(root, 'wire').length === 0);
  // World transform: the instance's translation, inches to mm, and the mesh's origin (1 inch along x).
  const expected = multiply(multiply(translation(100, 0, 0), scaling(25.4)), translation(1, 0, 0));
  plates[0]!.matrixWorld.elements.forEach((x, i) => assert.ok(Math.abs(x - expected[i]!) < 1e-9, `element ${i}`));
  // One geometry for both instances (same triangles and ranges), with groups for the two materials.
  assert.equal(plates[0]!.geometry, plates[1]!.geometry);
  const g = plates[0]!.geometry;
  assert.deepEqual(g.groups.map((x) => [x.start, x.count, x.materialIndex]), [[0, 3, 0], [3, 3, 1]]);
  assert.deepEqual(Array.from(g.getAttribute('position').array), Array.from(plate().positions));
  assert.deepEqual(Array.from(g.getAttribute('normal').array), Array.from(plate().normals!));
  assert.deepEqual(Array.from(g.index!.array), [0, 1, 2, 0, 2, 3]);
  // Materials: green and blue on the first; red, half opaque, on both groups of the overridden second.
  const colours = (m: THREE.Mesh) => (m.material as THREE.MeshStandardMaterial[]).map(
    (x) => [x.type, x.color.getHexString(), x.opacity, x.transparent, x.side]);
  assert.deepEqual(colours(plates[0]!),
    [['MeshStandardMaterial', '00ff00', 1, false, THREE.FrontSide],
    ['MeshStandardMaterial', '0000ff', 1, false, THREE.FrontSide]]);
  assert.deepEqual(colours(plates[1]!),
    [['MeshStandardMaterial', 'ff0000', 0.5, true, THREE.FrontSide],
    ['MeshStandardMaterial', 'ff0000', 0.5, true, THREE.FrontSide]]);
  assert.equal((plates[1]!.material as THREE.Material[])[0], (plates[1]!.material as THREE.Material[])[1]);
  assert.equal((plates[1]!.material as THREE.Material[])[0]!.name, 'red');
  // The part's ids and properties, and its faces as index ranges for picking.
  assert.deepEqual(plates[0]!.userData, {
    part: 0, sources: [{ format: 'step', id: 50 }], properties: { pn: 'X-1' },
    faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }],
  });
});

test('edges and curves on request; edge kinds; hidden instances; colours', () => {
  const s = scene();
  s.overrides.push({ path: [0, 0], visible: false, sources: [] });
  const view = exportView(s, meshes(), { edges: true, curves: true });
  const root = load(threejsJson(s, view, { doubleSided: true, defaultColor: [0, 0.5, 1], edgeColor: [0.2, 0.2, 0.2],
    extras: true }));
  const [p0, p1] = byName(root, 'plate') as THREE.Mesh[];
  assert.equal(p0!.visible, false);
  assert.equal(p1!.visible, true);
  assert.equal((p0!.material as THREE.Material[])[0]!.side, THREE.DoubleSide);
  // Edges: only the shared one by default (the seam hidden), as one segment.
  const edges = p0!.children.find((c) => c.name === 'edges') as THREE.LineSegments;
  assert.ok(edges instanceof THREE.LineSegments);
  assert.deepEqual(Array.from(edges.geometry.index!.array), [0, 1]);
  assert.deepEqual(edges.userData, { edges: [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 }] });
  assert.equal((edges.material as THREE.LineBasicMaterial).color.getHexString(), '333333');
  // All kinds on request: the seam's three points become two segments.
  const all = load(threejsJson(s, view, { edgeKinds: ['shared', 'seam'], extras: true }));
  const allEdges = (byName(all, 'plate')[0]!.children.find((c) => c.name === 'edges') as THREE.LineSegments);
  assert.deepEqual(Array.from(allEdges.geometry.index!.array), [0, 1, 2, 3, 3, 4]);
  assert.deepEqual(allEdges.userData.edges.map(
    (e: { source: number | null; start: number; count: number }) => [e.source, e.start, e.count]),
    [[4, 0, 2], [null, 2, 4]]);
  // The wireframe: a Group with its curve and point, in the default colour (it has no material).
  const [w] = byName(root, 'wire');
  assert.equal(w!.type, 'Group');
  const curves = w!.children.find((c) => c.name === 'curves') as THREE.LineSegments;
  assert.deepEqual(Array.from(curves.geometry.index!.array), [0, 1, 1, 2]);
  assert.deepEqual(curves.userData, { curves: [{ source: 9, start: 0, count: 4 }] });
  assert.equal((curves.material as THREE.LineBasicMaterial).color.getHexString(), '0080ff');
  const points = w!.children.find((c) => c.name === 'points') as THREE.Points;
  assert.ok(points instanceof THREE.Points);
  assert.deepEqual(Array.from(points.geometry.getAttribute('position').array), [5, 5, 5]);
  assert.deepEqual(points.userData, { points: [11] });
  const pm = points.material as THREE.PointsMaterial;
  assert.deepEqual([pm.color.getHexString(), pm.size, pm.sizeAttenuation], ['0080ff', 4, false]);
  // The second instance's wireframe is red by the override.
  const w1 = byName(root, 'wire')[1]!.children.find((c) => c.name === 'curves') as THREE.LineSegments;
  assert.equal((w1.material as THREE.LineBasicMaterial).color.getHexString(), 'ff0000');
});

test('without extras (the default): no userData anywhere, the same objects, geometries and materials', () => {
  const s = scene();
  const view = exportView(s, meshes(), { edges: true, curves: true });
  const plain = JSON.parse(threejsJson(s, view));
  assert.equal(JSON.stringify(plain).includes('"userData"'), false);
  // The same document as with extras, once its userData is taken out.
  const strip = (o: unknown): unknown => Array.isArray(o) ? o.map(strip) : o && typeof o === 'object'
    ? Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'userData').map(([k, v]) => [k, strip(v)])) : o;
  const full = JSON.parse(threejsJson(s, view, { extras: true }));
  assert.ok(JSON.stringify(full).includes('"userData"'));
  assert.deepEqual(plain, strip(full));
  const root = load(JSON.stringify(plain));
  root.traverse((o) => assert.deepEqual(o.userData, {}));
});

test('chunks: one document, deterministic, large arrays split', () => {
  const s = scene();
  // A big plate: 30,000 vertices, so arrays span several chunks.
  const big = plate();
  big.positions = Float32Array.from({ length: 90000 }, (_, i) => Math.fround(i * 0.001));
  big.normals = undefined;
  big.indices = Uint32Array.from({ length: 60000 }, (_, i) => i % 30000);
  big.faces = [{ source: 8, start: 0, count: 60000 }];
  const view = exportView(s, new Map([[0, big]]));
  const chunks = [...threejsChunks(s, view)];
  assert.ok(chunks.length > 10);
  const text = chunks.join('');
  assert.equal(text, threejsJson(s, view));
  assert.equal(threejsJson(s, exportView(s, new Map([[0, big]]))), text);
  const g = (load(text).getObjectByName('plate') as THREE.Mesh).geometry;
  assert.deepEqual(Array.from(g.getAttribute('position').array), Array.from(big.positions));
  assert.deepEqual(Array.from(g.index!.array), Array.from(big.indices));
});

test('formatFloat32: shortest form that reads back to the same float32', () => {
  assert.equal(formatFloat32(Math.fround(0.1)), '0.1');
  assert.equal(formatFloat32(Math.fround(-25.4)), '-25.4');
  assert.equal(formatFloat32(3), '3');
  assert.equal(formatFloat32(Math.fround(1e-7)), '1e-7');
  assert.equal(formatFloat32(NaN), 'null');
  let seed = 1;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 20000; i++) {
    const x = Math.fround((rand() - 0.5) * 10 ** Math.floor(rand() * 16 - 8));
    const t = formatFloat32(x);
    assert.equal(Math.fround(Number(t)), x, t);
    // No shorter precision would do.
    const digits = t.replace(/^-/, '').replace(/e.*$/, '').replace('.', '').replace(/^0+/, '').length;
    if (digits > 1 && !Number.isInteger(x)) assert.notEqual(Math.fround(Number(x.toPrecision(digits - 1))), x, t);
  }
});

test('tree nodes with nothing to draw beneath them left out, unless keepEmpty', () => {
  const s = scene();
  const names = (json: string) => {
    const out: string[] = [];
    load(json).traverse((o) => out.push(o.name));
    return out;
  };
  assert.deepEqual(names(threejsJson(s, exportView(s, new Map()))), ['']);
  assert.deepEqual(names(threejsJson(s, exportView(s, new Map()), { keepEmpty: true })), ['', 'asm', 'left', 'sub']);
  // With something to draw, the same either way.
  const view = exportView(s, meshes());
  assert.equal(threejsJson(s, view), threejsJson(s, view, { keepEmpty: true }));
});
