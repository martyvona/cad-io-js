import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Mesh, Scene, TessellationRequest, TessellationResult, Tessellator } from 'cad-scene';
import { edgesOf, importModel, levelBuffers, loadModelIn, meshable, meshBuffers, needsEdges, placedScales, postable,
  type ModelEvent, type ModelInput } from '../src/model-load.ts';
import { exportView, pruneView, viewDifferences, type ExportNode } from 'cad-scene';
import { threemf } from 'export-3mf';
import { glb, gltfJson } from 'export-gltf';
import { threejsJson } from 'export-threejs';
import { scene as fixture, plate, wire } from './fixtures.ts';
import { MESH_PROFILES } from 'cad-scene';
import { defaultSettings } from '../src/tessellation.ts';

const DEFAULT_SETTINGS = defaultSettings('coarse');

const step = path.resolve(import.meta.dirname,
  '../../../test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const skip = fs.existsSync(step) ? false : 'corpus not fetched';
const stepInput = (): ModelInput => ({ format: 'step', bytes: new Uint8Array(fs.readFileSync(step)) });

/** A stand-in tessellator: a triangle per request, its face the request's root, after `delay` ms. */
function fake(delay = 0) {
  const requests: TessellationRequest[] = [];
  const tess: Tessellator = {
    info: { name: 'fake', version: '1', license: 'MIT', formats: ['step'], supportsFaceIds: true, supportsEdges: true,
      supportsCurves: false },
    init: async () => {},
    dispose: () => {},
    tessellate: async (req): Promise<TessellationResult> => {
      requests.push(req);
      await new Promise((r) => setTimeout(r, delay));
      return { origin: req.origin ?? [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
        indices: Uint32Array.of(0, 1, 2), faces: [{ entityId: req.rootId ?? null, start: 0, count: 3 }],
        diagnostics: [] };
    },
  };
  return { requests, tessellation: { get: async () => ({ tess, workers: 2 }),
    describe: () => ({ backend: 'fake 1', pools: 1 }) } };
}

test('postable: the B-rep\'s functions gone, the rest as it was; a structured clone takes it', () => {
  const part = { name: 'p', lods: [], brep: { format: 'step', payload: () => new Uint8Array(1), rootId: 7,
    outline: () => ({}) } };
  const mesh = { name: 'm', lods: [] };
  const scene = { parts: [part, mesh], components: [], roots: [] } as unknown as Scene;
  const p = postable(scene);
  assert.deepEqual(Object.keys(p.parts[0]!.brep!).filter((k) => p.parts[0]!.brep![k as 'payload'] !== undefined),
    ['format', 'rootId']);
  assert.equal(p.parts[0]!.brep!.rootId, 7);
  assert.equal(p.parts[1], mesh);
  assert.equal(scene.parts[0]!.brep!.payload, part.brep.payload);
  assert.doesNotThrow(() => structuredClone(p));
  assert.throws(() => structuredClone(scene));
});

test('meshable: placed brep parts only', () => {
  const s = fixture();
  assert.deepEqual(meshable(s), [0, 1]);
  // A third part, placed nowhere; a mesh part, placed.
  s.parts.push({ ...s.parts[0]!, name: 'spare' });
  s.parts.push({ name: 'tri', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] });
  s.components[1]!.parts.push({ part: 3, transform: s.components[1]!.parts[1]!.transform });
  assert.deepEqual(meshable(s), [0, 1]);
});

test("meshBuffers: each array's buffer once", () => {
  const shared = new ArrayBuffer(48);
  const m = { origin: [0, 0, 0] as [number, number, number], positions: new Float32Array(shared, 0, 6),
    normals: new Float32Array(shared, 24, 6), indices: Uint32Array.of(0, 1, 2), faces: [],
    points: Float32Array.of(1, 2, 3) };
  assert.deepEqual(meshBuffers(m), [shared, m.indices.buffer, m.points.buffer]);
  assert.deepEqual(meshBuffers(undefined), []);
});

test('loadModelIn: the scene (postable), a mesh per placed brep part, then the end with what meshed it',
  { skip }, async () => {
    const { requests, tessellation } = fake();
    const events: ModelEvent[] = [];
    const transfers: ArrayBuffer[][] = [];
    const told: string[] = [];
    await loadModelIn(stepInput(), DEFAULT_SETTINGS, 3, tessellation, (e, t) => {
      if (e.type === 'importing') told.push(e.progress.phase);
      else {
        events.push(e);
        transfers.push(t ?? []);
      }
    }, () => false);
    // The import's phases first, each once (a small file: within PROGRESS_MS), before the scene.
    assert.deepEqual(told, ['reading', 'structure', 'parts', 'assembly']);
    assert.deepEqual(events.map((e) => e.type), ['scene', ...requests.map(() => 'mesh'), 'done']);
    assert.equal(requests.length, 5);
    const scene = (events[0] as { scene: Scene }).scene;
    assert.doesNotThrow(() => structuredClone(scene));
    // Meshes with their buffers to transfer: positions, indices, and the faces' outlines (the fake's one face is the
    // representation's id, not one of the file's faces, so every face of the file counts as failed: outlined from
    // the file); a profile's deflections exactly (not through degrees).
    // (And the edges found from their triangles, as the fake backend gives none: its buffer too.)
    assert.ok(transfers.slice(1, -1).every((t) => t.length === 4));
    const meshes = events.filter((e) => e.type === 'mesh') as Extract<ModelEvent, { type: 'mesh' }>[];
    assert.ok(meshes.every((e) => e.foundEdges && e.foundEdges.length > 0));
    assert.ok(meshes.every((e) => e.mesh!.faceOutlines!.length > 0 && e.mesh!.faces.length > 1));
    assert.equal(requests[0]!.angularDeflection, MESH_PROFILES.coarse.angularDeflection);
    // Custom: the settings' deflections, degrees to radians.
    const custom = fake();
    await loadModelIn(stepInput(), { ...DEFAULT_SETTINGS, profile: 'custom', angularDeflection: 10 }, 3,
      custom.tessellation, () => {}, () => false);
    assert.equal(custom.requests[0]!.angularDeflection, 10 * Math.PI / 180);
    const done = events.at(-1) as Extract<ModelEvent, { type: 'done' }>;
    assert.deepEqual(done.meshing, { backend: 'fake 1', pools: 1, workers: 2 });
    // The model's sphere: estimated in the scene event, made again from the meshes in the end's.
    assert.equal(scene.bounds?.from, 'estimated');
    assert.equal(done.bounds?.from, 'meshes');
  });

test('loadModelIn: cancelled, it stops: after the scene, or before meshing', { skip }, async () => {
  const bytes = stepInput();
  const { tessellation } = fake(20);
  const events: ModelEvent[] = [];
  let stop = false;
  const run = loadModelIn(bytes, DEFAULT_SETTINGS, 2, tessellation, (e) => {
    if (e.type !== 'importing') events.push(e);
    if (e.type === 'mesh') stop = true;
  }, () => stop);
  await run;
  assert.deepEqual(events.map((e) => e.type), ['scene', 'mesh']);
  const none: ModelEvent[] = [];
  await loadModelIn(bytes, DEFAULT_SETTINGS, 2, fake().tessellation, (e) => none.push(e), () => true);
  assert.deepEqual(none, []);
});

test('loadModelIn: a file with nothing to mesh ends at once', async () => {
  const bytes = { format: 'step' as const, bytes: new TextEncoder().encode('ISO-10303-21;\nHEADER;\n' +
    "FILE_DESCRIPTION((''),'2;1');\n" +
    "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\n" +
    'END-ISO-10303-21;\n') };
  const events: ModelEvent[] = [];
  await loadModelIn(bytes, DEFAULT_SETTINGS, 2, fake().tessellation, (e) => e.type !== 'importing' && events.push(e),
    () => false);
  assert.deepEqual(events.map((e) => e.type), ['scene', 'done']);
});

test("loadModelIn: STEP's tessellated geometry read and shown, nothing meshed; by the backend when set", async () => {
  // A triangle in a tessellated shell, the product's only representation.
  const text = `ISO-10303-21;HEADER;FILE_NAME('','',(''),(''),'','','');FILE_SCHEMA((
'AP242_MANAGED_MODEL_BASED_3D_ENGINEERING_MIM_LF { 1 0 10303 442 1 1 4 }'));ENDSEC;DATA;
#10=(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.));
#16=(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNIT_ASSIGNED_CONTEXT((#10))REPRESENTATION_CONTEXT('',''));
#1=APPLICATION_CONTEXT('');
#2=PRODUCT_CONTEXT('',#1,'mechanical');
#3=PRODUCT_DEFINITION_CONTEXT('part definition',#1,'design');
#200=PRODUCT('P','P','',(#2));
#201=PRODUCT_DEFINITION_FORMATION('','',#200);
#202=PRODUCT_DEFINITION('','',#201,#3);
#203=PRODUCT_DEFINITION_SHAPE('','',#202);
#100=COORDINATES_LIST('',3,((0.,0.,0.),(1.,0.,0.),(0.,1.,0.)));
#101=TRIANGULATED_FACE('',#100,3,(),$,(),((1,2,3)));
#102=TESSELLATED_SHELL('',(#101),$);
#103=TESSELLATED_SHAPE_REPRESENTATION('t',(#102),#16);
#205=SHAPE_DEFINITION_REPRESENTATION(#203,#103);
ENDSEC;END-ISO-10303-21;`;
  const input = { format: 'step' as const, bytes: new TextEncoder().encode(text) };
  const events: ModelEvent[] = [];
  const transfers: ArrayBuffer[][] = [];
  const { requests, tessellation } = fake();
  await loadModelIn(input, DEFAULT_SETTINGS, 2, tessellation, (e, t) => {
    if (e.type === 'importing') return;
    events.push(e);
    transfers.push(t ?? []);
  }, () => false);
  assert.deepEqual(events.map((e) => e.type), ['scene', 'done']);
  const scene = (events[0] as { scene: Scene }).scene;
  assert.deepEqual(scene.parts[0]!.lods[0]!.mesh.faces.map((f) => f.source), [101]);
  assert.equal(transfers[0]!.length > 0, true);
  assert.equal(requests.length, 0);
  // By the backend: a B-rep part, meshed.
  const backend: ModelEvent[] = [];
  await loadModelIn(input, { ...DEFAULT_SETTINGS, tessellated: 'backend' }, 2, tessellation,
    (e) => e.type !== 'importing' && backend.push(e),
    () => false);
  assert.deepEqual(backend.map((e) => e.type), ['scene', 'mesh', 'done']);
  assert.equal(requests.length, 1);
});

test('importModel and loadModelIn: GLB, .gltf with its .bin, three.js JSON, 3MF, the scene they were written from',
  async () => {
    // The fixture with meshes instead of B-rep (as the exporters take it), written with our extras.
    const s = fixture();
    s.parts = s.parts.map(({ brep: _, ...p }, i) => ({ ...p, lods: [{ mesh: i === 0 ? plate() : wire(),
      from: 'source' as const }] }));
    const lines = { edges: true, curves: true };
    const view = exportView(s, lines);
    const sidecar = await gltfJson(s, view, 'model.bin', { extras: true, compression: 'none', hidden: 'extension' });
    const inputs: ModelInput[] = [
      { format: 'glb', bytes: (await glb(s, view, { extras: true, hidden: 'extension' })).bytes },
      { format: 'gltf', bytes: new TextEncoder().encode(sidecar.json), resources: { 'model.bin': sidecar.bin! } },
      { format: 'threejs', bytes: new TextEncoder().encode(threejsJson(s, view, { extras: true })) }];
    for (const input of inputs) {
      const back = await importModel(input);
      assert.deepEqual(viewDifferences({ scene: s, view: pruneView(view) }, { scene: back,
        view: exportView(back, lines) }, { tolerance: 1e-3 }), [], input.format);
      // Nothing to mesh: the scene, its levels' buffers transferred, then the end; no tessellation asked for.
      const { requests, tessellation } = fake();
      const events: ModelEvent[] = [];
      const transfers: ArrayBuffer[][] = [];
      await loadModelIn(input, DEFAULT_SETTINGS, 2, tessellation, (e, t) => {
        events.push(e);
        transfers.push(t ?? []);
      }, () => false);
      // (Our files carry the plate's B-rep edges: none to find.)
      assert.deepEqual(events.map((e) => e.type), ['scene', 'done'], input.format);
      assert.equal(requests.length, 0);
      const scene = (events[0] as { scene: Scene }).scene;
      assert.ok(scene.parts.every((p) => p.lods.length === 1 && !p.brep), input.format);
      assert.deepEqual(transfers[0], levelBuffers(scene));
      assert.ok(transfers[0]!.length >= 2);
    }
    // 3MF with our extras: the plate's triangles with their faces and colours (3MF has no lines, so not the wire),
    // nothing to mesh.
    const only = (n: ExportNode): ExportNode => ({ ...n, parts: n.parts.filter((p) => view.looks[p.look]!.mesh.indices
      .length > 0), children: n.children.map(only) });
    const tm = threemf(s, view, { extras: true, nonManifold: 'surface', hidden: 'keep' }).chunks;
    const bytes = new Uint8Array(tm.reduce((n, c) => n + c.length, 0));
    tm.reduce((at, c) => { bytes.set(c, at); return at + c.length; }, 0);
    const back = await importModel({ format: '3mf', bytes });
    assert.deepEqual(viewDifferences({ scene: s, view: pruneView({ ...view, roots: view.roots.map(only) }) },
      { scene: back, view: exportView(back, lines) }, { lines: false }), []);
    const { requests, tessellation } = fake();
    const events: ModelEvent[] = [];
    const sent: ArrayBuffer[][] = [];
    await loadModelIn({ format: '3mf', bytes }, DEFAULT_SETTINGS, 2, tessellation, (e, t) => {
      events.push(e);
      sent.push(t ?? []);
    }, () => false);
    // 3MF has no lines: the plate's edges found from its triangles, after the scene, before the end; its level's
    // buffers kept here for that (copied to the page, not transferred).
    assert.deepEqual(events.map((e) => e.type), ['scene', 'edges', 'done']);
    assert.equal(requests.length, 0);
    const found = events[1] as Extract<ModelEvent, { type: 'edges' }>;
    const sc = (events[0] as { scene: Scene }).scene;
    assert.ok(found.positions.length > 0 && sc.parts[found.part]!.lods[0]!.mesh.indices.length > 0);
    assert.deepEqual(sent[0], []);
    assert.deepEqual(sent[1], [found.positions.buffer]);
    // A .gltf whose .bin isn't given: the importer says so.
    const missing = await importModel({ format: 'gltf', bytes: new TextEncoder().encode(sidecar.json) });
    assert.equal(missing.diagnostics[0]?.severity, 'error');
  });

test('edgesOf: on 1 um in the world, whatever the mesh\'s unit; placedScales from the first placement', () => {
  // The two triangles of edges.test.ts, the shared edge's ends apart by d: in metres (scale 1000 mm a unit) and in
  // millimetres (1), 0.4 um apart one vertex (4 segments), 4 um apart two (6).
  const mesh = (d: number, unit: number): Mesh => ({ origin: [0, 0, 0], faces: [], indices: Uint32Array.of(0, 1, 2,
    3, 4, 5), positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1 + d, 0, 0, 1, 1, 0, d, 1, 0].map((x) =>
    x / unit)) });
  for (const unit of [1000, 1]) {
    assert.equal(edgesOf(mesh(0.0004, unit), unit).length / 6, 4, `${unit}`);
    assert.equal(edgesOf(mesh(0.004, unit), unit).length / 6, 6, `${unit}`);
  }
  assert.equal(needsEdges(mesh(0, 1)), true);
  assert.equal(needsEdges({ ...mesh(0, 1), edges: [{ source: 1, start: 0, count: 2, kind: 'shared' }] }), false);
  // The fixture's plate is placed in inches: 25.4 mm a unit.
  assert.ok(Math.abs(placedScales(fixture()).get(0)! - 25.4) < 1e-9);
});
