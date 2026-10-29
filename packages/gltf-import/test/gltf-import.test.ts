import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Document, WebIO } from '@gltf-transform/core';
import { exportView, partInstances, pruneView, tessellateScene, validate, viewDifferences, type ExportView,
  type Scene } from 'cad-scene';
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

test('a foreign glTF: its tree, a part per primitive, shared meshes, strips, linear colours, textures', async () => {
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
  // The scene's root, a and b, b's child; a part per primitive, shared by a and b; the strip as three segments.
  assert.deepEqual(s.components.map((c) => [c.name, c.parts.length, c.children.length]),
    [['world', 0, 2], ['a', 2, 0], ['b', 2, 1], ['line', 1, 0]]);
  assert.equal(s.parts.length, 3);
  assert.equal(s.parts[2]!.lods[0]!.mesh.curves!.length, 3);
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
