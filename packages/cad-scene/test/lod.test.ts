import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addLod, chooseLod, exportView, identity, tessellateScene, type Lod, type Mesh, type Part,
  type Scene } from '../src/index.ts';

const mesh = (n: number): Mesh => ({ origin: [0, 0, 0], positions: new Float32Array(9 * n),
  indices: Uint32Array.from({ length: 3 * n }, (_, i) => i), faces: [] });
const part = (): Part => ({ name: 'p', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] });
const triangles = (l: Lod | undefined) => (l ? l.mesh.indices.length / 3 : 0);

test('addLod: finest first, those without a deflection after; ours replace ours at the same settings', () => {
  const p = part();
  addLod(p, { mesh: mesh(1), from: 'source' });
  addLod(p, { mesh: mesh(10), from: 'tessellated', linearDeflection: 0.2, angularDeflection: 0.5, backend: 'B' });
  addLod(p, { mesh: mesh(50), from: 'tessellated', linearDeflection: 0.05, angularDeflection: 0.5, backend: 'B' });
  addLod(p, { mesh: mesh(20), from: 'source', linearDeflection: 0.1 });
  assert.deepEqual(p.lods.map(triangles), [50, 20, 10, 1]);
  // The same backend and settings: replaced (in place of the old, by its deflection); another backend: beside it.
  addLod(p, { mesh: mesh(11), from: 'tessellated', linearDeflection: 0.2, angularDeflection: 0.5, backend: 'B' });
  addLod(p, { mesh: mesh(12), from: 'tessellated', linearDeflection: 0.2, angularDeflection: 0.5, backend: 'C' });
  assert.deepEqual(p.lods.map(triangles), [50, 20, 11, 12, 1]);
  // Rounding through degrees doesn't make a second.
  addLod(p, { mesh: mesh(13), from: 'tessellated', linearDeflection: 0.2,
    angularDeflection: (0.5 * 180 / Math.PI) * Math.PI / 180, backend: 'C' });
  assert.deepEqual(p.lods.map(triangles), [50, 20, 11, 13, 1]);
});

test('chooseLod: ours at the settings; else the coarsest not coarser, or the finest coarser; else the finest', () => {
  const p = part();
  assert.equal(chooseLod(p), undefined);
  addLod(p, { mesh: mesh(1), from: 'source' });
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.1 })), 1);
  addLod(p, { mesh: mesh(20), from: 'source', linearDeflection: 0.1 });
  addLod(p, { mesh: mesh(10), from: 'tessellated', linearDeflection: 0.2, angularDeflection: 0.5, backend: 'B' });
  addLod(p, { mesh: mesh(50), from: 'tessellated', linearDeflection: 0.05, angularDeflection: 0.26, backend: 'B' });
  // Exactly ours.
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.2, angularDeflection: 0.5 })), 10);
  // Not ours at these settings (another angle): the coarsest at or under 0.2, which is ours at 0.2 all the same.
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.2, angularDeflection: 0.1 })), 10);
  // Two of ours at 0.2, by angle: each exactly at its own settings, whatever their order.
  addLod(p, { mesh: mesh(15), from: 'tessellated', linearDeflection: 0.2, angularDeflection: 0.1, backend: 'B' });
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.2, angularDeflection: 0.1 })), 15);
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.2, angularDeflection: 0.5 })), 10);
  // 0.15: the coarsest not coarser, the source's 0.1; 0.01: all coarser, the finest of them (0.05).
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.15 })), 20);
  assert.equal(triangles(chooseLod(p, { linearDeflection: 0.01 })), 50);
  // Nothing wanted: the finest.
  assert.equal(triangles(chooseLod(p)), 50);
});

test('exportView uses each part\'s chosen level; tessellateScene adds its meshes as levels', async () => {
  const scene: Scene = {
    unit: 'millimetre', materials: [], layers: [], overrides: [], properties: {}, diagnostics: [],
    components: [{ name: 'c', sources: [], properties: {}, parts: [{ part: 0, transform: identity() }],
      children: [] }],
    roots: [{ component: 0, transform: identity(), sources: [], properties: {} }],
    parts: [{ ...part(), brep: { format: 'step', payload: () => new Uint8Array() } }],
  };
  addLod(scene.parts[0]!, { mesh: mesh(3), from: 'source' });
  const tess = {
    info: { name: 'fake', version: '9', license: 'x', formats: ['step' as const], supportsFaceIds: true,
      supportsEdges: false, supportsCurves: false },
    init: async () => {}, dispose: () => {},
    tessellate: async (req: { linearDeflection: number }) => ({ origin: [0, 0, 0] as [number, number, number],
      positions: new Float32Array(9 * 7), indices: Uint32Array.from({ length: req.linearDeflection < 0.1 ? 21 : 6 },
        (_, i) => i), faces: [], diagnostics: [] }),
  };
  // (The fake's triangles are all at one point: kept, not dropped as degenerate.)
  const o = { angularDeflection: 0.5, dropDegenerate: false, orient: false };
  await tessellateScene(scene, tess, { ...o, linearDeflection: 0.2 });
  await tessellateScene(scene, tess, { ...o, linearDeflection: 0.05 });
  const lods = scene.parts[0]!.lods;
  assert.deepEqual(lods.map((l) => [l.from, l.linearDeflection, l.backend, triangles(l)]),
    [['tessellated', 0.05, 'fake 9', 7], ['tessellated', 0.2, 'fake 9', 2], ['source', undefined, undefined, 3]]);
  const looked = (o: Parameters<typeof exportView>[1]) => exportView(scene, o).looks[0]!.indices.length / 3;
  assert.equal(looked({ linearDeflection: 0.2, angularDeflection: 0.5 }), 2);
  assert.equal(looked({ linearDeflection: 0.05, angularDeflection: 0.5 }), 7);
  assert.equal(looked({}), 7);
  // Again at 0.2: replaced, not added; failing at 0.05 removes ours at 0.05.
  await tessellateScene(scene, tess, { ...o, linearDeflection: 0.2 });
  assert.equal(scene.parts[0]!.lods.length, 3);
  tess.tessellate = async () => { throw new Error('boom'); };
  await tessellateScene(scene, tess, { ...o, linearDeflection: 0.05 });
  assert.deepEqual(scene.parts[0]!.lods.map((l) => l.linearDeflection), [0.2, undefined]);
});
