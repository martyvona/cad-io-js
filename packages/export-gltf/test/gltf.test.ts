import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebIO, type Node, type Primitive } from '@gltf-transform/core';
import { EXTMeshGPUInstancing, EXTMeshoptCompression, KHRDracoMeshCompression, KHRMaterialsUnlit,
  KHRMeshQuantization, KHRNodeVisibility, type InstancedMesh } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import validator from 'gltf-validator';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import { exportView, identity, multiply, scaling, type ExportView, type Mat4, type Mesh,
  type Scene } from 'cad-scene';
import { base64, decompose, glb as glbOf, gltfJson as gltfJsonOf, GltfError, MAX_DRACO_FACES, reorderWithinFaces,
  ROOT_TRANSFORM, srgbToLinear, type GltfOptions } from '../src/index.ts';

// Most tests check the structure: uncompressed, with extras (the defaults, compressed and without, are tested last).
const PLAIN: GltfOptions = { compression: 'none', extras: true };
const glb = (s: Scene, v: ExportView, o: GltfOptions = {}) => glbOf(s, v, { ...PLAIN, ...o });
const gltfJson = (s: Scene, v: ExportView, bin: string | undefined, o: GltfOptions = {}) => gltfJsonOf(s, v, bin,
  { ...PLAIN, ...o });

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
    { name, sources: [{ format: 'step', id: 50 }], properties: { pn: 'X-1' }, unit,
    origin: [0, 0, 0] as [number, number, number], lods: [],
    brep: { format: 'step' as const, payload: () => new Uint8Array() } });
  return {
    unit: 'millimetre',
    components: [
      { name: 'asm', sources: [], properties: {}, parts: [],
        children: [occ(1, translation(100, 0, 0), 'left'), occ(1, translation(200, 0, 0))] },
      { name: 'sub', sources: [{ format: 'step', id: 7 }], properties: { rev: 'B' },
        parts: [{ part: 0, transform: scaling(25.4) }, { part: 1, transform: identity() }], children: [] },
    ],
    roots: [occ(0, identity())],
    // The plate open (as the source would say); the wireframe saying nothing.
    parts: [{ ...brep('plate', 25.4), material: 1, faceMaterials: [{ face: 7, material: 2 }], closed: false },
      brep('wire', 1)],
    materials: [{ name: 'red', color: [1, 0, 0], opacity: 0.5, sources: [] },
      { color: [0, 1, 0], opacity: 1, sources: [] }, { color: [0, 0, 1], opacity: 1, sources: [] }],
    layers: [],
    overrides: [{ path: [0, 1], material: 0, sources: [] }],
    properties: { schema: 'AP214' },
    diagnostics: [],
  };
}
const meshes = () => new Map([[0, plate()], [1, wire()]]);
/** The export view of a copy of the scene with these meshes as its parts' levels (as tessellateScene adds them). */
const viewOf = (s: Scene, m: ReadonlyMap<number, Mesh>, o?: Parameters<typeof exportView>[1]) => exportView({ ...s,
  parts: s.parts.map((p, i) => (m.has(i) ? { ...p, lods: [{ from: 'tessellated' as const, mesh: m.get(i)! }] } : p)) },
o);
const io = new WebIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility, EXTMeshGPUInstancing]);

/** The validator's issues, as code and pointer, for a GLB (or .gltf JSON with its resources). */
async function issues(bytes: Uint8Array, resources: Record<string, Uint8Array> = {}): Promise<string[]> {
  const report = await validator.validateBytes(bytes,
    { maxIssues: 0, externalResourceFunction: async (uri: string) => resources[uri]! });
  return report.issues.messages.map((m) => `${m.code} ${m.pointer ?? ''}`);
}
const byName = (nodes: Node[], name: string) => nodes.filter((n) => n.getName() === name);
/** A part node's child of that name (edges, curves, points), and its one primitive. */
const child = (n: Node, name: string) => n.listChildren().find((c) => c.getName() === name);
const linePrim = (n: Node, name: string) => child(n, name)!.getMesh()!.listPrimitives()[0]!;
const linear = (c: number[]) => [...c.slice(0, 3).map(srgbToLinear), c[3]!];
const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9) => a.length === b.length && Array.from(a).every(
  (x, i) => Math.abs(x - b[i]!) <= eps);

test('GLB: valid; the tree, transforms to metres and Y up, shared accessors, materials, extras', async () => {
  const s = scene();
  const out = await glb(s, viewOf(s, meshes()), { name: 'model' });
  assert.deepEqual(out.diagnostics, []);
  assert.deepEqual(await issues(out.bytes), []);
  const doc = await io.readBinary(out.bytes);
  const root = doc.getRoot();
  assert.equal(root.listScenes().length, 1);
  assert.equal(root.listScenes()[0]!.getName(), 'model');
  const [top] = root.listScenes()[0]!.listChildren();
  assert.equal(top!.getName(), 'model');
  assert.ok(close(top!.getMatrix(), ROOT_TRANSFORM));
  assert.deepEqual(top!.getExtras(), { unit: 'millimetre', up: 'z', properties: { schema: 'AP214' } });
  assert.deepEqual(top!.listChildren().map((c) => c.getName()), ['asm']);
  const asm = top!.listChildren()[0]!;
  assert.deepEqual(asm.listChildren().map((c) => c.getName()), ['left', 'sub']);
  assert.deepEqual(asm.listChildren()[0]!.getExtras(),
    { sources: [{ format: 'step', id: 101 }],
    component: { index: 1, name: 'sub', sources: [{ format: 'step', id: 7 }], properties: { rev: 'B' } },
    path: [0, 0] });

  // Without edges and curves the wireframe has nothing to draw: a node without a mesh.
  const nodes = root.listNodes();
  const plates = byName(nodes, 'plate');
  assert.equal(plates.length, 2);
  assert.ok(byName(nodes, 'wire').every((w) => w.getMesh() === null));
  // World: metres and Y up, the instance's translation, inches to mm, the mesh's origin (1 inch along x).
  const expected = multiply(multiply(multiply(ROOT_TRANSFORM, translation(100, 0, 0)), scaling(25.4)),
    translation(1, 0, 0));
  assert.ok(close(plates[0]!.getWorldMatrix(), expected, 1e-12));
  // 1 mm along x, y (back) and z (up) in the root's space is 1 mm along x, -z and y (up) in glTF's metres: a
  // rotation, not a mirror.
  assert.deepEqual(Array.from(ROOT_TRANSFORM), [0.001, 0, 0, 0, 0, 0, -0.001, 0, 0, 0.001, 0, 0, 0, 0, 0, 1]);
  // Two looks (the second overridden red), so two meshes, sharing the plate's vertex accessors.
  const [m0, m1] = plates.map((p) => p.getMesh()!);
  assert.notEqual(m0, m1);
  const prims = (m: typeof m0) => m!.listPrimitives();
  assert.equal(prims(m0)[0]!.getAttribute('POSITION'), prims(m1)[0]!.getAttribute('POSITION'));
  assert.equal(prims(m0)[0]!.getAttribute('NORMAL'), prims(m1)[0]!.getAttribute('NORMAL'));
  assert.deepEqual(Array.from(prims(m0)[0]!.getAttribute('POSITION')!.getArray()!), Array.from(plate().positions));
  assert.deepEqual(Array.from(prims(m0)[0]!.getAttribute('NORMAL')!.getArray()!), Array.from(plate().normals!));
  assert.deepEqual(prims(m0).map((p) => [p.getMode(), Array.from(p.getIndices()!.getArray()!)]),
    [[4, [0, 1, 2]], [4, [0, 2, 3]]]);
  assert.ok(prims(m0)[0]!.getIndices()!.getArray() instanceof Uint16Array);
  // The second is red all over, so one primitive with the mesh's own triangles.
  assert.deepEqual(prims(m1).map((p) => [p.getMode(), Array.from(p.getIndices()!.getArray()!)]),
    [[4, [0, 1, 2, 0, 2, 3]]]);
  // Materials: green and blue, linear, not metallic, fully rough, single-sided; red half opaque, blended.
  const mat = (p: Primitive) => { const m = p.getMaterial()!;
    return [m.getName(), ...m.getBaseColorFactor(), m.getMetallicFactor(), m.getRoughnessFactor(), m.getAlphaMode(),
    m.getDoubleSided()]; };
  assert.deepEqual(prims(m0).map(mat),
    [['', ...linear([0, 1, 0, 1]), 0, 1, 'OPAQUE', false], ['', ...linear([0, 0, 1, 1]), 0, 1, 'OPAQUE', false]]);
  assert.deepEqual(prims(m1).map(mat), [['red', ...linear([1, 0, 0, 0.5]), 0, 1, 'BLEND', false]]);
  assert.deepEqual([...prims(m0), ...prims(m1)].map((p) => p.getMaterial()!.getExtras()),
    [{ material: 1 }, { material: 2 }, { material: 0 }]);
  // Without the override both instances have one look, so one mesh.
  const plain = scene();
  plain.overrides = [];
  const shared = byName((await io.readBinary(
    (await glb(plain, viewOf(plain, meshes()))).bytes)).getRoot().listNodes(), 'plate');
  assert.equal(shared[0]!.getMesh(), shared[1]!.getMesh());
  assert.equal((await io.readBinary(
    (await glb(plain, viewOf(plain, meshes()))).bytes)).getRoot().listMeshes().length, 1);
  // The part's ids and properties; each primitive's faces as ranges of its own indices.
  assert.deepEqual(plates[0]!.getExtras(),
    { part: 0, closed: false, sources: [{ format: 'step', id: 50 }], properties: { pn: 'X-1' } });
  assert.deepEqual(prims(m0).map((p) => p.getExtras()),
    [{ faces: [{ source: 8, start: 0, count: 3 }] }, { faces: [{ source: 7, start: 0, count: 3 }] }]);
});

test('edges, curves and points on request; edge kinds; hidden instances left out or KHR_node_visibility; colours',
  async () => {
  const s = scene();
  s.overrides.push({ path: [0, 0], visible: false, sources: [] });
  const view = viewOf(s, meshes(), { edges: true, curves: true });
  // Hidden instances left out by default, with a warning: one plate and one wire, of the second instance.
  const omitted = await glb(s, view);
  assert.deepEqual(omitted.diagnostics,
    [{ severity: 'warning', message: '2 hidden part instances left out (glTF has no visibility without '
    + 'KHR_node_visibility)' }]);
  assert.deepEqual(await issues(omitted.bytes), []);
  const od = await io.readBinary(omitted.bytes);
  assert.equal(byName(od.getRoot().listNodes(), 'plate').length, 1);
  assert.deepEqual(od.getRoot().listExtensionsUsed(), []);
  // Or written hidden: the extension used, not required (viewers without it show them).
  const kept = await glb(s, view,
    { hidden: 'extension', doubleSided: true, defaultColor: [0, 0.5, 1], edgeColor: [0.2, 0.2, 0.2] });
  assert.deepEqual(kept.diagnostics, []);
  // The validator doesn't know KHR_node_visibility.
  assert.deepEqual(await issues(kept.bytes), ['UNSUPPORTED_EXTENSION /extensionsUsed/0']);
  const json = (await io.binaryToJSON(kept.bytes)).json;
  assert.deepEqual([json.extensionsUsed, json.extensionsRequired], [['KHR_node_visibility'], undefined]);
  const doc = await io.readBinary(kept.bytes);
  const nodes = doc.getRoot().listNodes();
  const visible = (n: Node) => (
    n.getExtension('KHR_node_visibility') as unknown as { getVisible(): boolean } | null)?.getVisible() ?? true;
  const [p0, p1] = byName(nodes, 'plate');
  assert.deepEqual([visible(p0!), visible(p1!)], [false, true]);
  // Faces in the part's mesh; edges a child node with a mesh of its own, at the part's place.
  const prims = p0!.getMesh()!.listPrimitives();
  assert.deepEqual(prims.map((p) => p.getMode()), [4, 4]);
  assert.equal(prims[0]!.getMaterial()!.getDoubleSided(), true);
  assert.deepEqual(p0!.listChildren().map((c) => c.getName()), ['edges']);
  assert.deepEqual(child(p0!, 'edges')!.getMatrix(), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.equal(child(p0!, 'edges')!.getMesh()!.listPrimitives().length, 1);
  // The edges' mesh is shared by both instances (black either way), though their faces differ.
  assert.equal(child(p0!, 'edges')!.getMesh(), child(p1!, 'edges')!.getMesh());
  assert.notEqual(p0!.getMesh(), p1!.getMesh());
  // Edges: only the shared one by default (the seam hidden), as one segment, in the edge colour.
  const edges = linePrim(p0!, 'edges');
  assert.deepEqual(Array.from(edges.getIndices()!.getArray()!), [0, 1]);
  assert.deepEqual(Array.from(edges.getAttribute('POSITION')!.getArray()!), Array.from(plate().edgePositions!));
  assert.deepEqual(edges.getExtras(), { edges: [{ source: 4, start: 0, count: 2, kind: 'shared', dihedral: 0.5 }] });
  assert.ok(close(edges.getMaterial()!.getBaseColorFactor(), linear([0.2, 0.2, 0.2, 1])));
  // All kinds on request: the seam's three points become two segments.
  const all = await io.readBinary((await glb(s, view, { edgeKinds: ['shared', 'seam'], hidden: 'extension' })).bytes);
  const allEdges = linePrim(byName(all.getRoot().listNodes(), 'plate')[0]!, 'edges');
  assert.deepEqual(Array.from(allEdges.getIndices()!.getArray()!), [0, 1, 2, 3, 3, 4]);
  assert.deepEqual((allEdges.getExtras() as {
    edges: { source: number | null; start: number; count: number }[] }).edges.map((e) => [e.source, e.start, e.count]),
    [[4, 0, 2], [null, 2, 4]]);
  // The wireframe: its curve and point, in the default colour (it has no material); red for the second instance.
  const [w0, w1] = byName(nodes, 'wire');
  assert.equal(w0!.getMesh(), null);
  assert.deepEqual(w0!.listChildren().map((c) => c.getName()), ['curves', 'points']);
  const [curve, point] = [linePrim(w0!, 'curves'), linePrim(w0!, 'points')];
  assert.deepEqual([curve!.getMode(), Array.from(curve!.getIndices()!.getArray()!)], [1, [0, 1, 1, 2]]);
  assert.deepEqual(curve!.getExtras(), { curves: [{ source: 9, start: 0, count: 4 }] });
  assert.ok(close(curve!.getMaterial()!.getBaseColorFactor(), linear([0, 0.5, 1, 1])));
  assert.deepEqual([point!.getMode(), Array.from(point!.getAttribute('POSITION')!.getArray()!), point!.getExtras()],
    [0, [5, 5, 5], { points: [11] }]);
  assert.ok(close(linePrim(w1!, 'curves').getMaterial()!.getBaseColorFactor(), linear([1, 0, 0, 0.5])));
  // Different colours, so different curve meshes; lit by default.
  assert.notEqual(child(w0!, 'curves')!.getMesh(), child(w1!, 'curves')!.getMesh());
  assert.equal(curve!.getMaterial()!.getExtension('KHR_materials_unlit'), null);
});

test('edges, curves and points left out on request, each or all; unlit on request', async () => {
  const s = scene();
  const view = viewOf(s, meshes(), { edges: true, curves: true });
  const names = async (opts: Parameters<typeof glb>[2]) => {
    const doc = await io.readBinary((await glb(s, view, opts)).bytes);
    return [...new Set(doc.getRoot().listNodes().filter(
      (n) => (n.getExtras() as { part?: number }).part !== undefined).flatMap(
      (n) => n.listChildren().map((c) => c.getName())))].sort();
  };
  assert.deepEqual(await names({}), ['curves', 'edges', 'points']);
  assert.deepEqual(await names({ exclude: ['edges'] }), ['curves', 'points']);
  assert.deepEqual(await names({ exclude: ['curves'] }), ['edges', 'points']);
  assert.deepEqual(await names({ exclude: ['points'] }), ['curves', 'edges']);
  assert.deepEqual(await names({ exclude: ['edges', 'curves', 'points'] }), []);
  // Curves without points: just the curves.
  const noPoints = new Map([[0, plate()], [1, { ...wire(), points: undefined, pointSources: undefined }]]);
  const np = await io.readBinary((await glb(s, viewOf(s, noPoints, { curves: true }))).bytes);
  assert.deepEqual(byName(np.getRoot().listNodes(), 'wire').map((w) => w.listChildren().map((c) => c.getName())),
    [['curves'], ['curves']]);
  // Unlit: edges, curves and points with KHR_materials_unlit (which the validator knows); faces lit.
  const out = await glb(s, view, { unlitLines: true });
  assert.deepEqual(await issues(out.bytes), []);
  const json = (await io.binaryToJSON(out.bytes)).json;
  assert.deepEqual([json.extensionsUsed, json.extensionsRequired], [['KHR_materials_unlit'], undefined]);
  const doc = await io.readBinary(out.bytes);
  const unlit = (m: { getExtension(n: string): unknown } | null) => m!.getExtension('KHR_materials_unlit') !== null;
  const [p0] = byName(doc.getRoot().listNodes(), 'plate');
  const [w0] = byName(doc.getRoot().listNodes(), 'wire');
  assert.deepEqual([...p0!.getMesh()!.listPrimitives().map((p) => unlit(p.getMaterial())),
    unlit(linePrim(p0!, 'edges').getMaterial()), unlit(linePrim(w0!, 'curves').getMaterial()),
    unlit(linePrim(w0!, 'points').getMaterial())], [false, false, true, true, true]);
  // The wire's curves (no material) and the plate's faces in the default colour: different materials when unlit.
  const plain = scene();
  plain.parts[0] = { ...plain.parts[0]!, material: undefined, faceMaterials: [] } as typeof plain.parts[0];
  plain.overrides = [];
  const d2 = await io.readBinary(
    (await glb(plain, viewOf(plain, meshes(), { curves: true }), { unlitLines: true })).bytes);
  const [pp] = byName(d2.getRoot().listNodes(), 'plate');
  const [ww] = byName(d2.getRoot().listNodes(), 'wire');
  assert.notEqual(pp!.getMesh()!.listPrimitives()[0]!.getMaterial(), linePrim(ww!, 'curves').getMaterial());
});

test('.gltf: JSON naming its .bin, valid, the same as the GLB; deterministic; 32-bit indices past 65535 vertices',
  async () => {
  const s = scene();
  const view = viewOf(s, meshes(), { edges: true, curves: true });
  const out = await gltfJson(s, view, 'model.bin');
  const json = JSON.parse(out.json);
  assert.deepEqual(json.buffers, [{ uri: 'model.bin', byteLength: out.bin.length }]);
  assert.deepEqual(await issues(new TextEncoder().encode(out.json), { 'model.bin': out.bin }), []);
  const fromJson = await io.readJSON({ json, resources: { 'model.bin': out.bin as Uint8Array<ArrayBuffer> } });
  const fromGlb = await io.readBinary((await glb(s, view)).bytes);
  assert.deepEqual(fromJson.getRoot().listNodes().map((n) => [n.getName(), n.getMatrix()]),
    fromGlb.getRoot().listNodes().map((n) => [n.getName(), n.getMatrix()]));
  assert.deepEqual((await glb(s, view)).bytes,
    (await glb(s, viewOf(s, meshes(), { edges: true, curves: true }))).bytes);
  // Embedded: one JSON with the same buffer as a base64 data URI, valid, read back the same.
  const embedded = await gltfJson(s, view, undefined);
  assert.equal(embedded.bin.length, 0);
  const ej = JSON.parse(embedded.json);
  assert.deepEqual(ej.buffers,
    [{ uri: `data:application/octet-stream;base64,${Buffer.from(out.bin).toString('base64')}`,
    byteLength: out.bin.length }]);
  assert.deepEqual(await issues(new TextEncoder().encode(embedded.json)), []);
  const fromEmbedded = await io.readJSON({ json: ej, resources: {} });
  assert.deepEqual(fromEmbedded.getRoot().listAccessors().map((a) => Array.from(a.getArray()!)),
    fromJson.getRoot().listAccessors().map((a) => Array.from(a.getArray()!)));
  // 70,002 vertices, three to a triangle (x along a strip, y alternating, so none is degenerate): indices need 32 bits.
  const big = plate();
  const n = 70002;
  big.positions = Float32Array.from({ length: 3 * n }, (_, i) => {
    const v = Math.floor(i / 3);
    return i % 3 === 0 ? Math.fround(v * 0.001) : i % 3 === 1 ? v % 3 === 1 ? 1 : 0 : 0;
  });
  big.normals = undefined;
  big.indices = Uint32Array.from({ length: n }, (_, i) => i);
  big.faces = [{ source: 8, start: 0, count: n }];
  const bigOut = await glb(s, viewOf(s, new Map([[0, big]])));
  assert.deepEqual(await issues(bigOut.bytes), []);
  const ix = (await io.readBinary(bigOut.bytes)).getRoot().listMeshes()[0]!.listPrimitives()[
    0]!.getIndices()!.getArray()!;
  assert.ok(ix instanceof Uint32Array);
  assert.equal(ix[69999], 69999);
});

test('transforms written exactly, however close to identity; a scene with nothing to draw has no buffer', async () => {
  const s = scene();
  // A rotation of 1e-6 rad about z and a translation of 1e-7 mm, which glTF-Transform's own writer would leave out.
  const t = identity();
  const a = 1e-6;
  t[0] = Math.cos(a); t[1] = Math.sin(a); t[4] = -Math.sin(a); t[5] = Math.cos(a); t[12] = 1e-7;
  s.components[0]!.children[0]!.transform = t;
  const doc = await io.readBinary((await glb(s, viewOf(s, meshes()))).bytes);
  const left = doc.getRoot().listNodes().find((n) => n.getName() === 'left')!;
  assert.deepEqual(left.getTranslation(), [1e-7, 0, 0]);
  assert.ok(Math.abs(left.getRotation()[2] - Math.sin(a / 2)) < 1e-15);
  // Nothing to draw: the root alone (or with the instance tree, kept), no accessors, no buffer.
  for (const [keepEmpty, names] of [[false, [undefined]], [true, [undefined, 'asm', 'left', 'sub']]] as const) {
    const empty = await glb(s, viewOf(s, new Map()), { keepEmpty });
    assert.deepEqual(await issues(empty.bytes), []);
    const json = (await io.binaryToJSON(empty.bytes)).json;
    assert.deepEqual([json.buffers, json.accessors, json.nodes!.map((n) => n.name)], [undefined, undefined, names]);
  }
});

test('base64: as Node encodes it, across pieces', () => {
  for (const n of [0, 1, 2, 3, 24575, 24576, 24577, 100000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    assert.equal(base64(bytes), Buffer.from(bytes).toString('base64'), `${n} bytes`);
  }
});

test('srgbToLinear: the sRGB transfer function, clamped', () => {
  assert.equal(srgbToLinear(0), 0);
  assert.equal(srgbToLinear(1), 1);
  assert.equal(srgbToLinear(0.04045), 0.04045 / 12.92);
  assert.ok(Math.abs(srgbToLinear(0.5) - 0.21404114) < 1e-8);
  assert.deepEqual([srgbToLinear(-1), srgbToLinear(2)], [0, 1]);
});

// Compressed output, read back with the decoders.
await MeshoptDecoder.ready;
await MeshoptEncoder.ready;
const decoding = new WebIO().registerExtensions([KHRMaterialsUnlit, KHRNodeVisibility, KHRDracoMeshCompression,
  EXTMeshoptCompression, KHRMeshQuantization, EXTMeshGPUInstancing]).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(), 'meshopt.decoder': MeshoptDecoder });

type Tri = number[]; // nine world coordinates, metres
/** A primitive's triangles (mode 4) in world coordinates, each with the vertex numbers it came from. */
function worldTriangles(node: Node, p: Primitive,
  m: ArrayLike<number> = node.getWorldMatrix()): { tri: Tri; v: number[] }[] {
  const pos = p.getAttribute('POSITION')!, ix = p.getIndices()!;
  const out: { tri: Tri; v: number[] }[] = [];
  const e = [0, 0, 0];
  for (let i = 0; i < ix.getCount(); i += 3) {
    const tri: Tri = [], v: number[] = [];
    for (let k = 0; k < 3; k++) {
      v.push(ix.getScalar(i + k));
      pos.getElement(ix.getScalar(i + k), e);
      for (let r = 0; r < 3; r++) tri.push(m[r]! * e[0]! + m[4 + r]! * e[1]! + m[8 + r]! * e[2]! + m[12 + r]!);
    }
    out.push({ tri, v });
  }
  return out;
}
/** The same triangles, each in its winding (a cyclic shift allowed), within `eps`; matched one to one. */
function sameTriangles(a: Tri[], b: Tri[], eps: number): boolean {
  if (a.length !== b.length) return false;
  const left = [...b];
  const near = (x: Tri, y: Tri) => [0, 3, 6].some((s) => x.every((c, i) => Math.abs(c - y[(i + s) % 9]!) <= eps));
  return a.every((t) => { const j = left.findIndex((u) => near(t, u)); return j >= 0 && !!left.splice(j, 1); });
}
const plainTriangles = async (s: Scene, v: ExportView, part: string) => {
  const doc = await io.readBinary((await glb(s, v)).bytes);
  return byName(doc.getRoot().listNodes(), part).map((n) => n.getMesh()!.listPrimitives().map(
    (p) => ({ p, tris: worldTriangles(n, p) })));
};
/** Every "extras" key in a glTF JSON. */
const extrasIn = (json: unknown): number => JSON.stringify(json).split('"extras"').length - 1;

test('the defaults: Draco, no extras; triangles within 14 bits of the part mesh\'s extent; lines uncompressed',
  async () => {
  const s = scene();
  const view = viewOf(s, meshes(), { edges: true, curves: true });
  const out = await glbOf(s, view);
  const json = (await decoding.binaryToJSON(out.bytes)).json;
  assert.deepEqual([json.extensionsUsed, json.extensionsRequired],
    [['KHR_draco_mesh_compression'], ['KHR_draco_mesh_compression']]);
  assert.equal(extrasIn(json), 0);
  // The validator knows no Draco: it says so, checks the rest, and sees the three primitives' compressed data as
  // buffer views nothing uses.
  assert.deepEqual(await issues(out.bytes), ['UNSUPPORTED_EXTENSION /extensionsUsed/0', 'UNUSED_OBJECT /bufferViews/4',
    'UNUSED_OBJECT /bufferViews/5', 'UNUSED_OBJECT /bufferViews/6']);
  // Every triangle primitive compressed, no line or point primitive.
  const prims = json.meshes!.flatMap((m) => m.primitives);
  assert.deepEqual(prims.map((p) => [p.mode ?? 4, !!p.extensions?.KHR_draco_mesh_compression]),
    // (the plate's first look, its edges, the wire's curves and points; the second look, the wire's in red)
    [[4, true], [4, true], [1, false], [1, false], [0, false], [4, true], [1, false], [0, false]]);
  const doc = await decoding.readBinary(out.bytes);
  const expected = await plainTriangles(s, view, 'plate');
  const plates = byName(doc.getRoot().listNodes(), 'plate');
  // 14 bits over 1 inch (the plate's extent in its mesh's units), in metres: 1.6e-6 m.
  plates.forEach((n, i) => n.getMesh()!.listPrimitives().forEach((p, g) => assert.ok(sameTriangles(
    worldTriangles(n, p).map((t) => t.tri), expected[i]![g]!.tris.map((t) => t.tri), 2e-6), `plate ${i} group ${g}`)));
  // Draco keeps only the vertices a primitive uses: 3 of the plate's 4 for its first face.
  assert.equal(plates[0]!.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!.getCount(), 3);
  // Edges as they are, exactly.
  assert.deepEqual(Array.from(linePrim(plates[0]!, 'edges').getAttribute('POSITION')!.getArray()!),
    Array.from(plate().edgePositions!));
  // Coarser quantization: errors beyond 2e-6 m on the second face (its corner at z = 0.1 off the 4-bit grid; the first
  // face's corners are its bounding box's, exact at any bits).
  const coarse = await decoding.readBinary((await glbOf(s, view, { dracoPositionBits: 4 })).bytes);
  const n0 = byName(coarse.getRoot().listNodes(), 'plate')[0]!;
  assert.ok(!sameTriangles(worldTriangles(n0, n0.getMesh()!.listPrimitives()[1]!).map((t) => t.tri),
    expected[0]![1]!.tris.map((t) => t.tri), 2e-6));
  // Deterministic.
  assert.deepEqual((await glbOf(s, view)).bytes, out.bytes);
});

test('Draco with extras: faces by a _FACE vertex attribute, vertices two faces share copied; at most 65535 faces',
  async () => {
  const s = scene();
  const view = viewOf(s, meshes());
  const out = await glbOf(s, view, { extras: true });
  const doc = await decoding.readBinary(out.bytes);
  const expected = await plainTriangles(s, view, 'plate');
  const plates = byName(doc.getRoot().listNodes(), 'plate');
  // Look 0: green face 8 and blue face 7 in two primitives; look 1: both red, in one, sharing vertices 0 and 2.
  const faceSources = (n: Node) => n.getMesh()!.listPrimitives().map((p) => p.getExtras());
  assert.deepEqual(plates.map(faceSources),
    [[{ faces: [{ source: 8 }] }, { faces: [{ source: 7 }] }], [{ faces: [{ source: 8 }, { source: 7 }] }]]);
  plates.forEach((n, i) => n.getMesh()!.listPrimitives().forEach((p, g) => {
    const face = p.getAttribute('_FACE')!;
    assert.ok(face.getArray() instanceof Uint16Array);
    const faces = (p.getExtras() as { faces: unknown[] }).faces;
    const got = worldTriangles(n, p);
    // Each triangle's corners are of one face; per face, its triangles.
    for (const t of got) assert.equal(new Set(t.v.map((v) => face.getScalar(v))).size, 1);
    const plainP = expected[i]![g]!.p;
    const ranges = (plainP.getExtras() as { faces: { start: number; count: number }[] }).faces;
    faces.forEach((_, j) => assert.ok(sameTriangles(
      got.filter((t) => face.getScalar(t.v[0]!) === j).map((t) => t.tri),
      expected[i]![g]!.tris.slice(ranges[j]!.start / 3, (ranges[j]!.start + ranges[j]!.count) / 3).map((t) => t.tri),
      2e-6), `plate ${i} group ${g} face ${j}`));
  }));
  // The shared primitive: 4 vertices, 0 and 2 copied for the second face.
  assert.equal(plates[1]!.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!.getCount(), 6);

  // A primitive of MAX_DRACO_FACES one-triangle faces is written; one more is an error.
  const many = (faces: number): Mesh => ({
    origin: [0, 0, 0],
    positions: Float32Array.from({ length: 9 * faces }, (_, i) => (i % 9 === 3 || i % 9 === 7 ? 1 : 0) + Math.floor(
      i / 9) * (i % 3 === 2 ? 1 : 0)),
    indices: Uint32Array.from({ length: 3 * faces }, (_, i) => i),
    faces: Array.from({ length: faces }, (_, f) => ({ source: f + 1, start: 3 * f, count: 3 })),
  });
  const one = scene();
  one.parts = [{ ...one.parts[0]!, material: undefined, faceMaterials: [] } as typeof one.parts[0]];
  one.components[1]!.parts = [{ part: 0, transform: identity() }];
  one.overrides = [];
  const atLimit = await glbOf(one, viewOf(one, new Map([[0, many(MAX_DRACO_FACES)]])), { extras: true });
  assert.ok(atLimit.bytes.length > 0);
  await assert.rejects(glbOf(one, viewOf(one, new Map([[0, many(MAX_DRACO_FACES + 1)]])), { extras: true }),
    (e: Error) => e instanceof GltfError && /65536 faces in one primitive/.test(e.message));
  // Without extras, or with meshopt, no limit.
  await glbOf(one, viewOf(one, new Map([[0, many(MAX_DRACO_FACES + 1)]])));
  assert.equal(MAX_DRACO_FACES, 65535);
});

test('meshopt: positions in 16 bits, faces reordered within their ranges, the volume in the part node', async () => {
  const s = scene();
  const view = viewOf(s, meshes(), { edges: true, curves: true });
  const out = await glbOf(s, view, { compression: 'meshopt', extras: true });
  const json = (await decoding.binaryToJSON(out.bytes)).json;
  assert.deepEqual([json.extensionsUsed!.sort(), json.extensionsRequired!.sort()],
    [['EXT_meshopt_compression', 'KHR_mesh_quantization'], ['EXT_meshopt_compression', 'KHR_mesh_quantization']]);
  const doc = await decoding.readBinary(out.bytes);
  const expected = await plainTriangles(s, view, 'plate');
  const plates = byName(doc.getRoot().listNodes(), 'plate');
  plates.forEach((n, i) => n.getMesh()!.listPrimitives().forEach((p, g) => {
    assert.ok(p.getAttribute('POSITION')!.getArray() instanceof Int16Array);
    assert.equal(p.getAttribute('POSITION')!.getNormalized(), true);
    // Each face range holds its own triangles (16 bits over an inch: 4e-7 m).
    const got = worldTriangles(n, p);
    const ranges = (p.getExtras() as { faces: { start: number; count: number }[] }).faces;
    assert.deepEqual(ranges, (expected[i]![g]!.p.getExtras() as { faces: unknown[] }).faces);
    for (const f of ranges) assert.ok(sameTriangles(got.slice(f.start / 3, (f.start + f.count) / 3).map((t) => t.tri),
      expected[i]![g]!.tris.slice(f.start / 3, (f.start + f.count) / 3).map((t) => t.tri), 5e-7));
  }));
  // The edges child, quantized in the same volume, inherits the part node's scale and offset.
  const plainDoc = await io.readBinary((await glb(s, view)).bytes);
  const plainEdges = linePrim(byName(plainDoc.getRoot().listNodes(), 'plate')[0]!, 'edges');
  const [e0, pe] = [child(plates[0]!, 'edges')!, child(byName(plainDoc.getRoot().listNodes(), 'plate')[0]!, 'edges')!];
  const at = (n: Node, p: Primitive, i: number) => {
    const e = p.getAttribute('POSITION')!.getElement(i, [0, 0, 0]), m = n.getWorldMatrix();
    return [0, 1, 2].map((r) => m[r]! * e[0]! + m[4 + r]! * e[1]! + m[8 + r]! * e[2]! + m[12 + r]!);
  };
  for (let i = 0; i < plainEdges.getAttribute('POSITION')!.getCount(); i++) assert.ok(close(
    at(e0, linePrim(plates[0]!, 'edges'), i), at(pe, plainEdges, i), 5e-6), `edge vertex ${i}`);
  // The part node: its transform times the volume's (centre (1, 1, 1), half-width 1 over the plate's edges'
  // positions, which reach (2, 2, 2)).
  const plainPlate = byName(plainDoc.getRoot().listNodes(), 'plate')[0]!;
  assert.ok(close(plates[0]!.getMatrix(), multiply(Float64Array.from(plainPlate.getMatrix()),
    Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1)), 1e-12));
  // Deterministic.
  assert.deepEqual((await glbOf(s, view, { compression: 'meshopt', extras: true })).bytes, out.bytes);
});

test('meshopt: vertices renumbered with their normals, faces kept apart, the volume as tall as the mesh', async () => {
  // Two faces, each a strip of four quads in the x-z plane (x 0 to 1, z 0 to 10: tallest in z), one above the other
  // and sharing a row of vertices, in one group; vertices numbered backwards, so first use isn't their order;
  // triangles scattered within each face; a vertex no triangle uses; each vertex its own normal.
  const at = (i: number, j: number) => 14 - (j * 5 + i);
  const positions = new Float32Array(16 * 3), normals = new Float32Array(16 * 3);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) {
    positions.set([i * 0.25, 0, j * 5], 3 * at(i, j));
    const n = [i - 2, 1, j - 1], l = Math.hypot(...n);
    normals.set(n.map((x) => x / l), 3 * at(i, j));
  }
  positions.set([0.5, 0.5, 5], 45);
  normals.set([0, 1, 0], 45);
  const face = (j: number) => {
    const tris: number[][] = [];
    for (let i = 0; i < 4; i++) tris.push([at(i, j), at(i + 1, j), at(i + 1, j + 1)], [at(i, j), at(i + 1, j + 1),
      at(i, j + 1)]);
    return Array.from({ length: 8 }, (_, k) => tris[(k * 3) % 8]!).flat();
  };
  const strip: Mesh = { origin: [0, 0, 0], positions, normals, indices: Uint32Array.from([...face(0), ...face(1)]),
    faces: [{ source: 1, start: 0, count: 24 }, { source: 2, start: 24, count: 24 }] };
  const one = scene();
  one.parts = [{ ...one.parts[0]!, material: undefined, faceMaterials: [] } as typeof one.parts[0]];
  one.components[1]!.parts = [{ part: 0, transform: identity() }];
  one.overrides = [];
  const view = viewOf(one, new Map([[0, strip]]));
  const doc = await decoding.readBinary((await glbOf(one, view, { compression: 'meshopt', extras: true })).bytes);
  const node = byName(doc.getRoot().listNodes(), 'plate')[0]!;
  const p = node.getMesh()!.listPrimitives()[0]!;
  const want = (await plainTriangles(one, view, 'plate'))[0]![0]!.tris.map((t) => t.tri);
  const got = worldTriangles(node, p);
  // Each face's triangles in its range (16 bits over 10 inches: 4e-6 m).
  for (const [s0, s1] of [[0, 8], [8, 16]] as const) assert.ok(sameTriangles(got.slice(s0, s1).map((t) => t.tri),
    want.slice(s0, s1), 5e-6), `face ${s0 / 8}`);
  // The vertices renumbered: by first use, so the first triangle's are 0, 1, 2 (they weren't); each with its normal
  // (8-bit octahedral: within 0.02); the unused one kept, last.
  assert.deepEqual(got[0]!.v, [0, 1, 2]);
  const pos = p.getAttribute('POSITION')!, nor = p.getAttribute('NORMAL')!;
  assert.equal(pos.getCount(), 16);
  const m = node.getWorldMatrix();
  const world = (v: number) => { const e = pos.getElement(v, [0, 0, 0]);
    return [0, 1, 2].map((r) => m[r]! * e[0]! + m[4 + r]! * e[1]! + m[8 + r]! * e[2]! + m[12 + r]!); };
  const plainNode = byName((await io.readBinary((await glb(one, view)).bytes)).getRoot().listNodes(), 'plate')[0]!;
  const pm = plainNode.getWorldMatrix();
  const plainWorld = (v: number) => [0, 1, 2].map((r) => pm[r]! * positions[3 * v]! + pm[4 + r]! * positions[3 * v
    + 1]! + pm[8 + r]! * positions[3 * v + 2]! + pm[12 + r]!);
  // Every vertex, matched to the original by its position (all distinct here).
  for (let v = 0; v < 16; v++) {
    const src = Array.from({ length: 16 }, (_, u) => u).find((u) => close(world(v), plainWorld(u), 5e-6));
    assert.notEqual(src, undefined, `vertex ${v}`);
    assert.ok(close(nor.getElement(v, [0, 0, 0]), normals.subarray(3 * src!, 3 * src! + 3), 0.02), `normal ${v}`);
  }
  assert.ok(close(world(15), plainWorld(15), 5e-6));
});

test('reorderWithinFaces: each face keeps its triangles, reordered', () => {
  // A 4 x 4 grid of quads as one face, its triangles in a scattered order, then a second face.
  const tris: number[] = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
    const v = y * 5 + x;
    tris.push(v, v + 1, v + 6, v, v + 6, v + 5);
  }
  const order = Array.from({ length: 32 }, (_, i) => (i * 13) % 32);
  const indices = Uint32Array.from([...order.flatMap((t) => tris.slice(3 * t, 3 * t + 3)), 25, 26, 27]);
  const faces = [{ start: 0, count: 96 }, { start: 96, count: 3 }];
  const out = reorderWithinFaces(indices, faces, MeshoptEncoder.reorderMesh);
  const key = (a: Uint32Array, f: { start: number; count: number }) => {
    const list: string[] = [];
    for (let i = f.start; i < f.start + f.count; i += 3) {
      const t = [a[i]!, a[i + 1]!, a[i + 2]!];
      const r = t.indexOf(Math.min(...t));
      list.push([t[r], t[(r + 1) % 3], t[(r + 2) % 3]].join(','));
    }
    return list.sort();
  };
  for (const f of faces) assert.deepEqual(key(out, f), key(indices, f));
  assert.notDeepEqual(Array.from(out.subarray(0, 96)), Array.from(indices.subarray(0, 96)));
  assert.deepEqual(Array.from(out.subarray(96)), [25, 26, 27]);
});

test('options: an unknown compression, Draco bits out of range', async () => {
  const s = scene();
  const view = viewOf(s, meshes());
  await assert.rejects(glbOf(s, view, { compression: 'zip' as 'none' }), GltfError);
  for (const bits of [0, 31, 1.5]) await assert.rejects(glbOf(s, view, { dracoPositionBits: bits }), GltfError);
  await glbOf(s, view, { dracoPositionBits: 30 });
  await glbOf(s, view, { dracoPositionBits: 1 });
});

// Instancing: the plate placed twice with one look (without the override that reddens its second instance), the
// second turned a quarter about z.
const twice = () => {
  const s = scene();
  s.overrides = [];
  const t = translation(200, 0, 0);
  t[0] = 0; t[1] = 1; t[4] = -1; t[5] = 0;
  s.components[0]!.children[1]!.transform = t;
  return s;
};
/** A rotation (unit quaternion x y z w) with translation and scale, as a column-major matrix. */
function compose(t: ArrayLike<number>, q: ArrayLike<number>, sc: ArrayLike<number>): Mat4 {
  const [x, y, z, w] = [q[0]!, q[1]!, q[2]!, q[3]!];
  const r = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w),
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w),
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)];
  return Float64Array.of(...r.slice(0, 3).map((v) => v * sc[0]!), 0, ...r.slice(3, 6).map((v) => v * sc[1]!), 0,
    ...r.slice(6).map((v) => v * sc[2]!), 0, t[0]!, t[1]!, t[2]!, 1);
}
/** An instanced node's instances as world matrices: its world matrix times each one's TRS. */
function instanceWorlds(n: Node): Mat4[] {
  const ext = n.getExtension<InstancedMesh>('EXT_mesh_gpu_instancing')!;
  const [t, r, sc] = ['TRANSLATION', 'ROTATION', 'SCALE'].map((k) => ext.getAttribute(k)!);
  return Array.from({ length: t!.getCount() }, (_, i) => multiply(Float64Array.from(n.getWorldMatrix()),
    compose(t!.getElement(i, [0, 0, 0]), r!.getElement(i, [0, 0, 0, 0]), sc!.getElement(i, [0, 0, 0]))));
}
const topOf = (doc: Awaited<ReturnType<typeof io.readBinary>>) => doc.getRoot().listScenes()[0]!.listChildren()[0]!;

test('instancing: a look placed twice is one node with EXT_mesh_gpu_instancing, out of the tree; extras', async () => {
  const s = twice();
  const view = viewOf(s, meshes());
  const out = await glb(s, view, { instancing: true });
  assert.deepEqual(out.diagnostics, []);
  // The validator knows no instancing: it says so, and sees the instances' accessors as unused.
  assert.deepEqual(await issues(out.bytes), ['UNSUPPORTED_EXTENSION /extensionsUsed/0',
    'UNUSED_OBJECT /accessors/4', 'UNUSED_OBJECT /accessors/5', 'UNUSED_OBJECT /accessors/6']);
  const json = (await io.binaryToJSON(out.bytes)).json;
  assert.deepEqual(json.extensionsRequired, ['EXT_mesh_gpu_instancing']);
  const doc = await io.readBinary(out.bytes);
  // The tree had only the plates to draw: left out, empty.
  assert.deepEqual(topOf(doc).listChildren().map((c) => c.getName()), ['plate']);
  const inst = topOf(doc).listChildren()[0]!;
  const plain = byName((await io.readBinary((await glb(s, view)).bytes)).getRoot().listNodes(), 'plate');
  assert.equal(plain.length, 2);
  const worlds = instanceWorlds(inst);
  assert.equal(worlds.length, 2);
  worlds.forEach((w, i) => assert.ok(close(w, plain[i]!.getWorldMatrix(), 1e-8), `instance ${i}`));
  // The same mesh: each instance's triangles are the plain node's.
  inst.getMesh()!.listPrimitives().forEach((p, g) => worlds.forEach((w, i) => assert.ok(sameTriangles(
    worldTriangles(inst, p, w).map((t) => t.tri),
    worldTriangles(plain[i]!, plain[i]!.getMesh()!.listPrimitives()[g]!).map((t) => t.tri), 1e-8))));
  assert.deepEqual(inst.getExtras(), { part: 0, closed: false, sources: [{ format: 'step', id: 50 }],
    properties: { pn: 'X-1' },
    instances: [{ path: [0, 0], names: ['asm', 'left'], sources: [{ format: 'step', id: 101 }] },
      { path: [0, 1], names: ['asm', 'sub'], sources: [{ format: 'step', id: 101 }] }] });
  // Without extras, none; the empty tree kept on request.
  assert.equal(extrasIn((await io.binaryToJSON((await glb(s, view, { instancing: true, extras: false })).bytes)).json),
    0);
  const kept = await io.readBinary((await glb(s, view, { instancing: true, keepEmpty: true })).bytes);
  assert.deepEqual(topOf(kept).listChildren().map((c) => [c.getName(), c.listChildren().map((d) => d.getName())]),
    [['asm', ['left', 'sub']], ['plate', []]]);
  assert.ok(topOf(kept).listChildren()[0]!.listChildren().every((c) => !c.listChildren().length));
  // Without instancing, no extension; deterministic.
  assert.equal((await io.binaryToJSON((await glb(s, view)).bytes)).json.extensionsUsed, undefined);
  assert.deepEqual((await glb(s, view, { instancing: true })).bytes, out.bytes);
});

test('instancing: edges in a node per placement; curves-only parts stay; hidden, mirrored, sheared apart',
  async () => {
  const s = twice();
  const view = viewOf(s, meshes(), { edges: true, curves: true });
  const out = await glb(s, view, { instancing: true });
  assert.deepEqual(await issues(out.bytes), ['UNSUPPORTED_EXTENSION /extensionsUsed/0',
    'UNUSED_OBJECT /accessors/9', 'UNUSED_OBJECT /accessors/10', 'UNUSED_OBJECT /accessors/11']);
  const doc = await io.readBinary(out.bytes);
  const top = topOf(doc);
  // The wireframe has no faces: not instanced, still in the tree (so the tree stays).
  assert.deepEqual(top.listChildren().map((c) => c.getName()), ['asm', 'plate', 'plate', 'plate']);
  assert.deepEqual(top.listChildren()[0]!.listChildren().map((c) => c.listChildren().map((d) => d.getName())),
    [['wire'], ['wire']]);
  const [, inst, a, b] = top.listChildren();
  assert.ok(inst!.getMesh() && !inst!.listChildren().length);
  const plain = byName((await io.readBinary((await glb(s, view)).bytes)).getRoot().listNodes(), 'plate');
  [a!, b!].forEach((n, i) => {
    assert.equal(n.getMesh(), null);
    assert.deepEqual(n.listChildren().map((c) => c.getName()), ['edges']);
    assert.ok(close(n.getWorldMatrix(), plain[i]!.getWorldMatrix(), 1e-12), `placement ${i}`);
    assert.deepEqual(Array.from(linePrim(n, 'edges').getAttribute('POSITION')!.getArray()!),
      Array.from(linePrim(plain[i]!, 'edges').getAttribute('POSITION')!.getArray()!));
    assert.deepEqual(n.getExtras().instance, (inst!.getExtras().instances as unknown[])[i]);
  });

  // Hidden or not, apart: one instance hidden leaves one of each, so nothing instanced (left out or kept hidden).
  const h = twice();
  h.overrides.push({ path: [0, 0], visible: false, sources: [] });
  const hv = viewOf(h, meshes());
  for (const hidden of ['omit', 'extension'] as const) {
    const json = (await io.binaryToJSON((await glb(h, hv, { instancing: true, hidden })).bytes)).json;
    assert.ok(!json.extensionsUsed?.includes('EXT_mesh_gpu_instancing'), hidden);
    // Left out, the hidden plate leaves its node with nothing to draw: left out too.
    assert.deepEqual(json.nodes!.map((n) => n.name), hidden === 'omit' ? [undefined, 'asm', 'sub', 'plate']
      : [undefined, 'asm', 'left', 'plate', 'sub', 'plate']);
  }
  // Two hidden: left out, nothing; kept, instanced, the node and the edges' nodes hidden.
  h.overrides.push({ path: [0, 1], visible: false, sources: [] });
  const hv2 = viewOf(h, meshes(), { edges: true });
  assert.deepEqual((await io.binaryToJSON((await glb(h, hv2, { instancing: true })).bytes)).json.nodes!.map(
    (n) => n.name), [undefined]);
  const hidden = await io.readBinary((await glb(h, hv2, { instancing: true, hidden: 'extension' })).bytes);
  const hn = topOf(hidden).listChildren();
  assert.deepEqual(hn.map((c) => [c.getName(), (c.getExtension('KHR_node_visibility') as unknown as
    { getVisible(): boolean } | null)?.getVisible()]), [['plate', false], ['plate', false], ['plate', false]]);

  // A mirrored or sheared placement can't be TRS: it stays in the tree, and the other alone isn't instanced.
  for (const [k, v] of [[0, -1], [4, 0.5]] as const) {
    const m = twice();
    const t = translation(200, 0, 0);
    t[k] = v;
    m.components[0]!.children[1]!.transform = t;
    const json = (await io.binaryToJSON((await glb(m, viewOf(m, meshes()), { instancing: true })).bytes)).json;
    assert.equal(json.extensionsUsed, undefined, `${k}`);
    assert.equal(json.nodes!.filter((n) => n.name === 'plate').length, 2);
  }
});

test('instancing with Draco and meshopt: each instance\'s triangles in place, within quantization', async () => {
  const s = twice();
  const view = viewOf(s, meshes(), { edges: true });
  const plain = byName((await io.readBinary((await glb(s, view)).bytes)).getRoot().listNodes(), 'plate');
  for (const compression of ['draco', 'meshopt'] as const) {
    const doc = await decoding.readBinary((await glbOf(s, view, { compression, instancing: true })).bytes);
    const [inst, ...lines] = topOf(doc).listChildren();
    const worlds = instanceWorlds(inst!);
    inst!.getMesh()!.listPrimitives().forEach((p, g) => worlds.forEach((w, i) => assert.ok(sameTriangles(
      worldTriangles(inst!, p, w).map((t) => t.tri),
      worldTriangles(plain[i]!, plain[i]!.getMesh()!.listPrimitives()[g]!).map((t) => t.tri), 2e-6),
      `${compression} instance ${i} group ${g}`)));
    // The edges' nodes too (meshopt: in the part mesh's volume).
    const edges = (m: Node) => {
      const w = child(m, 'edges')!.getWorldMatrix(), pos = linePrim(m, 'edges').getAttribute('POSITION')!;
      return Array.from({ length: pos.getCount() }, (_, v) => {
        const e = pos.getElement(v, [0, 0, 0]);
        return [0, 1, 2].map((r) => w[r]! * e[0]! + w[4 + r]! * e[1]! + w[8 + r]! * e[2]! + w[12 + r]!);
      }).flat();
    };
    assert.equal(lines.length, 2);
    lines.forEach((n, i) => assert.ok(close(edges(n), edges(plain[i]!), 2e-6), `${compression} edges ${i}`));
  }
});

test('decompose: TRS of rotations (every quaternion branch), scales, translations; none for mirrors and shear',
  () => {
  // (w largest, then x, y, z largest, each with every component non-zero; half turns; others)
  const qs = [[0.2, -0.3, 0.1, 0.9], [0.9, 0.2, -0.1, -0.3], [0.2, -0.9, 0.3, 0.1], [-0.1, 0.3, 0.9, 0.2],
    [0, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0.5, -0.5, 0.5, 0.5], [0.1, 0.7, -0.3, 0.2]].map(
    (q) => { const n = Math.hypot(...q); return q.map((x) => x / n); });
  for (const q of qs) {
    const m = compose([1, -2, 3], q, [2, 3, 0.5]);
    const d = decompose(m)!;
    assert.ok(close(compose(d.t, d.r, d.s), m, 1e-12), `${q}`);
    assert.ok(close(d.s, [2, 3, 0.5], 1e-12));
    assert.ok(Math.abs(Math.hypot(...d.r) - 1) < 1e-15);
  }
  // Within the tolerance of orthogonal: a unit quaternion all the same.
  const near = compose([0, 0, 0], qs[0]!, [1, 1, 1]);
  near[4]! += 3e-10;
  assert.ok(Math.abs(Math.hypot(...decompose(near)!.r) - 1) < 1e-15);
  const mirror = identity(); mirror[0] = -1;
  const shears = [4, 8, 9].map((k) => { const m = identity(); m[k] = 0.5; return m; });
  const flat = identity(); flat[10] = 0;
  for (const m of [mirror, ...shears, flat]) assert.equal(decompose(m), undefined);
});
