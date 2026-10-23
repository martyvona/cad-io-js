// Needs the built module (./build.sh) and the corpus checkout's cube (test_corpus/third_party/pull.sh); skipped
// without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { partInstances, tessellateScene } from 'cad-scene';
import { importStep } from 'step-import';
import { MAX_MESSAGE_CHARS, MAX_MESSAGES, Messages, OcctTessellator } from '../src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const cube = path.join(root, 'test_corpus/third_party/occt-import-js/test/testfiles/cube-10x10mm/Cube 10x10.stp');
const built = fs.existsSync(path.join(import.meta.dirname, '../dist/occt_tess.wasm'));
const skip = !built ? 'tess-occt not built (run packages/tess-occt/build.sh)' : !fs.existsSync(
  cube) ? 'corpus not fetched' : false;

test('a 10 mm cube: faces with entity ids, edges, the origin subtracted in double precision', { skip }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(cube));
  assert.equal(scene.parts.length, 1);
  const part = scene.parts[0]!;
  assert.ok(part.kind === 'brep');
  const req = { format: 'step' as const, data: part.payload(), rootId: part.rootId, linearDeflection: 0.01,
    angularDeflection: 0.5, edges: true };
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
  const span = (a: Float32Array, k: number) => { let lo = Infinity, hi = -Infinity;
    for (let i = k; i < a.length; i += 3) { lo = Math.min(lo, a[i]!); hi = Math.max(hi, a[i]!); } return hi - lo; };
  assert.deepEqual([0, 1, 2].map((k) => span(plain.positions, k)), [10, 10, 10]);
  // With an origin, each position is the double-precision difference rounded once to float32 (the cube's coordinates
  // are exact in float32, so plain.positions holds them exactly).
  const origin: [number, number, number] = [1e7 + 0.1, -2e7 + 0.3, 0.7];
  const shifted = await tess.tessellate({ ...req, origin });
  assert.deepEqual(shifted.origin, origin);
  for (let i = 0; i < plain.positions.length; i++) assert.equal(shifted.positions[i],
    Math.fround(plain.positions[i]! - origin[i % 3]!));
  assert.equal(shifted.edgePositions![0], Math.fround(plain.edgePositions![0]! - origin[0]));
  // Through the driver: the importer's origin is the cube's centre.
  const { meshes } = await tessellateScene(scene, tess, { linearDeflection: 0.01, angularDeflection: 0.5 });
  const mesh = meshes.get(0)!;
  assert.deepEqual(mesh.origin, part.origin);
  assert.ok(mesh.positions.every((x) => Math.abs(x) <= 5 + 1e-6)); // within ±5 mm of the centre
  assert.equal([...partInstances(scene)].length, 1);
});

test('unreadable input: an error diagnostic, an empty result', { skip: built ? false : 'tess-occt not built' },
  async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const r = await tess.tessellate(
    { format: 'step', data: new TextEncoder().encode('not STEP'), linearDeflection: 1, angularDeflection: 0.5 });
  assert.equal(r.indices.length, 0);
  // OCCT's own message, then the failure.
  assert.deepEqual(r.diagnostics, [
    { severity: 'warning', message: 'OCCT: ERR StepFile : Undefined Parsing: Line 2: Incorrect syntax: unexpected TYPE,'
      + ' expecting STEP' },
    { severity: 'error', message: 'OCCT: read failed' },
  ]);
  await assert.rejects(new OcctTessellator().tessellate(
    { format: 'step', data: new Uint8Array(), linearDeflection: 1, angularDeflection: 0.5 }), /init/);
});

test("OCCT's messages: warnings on the part, never printed", { skip }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(cube));
  const part = scene.parts[0]!;
  assert.ok(part.kind === 'brep');
  // A reference to an entity that isn't there: OCCT prints a count of them, and reads the rest.
  const text = new TextDecoder().decode(part.payload());
  const end = text.lastIndexOf('ENDSEC;');
  const dangling = new TextEncoder().encode(
    `${text.slice(0, end)}#900000=VERTEX_POINT('',#900001);\n${text.slice(end)}`);
  const req = { format: 'step' as const, data: dangling, rootId: part.rootId, linearDeflection: 0.01,
    angularDeflection: 0.5 };
  const printed: unknown[] = [];
  const restore = [process.stdout, process.stderr].map((s) => {
    const write = s.write;
    s.write = ((c: unknown) => (printed.push(c), true)) as typeof s.write;
    return () => { s.write = write; };
  });
  let r, clean;
  try {
    r = await tess.tessellate(req);
    clean = await tess.tessellate({ ...req, data: part.payload() });
  } finally {
    for (const f of restore) f();
  }
  assert.deepEqual(printed, []);
  assert.deepEqual(r.diagnostics,
    [{ severity: 'warning', message: 'OCCT: ERR StepReaderData : Unresolved Reference : Fails Count : 1' }]);
  assert.equal(r.indices.length, 36);
  assert.deepEqual(clean.diagnostics, []);
});

test("OCCT's messages: at most MAX_MESSAGES of MAX_MESSAGE_CHARS in all, the rest counted", () => {
  const many = new Messages();
  for (let i = 0; i < MAX_MESSAGES + 3; i++) many.add(`*** ERR ${i} ***`);
  many.add('');
  const d = many.diagnostics();
  assert.equal(d.length, MAX_MESSAGES + 1);
  assert.deepEqual(d[0], { severity: 'warning', message: 'OCCT: ERR 0' });
  assert.equal(d.at(-1)!.message, 'OCCT: 3 more messages left out');
  const long = new Messages();
  long.add('a'.repeat(MAX_MESSAGE_CHARS - 10));
  long.add('b'.repeat(30));
  long.add('c');
  assert.deepEqual(long.diagnostics().map((x) => x.message),
    [`OCCT: ${'a'.repeat(MAX_MESSAGE_CHARS - 10)}`, `OCCT: ${'b'.repeat(10)}...`, 'OCCT: 1 more messages left out']);
  assert.deepEqual(new Messages().diagnostics(), []);
});

const gbssr = path.join(root, 'test_corpus/third_party/gkv311-opencascade-dataset/step/trj8_c2-ac-214.stp');
test("a geometrically bounded surface representation: the geometric set's surface meshed, with its id; a wireframe's "
  + "curve", { skip: skip || (!fs.existsSync(gbssr) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(gbssr));
  // The annotation-only representation #62 isn't a part; the wireframe #248 has no faces, only its curve set's
  // B-spline #72, returned without asking for edges.
  assert.deepEqual(scene.parts.map((p) => (p.kind === 'brep' ? p.rootId : undefined)), [248, 245]);
  const { meshes, diagnostics } = await tessellateScene(scene, tess, { linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(diagnostics, []);
  const wire = meshes.get(0)!;
  assert.deepEqual([wire.indices.length, wire.faces, wire.edges, wire.points], [0, [], undefined, undefined]);
  assert.deepEqual(wire.curves!.map((c) => [c.source, c.start]), [[72, 0]]);
  assert.ok(wire.curves![0]!.count > 2 && wire.curvePositions!.length === 3 * wire.curves![0]!.count);
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
    const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!],
      v = [p[l]! - p[i]!, p[l + 1]! - p[i + 1]!, p[l + 2]! - p[i + 2]!];
    a += Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
  }
  return a;
};
const closed = [step('trj4_k1_geo-pe-214.stp'), step('bug28414_bug_toroidal_surface.stp')];
test('a lone boundary on a sphere or torus: the small region in a geometric set, the face as written otherwise',
  { skip: skip || (!closed.every((f) => fs.existsSync(f)) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const areaOf = async (f: string) => {
    const { scene } = await importStep(fs.readFileSync(f));
    const p = scene.parts.find((q) => q.kind === 'brep' && !/WIREFRAME/.test(String(q.properties.representation)));
    assert.ok(p?.kind === 'brep');
    return area(await tess.tessellate(
      { format: 'step', data: p.payload(), rootId: p.rootId, origin: p.origin, linearDeflection: 0.2 / p.unit,
      angularDeflection: 0.3 }));
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

const mixed = step('trj6_as1-td-214.stp');
test("a solid with a curve set beside it: the set's curves and points, by id, minus the origin, apart from the edges",
  { skip: skip || (!fs.existsSync(mixed) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const { scene } = await importStep(fs.readFileSync(mixed));
  const p = scene.parts.find((q) => q.kind === 'brep' && q.rootId === 830);
  assert.ok(p?.kind === 'brep');
  const r = await tess.tessellate(
    { format: 'step', data: p.payload(), rootId: 830, origin: p.origin, linearDeflection: 0.1, angularDeflection: 0.5,
    edges: true });
  assert.ok(r.indices.length > 0);
  assert.ok(r.edges!.length > 0 && r.edges!.every((e) => e.kind !== 'free'));
  // #823's elements: the trimmed lines #807 and #812, and fourteen points.
  assert.deepEqual(r.curves!.map((c) => [c.entityId, c.count]), [[807, 2], [812, 2]]);
  assert.deepEqual([...r.pointIds!].sort(), [799, 800, 801, 802, 813, 814, 815, 816, 817, 818, 819, 820, 821, 822]);
  const at = (a: Float32Array, k: number) => [a[3 * k]!, a[3 * k + 1]!, a[3 * k + 2]!];
  assert.deepEqual(at(r.points!, r.pointIds!.indexOf(813)),
    [47.5 - p.origin[0], 62.00961894 - p.origin[1], -p.origin[2]].map(Math.fround));
  const ends = [0, 1].map((k) => at(r.curvePositions!, k));
  assert.ok(ends.some((q) => q.every((x, i) => Math.abs(x - [40, 75, 0][i]! + p.origin[i]!) < 1e-4)),
    JSON.stringify(ends));
  tess.dispose();
});

const wireframes = [step('trj6_c1-pe-214.stp'), step('trj5_k1-ct-214.stp')];
test("curve ids: a composite curve's segments take the composite's, an edge-based wireframe's curves their edges'",
  { skip: skip || (!wireframes.every((f) => fs.existsSync(f)) && 'corpus not fetched') }, async () => {
  const tess = new OcctTessellator();
  await tess.init();
  const ids = async (f: string, root: number) => {
    const { scene } = await importStep(fs.readFileSync(f));
    const p = scene.parts.find((q) => q.kind === 'brep' && q.rootId === root);
    assert.ok(p?.kind === 'brep');
    const r = await tess.tessellate(
      { format: 'step', data: p.payload(), rootId: root, origin: p.origin, linearDeflection: 0.1 / p.unit,
      angularDeflection: 0.5 });
    assert.deepEqual(r.diagnostics, []);
    return r.curves!.map((c) => c.entityId);
  };
  // #312 of four segments, #322 and #332 of one each.
  assert.deepEqual(await ids(wireframes[0]!, 537), [312, 312, 312, 312, 322, 332]);
  // Sixteen CONNECTED_EDGE_SETs of one EDGE_CURVE each.
  assert.deepEqual(await ids(wireframes[1]!, 38),
    [31, 47, 59, 69, 83, 95, 107, 117, 131, 143, 155, 165, 179, 191, 203, 213]);
  tess.dispose();
});
