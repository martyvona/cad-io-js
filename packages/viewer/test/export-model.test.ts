import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Scene } from 'cad-scene';
import { DEFAULT_EXPORT, type ExportRequest } from '../src/export-formats.ts';
import { exportModel } from '../src/export-model.ts';
import { shownEdits } from '../src/export-shown.ts';
import { NodeModel } from '../src/model.ts';
import { SceneGraph } from '../src/scene-graph.ts';
import { plate, scene, wire } from './fixtures.ts';

/** The fixture with its meshes as the parts' levels, as the import worker's scene has them once meshed. */
function meshed(): Scene {
  const s = scene();
  s.parts[0]!.lods = [{ mesh: plate(), from: 'tessellated', linearDeflection: 0.1, angularDeflection: 0.5 }];
  s.parts[1]!.lods = [{ mesh: wire(), from: 'tessellated', linearDeflection: 0.1, angularDeflection: 0.5 }];
  return s;
}
const at = { linearDeflection: 0.1, angularDeflection: 0.5 };
const ask = (o: Partial<ExportRequest>): ExportRequest => ({ ...DEFAULT_EXPORT, name: 'model', ...o });
const bytes = (chunks: (string | Uint8Array)[]) => Buffer.concat(chunks.map((c) => typeof c === 'string'
  ? Buffer.from(c) : Buffer.from(c)));

test('exportModel: each format, as stepconv writes it', async () => {
  const glb = await exportModel(meshed(), at, ask({ format: 'glb', compression: 'none' }));
  assert.equal(bytes(glb.chunks).subarray(0, 4).toString(), 'glTF');
  const embedded = await exportModel(meshed(), at, ask({ format: 'gltf', compression: 'none' }));
  const json = JSON.parse(bytes(embedded.chunks).toString());
  assert.ok(json.buffers[0].uri.startsWith('data:application/octet-stream;base64,') && !embedded.bin);
  const beside = await exportModel(meshed(), at, ask({ format: 'gltf', compression: 'none', embed: false,
    bin: 'model.bin' }));
  assert.equal(JSON.parse(bytes(beside.chunks).toString()).buffers[0].uri, 'model.bin');
  assert.ok(beside.bin && beside.bin.length > 0);
  const three = JSON.parse(bytes((await exportModel(meshed(), at, ask({ format: 'threejs' }))).chunks).toString());
  assert.equal(three.metadata.type, 'Object');
  const mf = await exportModel(meshed(), at, ask({ format: '3mf' }));
  assert.equal(bytes(mf.chunks).subarray(0, 2).toString(), 'PK');
  // Edges and curves only when asked: the three.js file's line objects.
  const lines = (r: unknown) => JSON.stringify(r).split('"LineSegments"').length - 1;
  const withLines = JSON.parse(bytes((await exportModel(meshed(), at, ask({ format: 'threejs', edges: true,
    curves: true }))).chunks).toString());
  assert.ok(lines(withLines) > lines(three));
});

test("exportModel: the viewer's hiding applied when asked, else the scene's", async () => {
  const s = meshed();
  const graph = new SceneGraph(s, 'model');
  graph.addMesh(0, plate());
  const model = new NodeModel(graph.root, graph);
  model.setHidden([model.nodes.find((n) => n.kind === 'part' && n.name === 'plate')!.id], true);
  // (three.js JSON writes hidden placements hidden; GLB leaves them out.)
  const hidden = async (o: Partial<ExportRequest>) => (bytes((await exportModel(s, at, ask({ format: 'threejs',
    ...o }))).chunks).toString().match(/"visible":false/g) ?? []).length;
  const plain = await hidden({});
  assert.equal(await hidden({ shown: shownEdits(s, model, graph) }), plain + 1);
  const size = async (o: Partial<ExportRequest>) => bytes((await exportModel(s, at, ask({ format: 'glb',
    compression: 'none', ...o }))).chunks).length;
  assert.ok(await size({ shown: shownEdits(s, model, graph) }) < await size({}));
});

test('exportModel: paused as it goes (the import worker\'s heartbeat), the same files', async () => {
  for (const format of ['glb', 'gltf', 'threejs', '3mf', 'step'] as const) {
    const plain = await exportModel(meshed(), at, ask({ format, compression: 'none' }));
    const paused = await exportModel(meshed(), at, ask({ format, compression: 'none' }), {}, async () => {});
    assert.deepEqual(bytes(paused.chunks), bytes(plain.chunks), format);
  }
});

test('exportModel: STEP, its B-rep models (empty here), the meshes beside them by option, the viewer\'s hiding',
  async () => {
    const step = async (o: Partial<ExportRequest>) => bytes((await exportModel(meshed(), at, ask({ format: 'step',
      ...o }))).chunks).toString();
    const plain = await step({});
    assert.match(plain, /^ISO-10303-21;/);
    assert.match(plain, /FILE_SCHEMA\(\('AP242_/);
    assert.match(plain, /FILE_NAME\('model'/);
    assert.doesNotMatch(plain, /TRIANGULATED_FACE/);
    assert.match(await step({ stepMeshes: true }), /TRIANGULATED_FACE/);
    // AP214: no meshes even if asked.
    const ap214 = await step({ stepSchema: 'ap214', stepMeshes: true });
    assert.match(ap214, /FILE_SCHEMA\(\('AUTOMOTIVE_DESIGN/);
    assert.doesNotMatch(ap214, /TRIANGULATED_FACE/);
    // The viewer's hiding: the plate hidden (an INVISIBILITY).
    const s = meshed();
    const graph = new SceneGraph(s, 'model');
    graph.addMesh(0, plate());
    const model = new NodeModel(graph.root, graph);
    model.setHidden([model.nodes.find((n) => n.kind === 'part' && n.name === 'plate')!.id], true);
    const shown = bytes((await exportModel(s, at, ask({ format: 'step', shown: shownEdits(s, model, graph) })))
      .chunks).toString();
    // (The fixture hides something already: more is hidden.)
    const hidden = (t: string) => (/INVISIBILITY\(\(([^)]*)\)\)/.exec(t)?.[1]?.split(',').length ?? 0);
    assert.ok(hidden(shown) > hidden(plain), `${hidden(shown)} against ${hidden(plain)}`);
  });

test('exportModel: the unit asked for reaches every exporter, the format\'s default without it', async () => {
  const s = meshed();
  s.sourceUnit = 25.4;
  const text = async (o: Partial<ExportRequest>) => bytes((await exportModel(s, at, ask(o))).chunks).toString('latin1');
  // three.js: its top objects' matrices scale by 1 / unit (metres by default).
  const scaleOf = (json: string) => {
    const m = (JSON.parse(json) as { object: { children: { matrix: number[] }[] } }).object.children[0]!.matrix;
    return Math.hypot(m[0]!, m[1]!, m[2]!);
  };
  assert.ok(Math.abs(scaleOf(await text({ format: 'threejs' })) - 1e-3) < 1e-12);
  assert.ok(Math.abs(scaleOf(await text({ format: 'threejs', unit: 'cm' })) - 0.1) < 1e-12);
  // STEP: the source's by default (inches), else the one asked for.
  assert.match(await text({ format: 'step' }), /CONVERSION_BASED_UNIT\('INCH'/);
  assert.match(await text({ format: 'step', unit: 'ft' }), /CONVERSION_BASED_UNIT\('FOOT'/);
  assert.match(await text({ format: 'step', unit: 'mm' }), /SI_UNIT\(\.MILLI\.,\.METRE\.\)/);
  // 3MF: the model's unit attribute; glTF: the top node's scale.
  const { unzipSync, strFromU8 } = await import('fflate');
  const model = async (o: Partial<ExportRequest>) => strFromU8(unzipSync((await exportModel(s, at,
    ask({ format: '3mf', ...o }))).chunks.reduce((a: Buffer, c) => Buffer.concat([a, Buffer.from(c)]),
    Buffer.alloc(0)))['3D/3dmodel.model']!);
  assert.match(await model({}), /<model unit="inch"/);
  assert.match(await model({ unit: 'm' }), /<model unit="meter"/);
  const g = bytes((await exportModel(s, at, ask({ format: 'glb', compression: 'none', unit: 'cm' }))).chunks);
  const json = JSON.parse(g.subarray(20, 20 + g.readUInt32LE(12)).toString()) as
    { nodes: { matrix?: number[]; scale?: number[] }[]; scenes: { nodes: number[] }[] };
  const top = json.nodes[json.scenes[0]!.nodes[0]!]!;
  assert.ok(Math.abs((top.matrix ? Math.hypot(...top.matrix.slice(0, 3)) : top.scale?.[0] ?? 1) - 0.1) < 1e-7,
    JSON.stringify(top));
});
