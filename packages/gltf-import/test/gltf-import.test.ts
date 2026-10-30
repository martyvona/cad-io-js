import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Document, WebIO } from '@gltf-transform/core';
import { addLod, exportView, identity, multiply, partInstances, pruneView, tessellateScene, validate,
  viewDifferences, type ExportView, type Scene } from 'cad-scene';
import { glb, gltfJson, type GltfOptions } from 'export-gltf';
import { importStep } from 'step-import';
import { OcctTessellator } from 'tess-occt';
import { importGltf, srgbFactorsFrom } from '../src/index.ts';
import { scene } from './fixture.ts';

const lines = { edges: true, curves: true };
/** What a glTF export holds of a view: hidden placements only with KHR_node_visibility. */
const written = (view: ExportView, o: GltfOptions) => pruneView(view, o.hidden === 'extension' ? undefined
  : (p) => p.visible);
/** A scene written as GLB with our extras, read back, and the differences from what was written. */
async function roundTrip(s: Scene, o: GltfOptions, tolerance?: number) {
  const view = exportView(s, lines);
  const { bytes } = await glb(s, view, { extras: true, ...o });
  const back = await importGltf(bytes);
  const differences = viewDifferences({ scene: s, view: written(view, o) },
    { scene: back.scene, view: exportView(back.scene, lines) }, { tolerance, skipHidden: o.hidden !== 'extension' });
  return { back, differences };
}

test('our GLB with extras, uncompressed, hidden placements written: the scene it was written from', async () => {
  const { back, differences } = await roundTrip(scene(), { compression: 'none', hidden: 'extension' });
  assert.deepEqual(back.diagnostics, []);
  assert.deepEqual(validate(back.scene), []);
  assert.deepEqual(differences, []);
  const s = scene();
  const placed = (sc: Scene) => [...partInstances(sc)].map((p) => [sc.parts[p.part]!.name, p.visible]);
  assert.deepEqual(placed(back.scene), placed(s));
  assert.deepEqual(back.scene.parts.map((p) => [p.name, p.closed, p.lods[0]!.mesh.faces.map((f) => f.source).sort()]),
    [['plate', true, [7, 8, 9]], ['wire', undefined, []]]);
  assert.deepEqual(back.scene.components.map((c) => c.name), ['asm', 'sub']);
});

test('our GLB, hidden placements left out (the default): read back, those restored hidden', async () => {
  const { back, differences } = await roundTrip(scene(), { compression: 'none' });
  assert.deepEqual(differences, []);
  assert.deepEqual(validate(back.scene), []);
});

test('our GLB with Draco (faces by _FACE) and with meshopt: the same within their quantization', async () => {
  // (14 and 16 bits over the plate's 51 mm: steps of 0.003 and 0.0008 mm.)
  for (const compression of ['draco', 'meshopt'] as const) {
    const { back, differences } = await roundTrip(scene(), { compression, hidden: 'extension' }, 0.01);
    assert.deepEqual(differences, [], compression);
    assert.deepEqual(back.scene.parts[0]!.lods[0]!.mesh.faces.map((f) => f.source).sort(), [7, 8, 9], compression);
  }
});

test('our GLB with GPU instancing: each instance back where it was, with its lines', async () => {
  for (const hidden of ['omit', 'extension'] as const) {
    const s = scene();
    // Every instance visible, so the plate is instanced (three placements of one look).
    s.overrides = [];
    const { back, differences } = await roundTrip(s, { compression: 'none', instancing: true, hidden });
    assert.deepEqual(differences, [], hidden);
    assert.deepEqual(validate(back.scene), [], hidden);
  }
});

test('our .gltf, with its .bin and embedded', async () => {
  const s = scene();
  const view = exportView(s, lines);
  const sidecar = await gltfJson(s, view, 'model.bin', { extras: true, compression: 'none' });
  const a = await importGltf({ json: sidecar.json, resources: { 'model.bin': sidecar.bin! } });
  const embedded = await gltfJson(s, view, undefined, { extras: true, compression: 'none' });
  const b = await importGltf({ json: embedded.json });
  for (const back of [a, b]) {
    assert.deepEqual(viewDifferences({ scene: s, view: written(view, {}) },
      { scene: back.scene, view: exportView(back.scene, lines) }, { skipHidden: true }), []);
  }
});

test('a foreign glTF: its tree, a part per mesh (its primitives faces), shared, strips, linear colours, textures',
  async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'SCALAR', a: Float32Array | Uint16Array) => doc.createAccessor().setType(type)
    .setArray(a as never).setBuffer(buffer);
  const pos = acc('VEC3', Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0));
  // (Linear 0.21586 is sRGB 128/255.)
  const orange = doc.createMaterial('orange').setBaseColorFactor([1, 0.21586, 0, 0.5]).setAlphaMode('BLEND');
  const grey = doc.createMaterial('grey').setBaseColorFactor([0.21586, 0.21586, 0.21586, 1])
    .setBaseColorTexture(doc.createTexture('t').setImage(new Uint8Array(4)).setMimeType('image/png'));
  const mesh = doc.createMesh('two').addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos)
    .setIndices(acc('SCALAR', Uint16Array.of(0, 1, 2))).setMaterial(orange))
    .addPrimitive(doc.createPrimitive().setAttribute('POSITION', pos).setIndices(acc('SCALAR', Uint16Array.of(1, 3,
      2))).setMaterial(grey));
  const strip = doc.createMesh('strip').addPrimitive(doc.createPrimitive().setMode(3).setAttribute('POSITION', pos));
  const a = doc.createNode('a').setMesh(mesh).setTranslation([1, 0, 0]);
  const b = doc.createNode('b').setMesh(mesh).addChild(doc.createNode('line').setMesh(strip));
  doc.createScene('world').addChild(a).addChild(b);
  const { scene: s, diagnostics } = await importGltf(await new WebIO().writeBinary(doc));
  assert.deepEqual(validate(s), []);
  assert.deepEqual(diagnostics.map((d) => d.message), ['textures are not supported: ignored']);
  // The scene's root, a and b, b's child; a part for the mesh, shared by a and b, its two primitives faces 0 and 1
  // (the second grey); the strip as three segments.
  assert.deepEqual(s.components.map((c) => [c.name, c.parts.length, c.children.length]),
    [['world', 0, 2], ['a', 1, 0], ['b', 1, 1], ['line', 1, 0]]);
  assert.equal(s.parts.length, 2);
  const two = s.parts[0]!;
  assert.deepEqual(two.lods[0]!.mesh.faces, [{ source: 0, start: 0, count: 3 }, { source: 1, start: 3, count: 3 }]);
  assert.deepEqual(Array.from(two.lods[0]!.mesh.indices), [0, 1, 2, 5, 7, 6]);
  assert.deepEqual([two.material, two.faceMaterials], [0, [{ face: 1, material: 1 }]]);
  assert.equal(s.parts[1]!.lods[0]!.mesh.curves!.length, 3);
  // Linear colours to sRGB; the root from metres, Y up.
  assert.deepEqual(s.materials.map((m) => [m.name, m.color.map((c) => Math.round(c * 255)), m.opacity]),
    [['orange', [255, 128, 0], 0.5], ['grey', [128, 128, 128], 1]]);
  assert.deepEqual(Array.from(s.roots[0]!.transform).map((x) => Math.round(x)),
    [1000, 0, 0, 0, 0, 0, 1000, 0, 0, -1000, 0, 0, 0, 0, 0, 1]);
  // Onshape's factors are sRGB already.
  assert.ok(srgbFactorsFrom('Onshape Inc.') && !srgbFactorsFrom('elsewhere'));
  // (glTF-Transform's writer names itself the generator: set in the written JSON.)
  const written = await new WebIO().writeJSON(doc);
  written.json.asset.generator = 'ONSHAPE BY PTC INC, 1.197';
  const onshape = await importGltf({ json: written.json, resources: written.resources });
  assert.deepEqual(onshape.scene.materials[0]!.color.map((c) => Math.round(c * 1000) / 1000), [1, 0.216, 0]);
  // Not glTF: an error, an empty scene.
  assert.equal((await importGltf(Uint8Array.of(1, 2, 3))).diagnostics[0]!.severity, 'error');
});

const assembly = path.resolve(import.meta.dirname,
  '../../../test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
test('a STEP assembly through GLB and back, each compression, instanced or not: the same drawing',
  { skip: fs.existsSync(assembly) ? false : 'corpus not fetched' }, async () => {
    const { scene: s } = await importStep(fs.readFileSync(assembly));
    const occt = new OcctTessellator();
    await occt.init();
    await tessellateScene(s, occt, { edges: true });
    occt.dispose();
    for (const o of [{ compression: 'none' }, { compression: 'draco' }, { compression: 'meshopt' },
      { compression: 'none', instancing: true }] as GltfOptions[]) {
      const { back, differences } = await roundTrip(s, o, o.compression === 'none' ? undefined : 0.05);
      assert.deepEqual(differences, [], JSON.stringify(o));
      assert.deepEqual(back.diagnostics, [], JSON.stringify(o));
    }
  });

test('two placements alike in one component stay two; a tree all instanced, made again; a model in feet', async () => {
  // The plate placed twice at the same transform; the wire left out, so every placement is instanced and the
  // export keeps no tree node (the assembly's instances alike in name and place); every transform scaled to feet.
  const s = scene();
  s.overrides = [];
  const sub = s.components[1]!;
  sub.parts = [sub.parts[0]!, { ...sub.parts[0]! }];
  for (const c of s.components[0]!.children) c.name = 'same';
  for (const r of sub.parts) r.transform = Float64Array.from(r.transform, (x, i) => (i < 12 ? x * 12 : x));
  s.roots[0]!.transform = Float64Array.of(304.8, 0, 0, 0, 0, 0, 304.8, 0, 0, -304.8, 0, 0, 1000, 2000, 3000, 1);
  // And another part at the same place, without lines, placed first: the plate's lines stay the plate's.
  const other = { ...s.parts[0]!, name: 'other', lods: [{ from: 'tessellated' as const, mesh: { ...s.parts[0]!.lods[0]!
    .mesh, edges: [] } }] };
  s.parts.push(other);
  sub.parts.unshift({ ...sub.parts[0]!, part: 2 });
  for (const o of [{ compression: 'none', instancing: true }, { compression: 'none' }] as GltfOptions[]) {
    const view = exportView(s, lines);
    const back = await importGltf((await glb(s, view, { extras: true, ...o })).bytes);
    const reach = 1e5;
    assert.deepEqual(viewDifferences({ scene: s, view: pruneView(view) }, { scene: back.scene,
      view: exportView(back.scene, lines) }, { tolerance: 8 * reach * 2 ** -24 }), [], JSON.stringify(o));
    assert.equal([...partInstances(back.scene)].length, [...partInstances(s)].length, JSON.stringify(o));
  }
});

test('nodes made again under a component placed twice: one component each, shared by both instances', async () => {
  // The subassembly holds only the plate, instanced, so its nodes are pruned and made again; the assembly keeps the
  // wire (never instanced) and is placed twice.
  const s = scene();
  s.overrides = [];
  s.components[1]!.parts = [s.components[1]!.parts[0]!];
  s.components[0]!.parts.push({ part: 1, transform: identity() });
  const shifted = identity();
  shifted[13] = 1000;
  s.components.push({ name: 'top', sources: [], properties: {}, parts: [], children: [
    { component: 0, transform: identity(), sources: [], properties: {} },
    { component: 0, transform: shifted, sources: [], properties: {} }] });
  s.roots[0]!.component = 2;
  const view = exportView(s, lines);
  const back = (await importGltf((await glb(s, view, { extras: true, compression: 'none', instancing: true }))
    .bytes)).scene;
  assert.deepEqual(viewDifferences({ scene: s, view: pruneView(view) }, { scene: back,
    view: exportView(back, lines) }), []);
  // Every component placed somewhere: the asm's three children, made again, three components.
  const placed = new Set(back.roots.map((r) => r.component));
  for (const c of back.components) for (const ch of c.children) placed.add(ch.component);
  assert.deepEqual(back.components.map((_, i) => placed.has(i)), back.components.map(() => true));
  assert.equal(back.components.length, 5);
});

test('a foreign glTF with GPU instances: a placement per instance, at its transform after the node\'s', async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const acc = (type: 'VEC3' | 'VEC4', a: Float32Array) => doc.createAccessor().setType(type).setArray(a as never)
    .setBuffer(buffer);
  const tri = doc.createMesh('tri').addPrimitive(doc.createPrimitive().setAttribute('POSITION',
    acc('VEC3', Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0))));
  const { EXTMeshGPUInstancing } = await import('@gltf-transform/extensions');
  const ext = doc.createExtension(EXTMeshGPUInstancing).setRequired(true);
  // Three instances, along x, under a node moved 5 along y (in metres, Y up, as glTF is).
  const node = doc.createNode('many').setMesh(tri).setTranslation([0, 5, 0]).setExtension('EXT_mesh_gpu_instancing',
    ext.createInstancedMesh().setAttribute('TRANSLATION', acc('VEC3', Float32Array.of(0, 0, 0, 10, 0, 0, 20, 0, 0)))
      .setAttribute('ROTATION', acc('VEC4', Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1))));
  doc.createScene('world').addChild(node);
  const { scene: s, diagnostics } = await importGltf(await new WebIO().registerExtensions([EXTMeshGPUInstancing])
    .writeBinary(doc));
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(validate(s), []);
  // Each instance's first corner in the world, millimetres and Z up: (10k, 0, 5) m -> (10000k, 0, 5000) mm.
  const view = exportView(s);
  const corners: number[][] = [];
  const walk = (n: ExportView['roots'][number], t: Float64Array) => {
    const w = Float64Array.from(multiply(t, n.transform));
    for (const p of n.parts) {
      const m = multiply(w, p.transform), pos = view.looks[p.look]!.mesh.positions;
      corners.push([0, 1, 2].map((k) => Math.round(m[k]! * pos[0]! + m[4 + k]! * pos[1]! + m[8 + k]! * pos[2]! +
        m[12 + k]!)));
    }
    n.children.forEach((c) => walk(c, w));
  };
  view.roots.forEach((r) => walk(r, identity()));
  assert.deepEqual(corners, [[0, 0, 5000], [10000, 0, 5000], [20000, 0, 5000]]);
  assert.equal(s.parts.length, 1);
});

test('a .gltf without the .bin it names: an error, an empty scene', async () => {
  const s = scene();
  const sidecar = await gltfJson(s, exportView(s, lines), 'model.bin', { extras: true, compression: 'none' });
  const { scene: back, diagnostics } = await importGltf({ json: sidecar.json });
  assert.deepEqual(diagnostics.map((d) => [d.severity, d.message]), [['error', 'files not given: model.bin']]);
  assert.equal(back.parts.length, 0);
  assert.deepEqual(back.diagnostics, diagnostics);
});

test('our GLB without extras: each part node\'s `edges` child its mesh\'s edges, where they were', async () => {
  const s = scene();
  const view = exportView(s, lines);
  const back = (await importGltf((await glb(s, view, { compression: 'none' })).bytes)).scene;
  assert.deepEqual(validate(back), []);
  assert.ok(!back.components.some((c) => c.name === 'edges'));
  // The plate's one shared edge (its seam not written), a segment, in each of its two visible placements: the same
  // world corners as the file's own.
  const corners = (v: ExportView) => {
    const out: string[] = [];
    const walk = (n: ExportView['roots'][number], t: Float64Array) => {
      const w = Float64Array.from(multiply(t, n.transform));
      for (const p of n.parts) {
        if (!p.visible) continue;
        const m = multiply(w, p.transform), look = v.looks[p.look]!, pos = look.mesh.edgePositions;
        const written = (look.mesh.edges ?? []).filter((e) => e.kind === 'shared' || e.kind === 'free');
        for (const e of written) for (let k = e.start; k < e.start + e.count; k++) out.push([0, 1, 2]
          .map((r) => (m[r]! * pos![3 * k]! + m[4 + r]! * pos![3 * k + 1]! + m[8 + r]! * pos![3 * k + 2]! +
            m[12 + r]! + 0).toFixed(3).replace(/^-(0\.0+)$/, '$1')).join(','));
      }
      n.children.forEach((c) => walk(c, w));
    };
    v.roots.forEach((r) => walk(r, identity()));
    return out.sort();
  };
  const backView = exportView(back, lines);
  assert.equal(corners(backView).length, 4);
  assert.deepEqual(corners(backView), corners(pruneView(view, (p) => p.visible)));
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

test('triangles with two corners at one position dropped from the file\'s meshes, said; kept on request',
  async () => {
  const s = degenerate();
  for (const extras of [true, false]) {
    const { bytes } = await glb(s, exportView(s), { extras, compression: 'none' });
    assert.deepEqual(outcome((await importGltf(bytes)).scene), { triangles: [2], info: [DROPPED] });
    assert.deepEqual(outcome((await importGltf(bytes, { dropDegenerate: false })).scene),
      { triangles: [3], info: [] });
  }
});
