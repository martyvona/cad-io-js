// Needs the built module (./build.sh) and the corpus checkout's cube (test_corpus/third_party/pull.sh); skipped
// without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { partInstances, tessellateScene } from 'cad-scene';
import { importStep } from 'step-import';
import { OcctTessellator } from '../src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const cube = path.join(root, 'test_corpus/third_party/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp');
const built = fs.existsSync(path.join(import.meta.dirname, '../dist/occt_tess.wasm'));
const skip = !built ? 'tess-occt not built (run packages/tess-occt/build.sh)' : !fs.existsSync(cube) ? 'corpus not fetched' : false;

test('a 10 mm cube: faces with entity ids, edges, the origin subtracted in double precision', { skip }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(cube));
  assert.equal(scene.parts.length, 1);
  const part = scene.parts[0]!;
  assert.ok(part.kind === 'brep');
  const req = { format: 'step' as const, data: part.payload(), rootId: part.rootId, linearDeflection: 0.01, angularDeflection: 0.5, edges: true };
  const plain = await tess.tessellate(req);
  assert.deepEqual(plain.diagnostics, []);
  assert.deepEqual(plain.origin, [0, 0, 0]);
  // Six planar faces, each two triangles, each with a distinct ADVANCED_FACE id; twelve shared edges.
  assert.equal(plain.faces.length, 6);
  assert.ok(plain.faces.every((f) => f.entityId !== null && f.count === 6));
  assert.equal(new Set(plain.faces.map((f) => f.entityId)).size, 6);
  assert.equal(plain.indices.length, 36);
  assert.deepEqual(plain.edges!.map((e) => e.kind), Array(12).fill('shared'));
  assert.ok(plain.edges!.every((e) => e.entityId !== null && Math.abs(e.dihedral! - Math.PI / 2) < 1e-6));
  const span = (a: Float32Array, k: number) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < a.length; i += 3) { lo = Math.min(lo, a[i]!); hi = Math.max(hi, a[i]!); } return hi - lo; };
  assert.deepEqual([0, 1, 2].map((k) => span(plain.positions, k)), [10, 10, 10]);
  // With an origin, each position is the double-precision difference rounded once to float32 (the cube's coordinates
  // are exact in float32, so plain.positions holds them exactly).
  const origin: [number, number, number] = [1e7 + 0.1, -2e7 + 0.3, 0.7];
  const shifted = await tess.tessellate({ ...req, origin });
  assert.deepEqual(shifted.origin, origin);
  for (let i = 0; i < plain.positions.length; i++) assert.equal(shifted.positions[i], Math.fround(plain.positions[i]! - origin[i % 3]!));
  assert.equal(shifted.edgePositions![0], Math.fround(plain.edgePositions![0]! - origin[0]));
  // Through the driver: the importer's origin is the cube's centre.
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: 0.01, angularDeflection: 0.5 });
  const mesh = meshes.get(0)!;
  assert.deepEqual(mesh.origin, part.origin);
  assert.ok(mesh.positions.every((x) => Math.abs(x) <= 5 + 1e-6)); // within ±5 mm of the centre
  assert.equal([...partInstances(scene)].length, 1);
});

test('unreadable input: an error diagnostic, an empty result', { skip: built ? false : 'tess-occt not built' }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const r = await tess.tessellate({ format: 'step', data: new TextEncoder().encode('not STEP'), linearDeflection: 1, angularDeflection: 0.5 });
  assert.equal(r.indices.length, 0);
  assert.equal(r.diagnostics[0]?.severity, 'error');
  await assert.rejects(new OcctTessellator().tessellate({ format: 'step', data: new Uint8Array(), linearDeflection: 1, angularDeflection: 0.5 }), /init/);
});
