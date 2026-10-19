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

const gbssr = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj8_c2-ac-214.stp');
test("a geometrically bounded surface representation: the geometric set's surface meshed, with its id", { skip: skip || (!fs.existsSync(gbssr) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(gbssr));
  // The annotation-only representation #62 isn't a part; the wireframe #248 has no faces.
  assert.deepEqual(scene.parts.map((p) => (p.kind === 'brep' ? p.rootId : undefined)), [248, 245]);
  const { meshes, diagnostics } = await tessellateScene(scene, tess, { linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(diagnostics, []);
  assert.equal(meshes.get(0), undefined);
  // One face, from the CURVE_BOUNDED_SURFACE #235 (styled green: the part's material).
  assert.deepEqual(meshes.get(1)!.faces.map((f) => f.source), [235]);
  assert.deepEqual(scene.materials[scene.parts[1]!.material!]!.color, [0, 1, 0]);
  tess.dispose();
});

const step = (name: string) => path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step', name);
const area = (r: { positions: Float32Array; indices: Uint32Array }) => {
  let a = 0;
  const p = r.positions, ix = r.indices;
  for (let k = 0; k < ix.length; k += 3) {
    const [i, j, l] = [ix[k]! * 3, ix[k + 1]! * 3, ix[k + 2]! * 3];
    const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!], v = [p[l]! - p[i]!, p[l + 1]! - p[i + 1]!, p[l + 2]! - p[i + 2]!];
    a += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  }
  return a;
};
const closed = [step('trj4_k1_geo-pe-214.stp'), step('bug28414_bug_toroidal_surface.stp')];
test('a lone boundary on a sphere or torus: the small region in a geometric set, the face as written otherwise', { skip: skip || (!closed.every((f) => fs.existsSync(f)) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const areaOf = async (f: string) => {
    const { scene } = await importStep(fs.readFileSync(f));
    const p = scene.parts.find((q) => q.kind === 'brep' && !/WIREFRAME/.test(String(q.properties.representation)));
    assert.ok(p?.kind === 'brep');
    return area(await tess.tessellate({ format: 'step', data: p.payload(), rootId: p.rootId, origin: p.origin, linearDeflection: 0.2 / p.unit, angularDeflection: 0.3 }));
  };
  // In inches: 9.07 as OCCT 7.6 reads it, matching the other writers' copies of the model (tc 5838 mm², md 5756 mm²);
  // 10.56 with OCCT 8's natural bounds on the six curve-bounded spheres and tori.
  const gbssr = await areaOf(closed[0]!);
  assert.ok(Math.abs(gbssr - 9.07) < 0.05, `${gbssr}`);
  // OCCT's own test of bug 28414 expects 3593.35 mm²; with the 7.6 healing it would be 156.
  const face = await areaOf(closed[1]!);
  assert.ok(Math.abs(face - 3593.35) < 0.01 * 3593.35, `${face}`);
  tess.dispose();
});
