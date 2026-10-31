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
