import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { addLod, exportView, identity, multiply, partInstances, pruneView, scaling, tessellateScene, validate,
  viewDifferences, type Mat4, type Mesh, type Scene } from 'cad-scene';
import { threejsJson } from 'export-threejs';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { importThreejs } from '../src/index.ts';

const translation = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x; m[13] = y; m[14] = z;
  return m;
};

// The plate: faces 8, 7 and 9 (7 blue: its looks' triangles reordered by colour), an edge and a seam; the wire: a
// curve and a point.
const plate = (): Mesh => ({
  origin: [1, 0, 0],
  positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0.1, 2, 2, 0),
  normals: Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1),
  indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 1, 4, 2),
  faces: [{ source: 8, start: 0, count: 3 }, { source: 7, start: 3, count: 3 }, { source: 9, start: 6, count: 3 }],
  edgePositions: Float32Array.of(0, 0, 0, 1, 1, 0, 1, 0, 0, 1, 1, 0, 2, 2, 2),
  edges: [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 },
    { source: null, start: 2, count: 3, kind: 'seam' }],
});
const wire = (): Mesh => ({
  origin: [0, 0, 0], positions: new Float32Array(0), indices: new Uint32Array(0), faces: [],
  curvePositions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0), curves: [{ source: 9, start: 0, count: 3 }],
  points: Float32Array.of(5, 5, 5), pointSources: [11],
});

// An assembly with three instances of a subassembly holding the plate (in inches; green, face 7 blue) twice and the
// wire: the second instance red by override, the third hidden; the plate's second placement in the subassembly
// hidden by its reference. Materials: 0 red half opaque, 1 green, 2 blue.
function scene(): Scene {
  const occ = (component: number, t: Mat4, name?: string) => ({ component, transform: t,
    sources: [{ format: 'step', id: 100 + component }], properties: {}, ...(name ? { name } : {}) });
  const part = (name: string) => ({ name, sources: [{ format: 'step', id: 50 }], properties: { pn: 'X-1' }, unit: 1,
    origin: [0, 0, 0] as [number, number, number], lods: [] });
  const s: Scene = {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [],
        children: [occ(1, translation(100, 0, 0), 'left'), occ(1, translation(200, 0, 0)),
          occ(1, translation(300, 0, 0), 'hidden')] },
      { name: 'sub', sources: [{ format: 'step', id: 7 }], properties: { rev: 'B' },
        parts: [{ part: 0, transform: scaling(25.4) }, { part: 0, transform: multiply(translation(0, 50, 0),
          scaling(25.4)), visible: false }, { part: 1, transform: identity() }], children: [] },
    ],
    roots: [occ(0, translation(0, 0, 5))],
    parts: [{ ...part('plate'), material: 1, faceMaterials: [{ face: 7, material: 2 }], closed: true },
      part('wire')],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.5, sources: [] },
      { color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [],
    overrides: [{ path: [0, 1], material: 0, sources: [] }, { path: [0, 2], visible: false, sources: [] }],
    properties: { schema: 'AP214' },
    diagnostics: [],
  };
  addLod(s.parts[0]!, { mesh: plate(), from: 'tessellated' });
  addLod(s.parts[1]!, { mesh: wire(), from: 'tessellated' });
  return s;
}

const opts = { edges: true, curves: true };

test('our file with extras reads back as the scene it was written from: tree, parts, colours, hidden, lines', () => {
  const s = scene();
  const view = exportView(s, opts);
  const { scene: back, diagnostics } = importThreejs(threejsJson(s, view, { extras: true }));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(validate(back), []);
  assert.deepEqual(viewDifferences({ scene: s, view: pruneView(view) }, { scene: back, view: exportView(back, opts) }),
    []);
  // The same structure: components by index, parts shared, names, sources and properties.
  assert.deepEqual(back.components.map((c) => [c.name, c.parts.length, c.children.length]),
    [['asm', 0, 3], ['sub', 3, 0]]);
  assert.deepEqual(back.parts.map((p) => [p.name, p.sources, p.properties, p.closed, p.lods.length, p.lods[0]!.from]),
    [['plate', [{ format: 'step', id: 50 }], { pn: 'X-1' }, true, 1, 'source'],
      ['wire', [{ format: 'step', id: 50 }], { pn: 'X-1' }, undefined, 1, 'source']]);
  assert.deepEqual([back.components[1]!.sources, back.components[1]!.properties, back.properties],
    [[{ format: 'step', id: 7 }], { rev: 'B' }, { schema: 'AP214' }]);
  assert.deepEqual(back.components[0]!.children.map((c) => c.name), ['left', undefined, 'hidden']);
  // Faces by their ids, in the mesh's triangles; edges, curves and points with their sources.
  const m = back.parts[0]!.lods[0]!.mesh;
  assert.deepEqual(m.faces.map((f) => f.source).sort(), [7, 8, 9]);
  assert.deepEqual(m.edges, [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 }]);
  assert.deepEqual(back.parts[1]!.lods[0]!.mesh.pointSources, [11]);
  // The same placements, visible or not, each its colours.
  const visible = (sc: Scene) => [...partInstances(sc)].map((p) => [p.part, p.visible, p.material]);
  assert.deepEqual(visible(back), visible(s));
});

test('our file without extras: its tree and meshes, a part per material, metres back to millimetres', () => {
  const s = scene();
  const view = exportView(s, opts);
  const { scene: back } = importThreejs(threejsJson(s, view));
  assert.deepEqual(validate(back), []);
  // The root, then the tree as written (hidden instances included, as three.js JSON writes them).
  const names = (sc: Scene) => sc.components.map((c) => c.name);
  assert.deepEqual(names(back).slice(0, 3), ['', 'asm', 'left']);
  // The world: the same triangles where they were (positions in millimetres, Z up, again).
  const world = (sc: Scene) => {
    const v = exportView(sc);
    const pts: string[] = [];
    const walk = (n: (typeof v.roots)[number], t: Mat4) => {
      const w = multiply(t, n.transform);
      for (const p of n.parts) {
        const l = v.looks[p.look]!, wp = multiply(w, p.transform), pos = l.mesh.positions;
        for (const i of l.indices) pts.push([0, 1, 2].map((k) => Math.round((wp[k]! * pos[3 * i]! +
          wp[4 + k]! * pos[3 * i + 1]! + wp[8 + k]! * pos[3 * i + 2]! + wp[12 + k]!) * 1000) / 1000).join(','));
      }
      n.children.forEach((c) => walk(c, w));
    };
    v.roots.forEach((r) => walk(r, identity()));
    return pts.sort();
  };
  assert.deepEqual(world(back), world(s));
});

test('foreign three.js JSON: shared geometry one part, lines and points, materials, textures warned of', () => {
  const json = {
    metadata: { version: 4.6, type: 'Object' },
    geometries: [{ uuid: 'g', type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3,
      type: 'Float32Array', array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } } } },
    { uuid: 'l', type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3, type: 'Float32Array',
      array: [0, 0, 0, 1, 0, 0, 1, 1, 0] } } } },
    { uuid: 'b', type: 'BoxGeometry', width: 1 }],
    materials: [{ uuid: 'm', type: 'MeshStandardMaterial', color: 0xff8000, opacity: 0.5, map: 't' },
      { uuid: 'k', type: 'LineBasicMaterial', color: 0 }],
    textures: [{ uuid: 't' }],
    object: { uuid: 'r', type: 'Scene', name: 'scene', matrix: Array.from(identity()), children: [
      { uuid: 'a', type: 'Mesh', name: 'a', geometry: 'g', material: 'm', matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
        1, 0, 0, 1] },
      { uuid: 'b', type: 'Mesh', name: 'b', geometry: 'g', material: 'm', matrix: Array.from(identity()),
        visible: false },
      { uuid: 'c', type: 'Line', name: 'c', geometry: 'l', material: 'k', matrix: Array.from(identity()) },
      { uuid: 'd', type: 'Mesh', name: 'box', geometry: 'b', material: 'm', matrix: Array.from(identity()) }] },
  };
  const { scene: s, diagnostics } = importThreejs(JSON.stringify(json));
  assert.deepEqual(validate(s), []);
  assert.deepEqual(diagnostics.map((d) => d.message), ['textures are not supported: ignored',
    'geometries of type BoxGeometry: not read']);
  // One part for the mesh both nodes draw; the line a part of curves (a strip as two segments).
  assert.equal(s.parts.length, 2);
  assert.deepEqual(s.materials.map((m) => [m.color.map((c) => Math.round(c * 255)), m.opacity]),
    [[[255, 128, 0], 0.5], [[0, 0, 0], 1]]);
  const line = s.parts[1]!.lods[0]!.mesh;
  assert.equal(line.curves!.length, 2);
  assert.deepEqual(Array.from(line.curvePositions!), [0, 0, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0]);
  // The root from metres, Y up: (1, 0, 0) m is (1000, 0, 0) mm; b hidden.
  assert.deepEqual(Array.from(s.roots[0]!.transform).map((x) => Math.round(x)),
    [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual([...partInstances(s)].map((p) => [s.parts[p.part]!.name, p.visible]),
    [['a', true], ['a', false], ['c', true]]);
  // Not JSON, not three.js JSON: an error, an empty scene.
  assert.equal(importThreejs('{').diagnostics[0]!.severity, 'error');
  assert.equal(importThreejs({ metadata: {} }).diagnostics[0]!.severity, 'error');
  assert.equal(importThreejs('{').scene.diagnostics[0]!.severity, 'error');
});

const assembly = path.resolve(import.meta.dirname,
  '../../../test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
test('a STEP assembly through three.js JSON and back: the same drawing', { skip: fs.existsSync(assembly) ? false
  : 'corpus not fetched' }, async () => {
  const { scene: s } = await importStep(fs.readFileSync(assembly));
  const occt = new OcctTessellator();
  await occt.init();
  await tessellateScene(s, occt, { edges: true });
  occt.dispose();
  const view = exportView(s, opts);
  const { scene: back, diagnostics } = importThreejs(threejsJson(s, view, { extras: true }));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(viewDifferences({ scene: s, view: pruneView(view) }, { scene: back, view: exportView(back, opts) }),
    []);
});

test('foreign three.js JSON: an instanced mesh a placement per instance; an old file of ours in millimetres', () => {
  const geometry = { uuid: 'g', type: 'BufferGeometry', data: { attributes: { position: { itemSize: 3,
    type: 'Float32Array', array: [0, 0, 0, 1, 0, 0, 0, 1, 0] } } } };
  const at = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  const json = (userData: object) => ({ metadata: { version: 4.6, type: 'Object' }, geometries: [geometry],
    object: { uuid: 'r', type: 'Group', name: 'root', matrix: Array.from(identity()), userData, children: [
      { uuid: 'i', type: 'InstancedMesh', name: 'many', geometry: 'g', count: 2, matrix: at(5),
        instanceMatrix: { itemSize: 16, type: 'Float32Array', array: [...at(0), ...at(10)] } }] } });
  // The first corner of each placement in the world, x only.
  const xs = (s: Scene) => {
    const v = exportView(s);
    const out: number[] = [];
    const walk = (n: (typeof v.roots)[number], t: Mat4) => {
      const w = multiply(t, n.transform);
      for (const p of n.parts) out.push(Math.round(multiply(w, p.transform)[12]!));
      n.children.forEach((c) => walk(c, w));
    };
    v.roots.forEach((r) => walk(r, identity()));
    return out;
  };
  const { scene: s, diagnostics } = importThreejs(JSON.stringify(json({})));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(validate(s), []);
  // Metres to millimetres: the object at 5 m, its instances 0 and 10 m beyond.
  assert.deepEqual(xs(s), [5000, 15000]);
  // Our extras before 2026-10-24: millimetres, no up axis, no root matrix.
  assert.deepEqual(xs(importThreejs(JSON.stringify(json({ unit: 'millimetre' }))).scene), [5, 15]);
});

/** A square (face 5) and a triangle (face 6) whose third corner is where its second is (another vertex). */
const degenerate = (): Scene => {
  const s: Scene = { unit: 'millimetre', materials: [], layers: [], overrides: [], properties: {}, diagnostics: [],
    components: [{ name: 'c', sources: [], properties: {}, parts: [{ part: 0, transform: identity() }],
      children: [] }],
    roots: [{ component: 0, transform: identity(), sources: [], properties: {} }],
    parts: [{ name: 'p', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] }] };
  addLod(s.parts[0]!, { from: 'source', mesh: { origin: [0, 0, 0],
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 1, 1, 0),
    indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 0, 2, 4),
    faces: [{ source: 5, start: 0, count: 6 }, { source: 6, start: 6, count: 3 }] } });
  return s;
};
const DROPPED = '1 degenerate triangle dropped (two corners at one position)';
/** The triangles of each part's level, and the messages of the info diagnostics. */
const outcome = (s: Scene) => ({ triangles: s.parts.map((p) => p.lods[0]!.mesh.indices.length / 3),
  info: s.diagnostics.filter((d) => d.severity === 'info').map((d) => d.message) });

test('triangles with two corners at one position dropped from the file\'s meshes, said; kept on request', () => {
  const s = degenerate();
  for (const extras of [true, false]) {
    const json = threejsJson(s, exportView(s), { extras });
    assert.deepEqual(outcome(importThreejs(json).scene), { triangles: [2], info: [DROPPED] });
    assert.deepEqual(outcome(importThreejs(json, { dropDegenerate: false }).scene), { triangles: [3], info: [] });
  }
  // With extras, the face left empty keeps its entry (meshed, with nothing to draw).
  const faces = importThreejs(threejsJson(s, exportView(s), { extras: true })).scene.parts[0]!.lods[0]!.mesh.faces;
  assert.deepEqual(faces.map((f) => [f.source, f.count]), [[5, 6], [6, 0]]);
});

/** The degenerate-triangle scene's part measured, in inches, its level with its settings: as a backend leaves it. */
const measured = (): Scene => {
  const s = degenerate();
  const p = s.parts[0]!;
  p.unit = 25.4;
  p.measures = { by: 'OCCT test', faces: new Map([[5, { area: 1, perimeter: 4, valid: true }],
    [6, { area: 0.25, perimeter: 2.5, valid: false }]]) };
  Object.assign(p.lods[0]!, { from: 'tessellated', linearDeflection: 0.1, angularDeflection: 0.25,
    backend: 'OCCT test' });
  return s;
};
const measuresOf = (s: Scene) => ({ unit: s.parts[0]!.unit, measures: s.parts[0]!.measures,
  level: (({ linearDeflection, angularDeflection, backend }) => ({ linearDeflection, angularDeflection, backend }))(
    s.parts[0]!.lods[0]!) });
const WRITTEN = { unit: 25.4, measures: { by: 'OCCT test', faces: new Map([[5, { area: 1, perimeter: 4, valid: true }],
  [6, { area: 0.25, perimeter: 2.5, valid: false }]]) }, level: { linearDeflection: 0.1, angularDeflection: 0.25,
  backend: 'OCCT test' } };

test('our userData carries a part\'s measures, its level\'s settings and its unit back; without it, none', () => {
  const s = measured();
  assert.deepEqual(measuresOf(importThreejs(threejsJson(s, exportView(s), { extras: true })).scene), WRITTEN);
  const plain = importThreejs(threejsJson(s, exportView(s))).scene.parts[0]!;
  assert.deepEqual([plain.measures, plain.unit, plain.lods[0]!.linearDeflection], [undefined, 1, undefined]);
});
