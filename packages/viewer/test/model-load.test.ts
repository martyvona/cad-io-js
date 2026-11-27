import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import type { Mesh, Scene, TessellationRequest, TessellationResult, Tessellator } from 'cad-scene';
import { edgesOf, handOver, importModel, isLent, levelBuffers, loadModelIn, meshable, meshBuffers, meshModelIn,
  needModels, needsEdges, edgeJobs, ownBuffers, postable, takeBack, type ModelEvent, type ModelInput }
  from '../src/model-load.ts';
import type { PartModel } from '../src/part-model.ts';
import { exportView, leafParts, pruneView, viewDifferences } from 'cad-scene';
import { threemf } from 'export-3mf';
import { glb, gltfJson } from 'export-gltf';
import { threejsJson } from 'export-threejs';
import { scene as fixture, plate, wire } from './fixtures.ts';
import { MESH_PROFILES } from 'cad-scene';
import { defaultSettings } from '../src/tessellation.ts';
import { analysisFor, BrepBuilder, openBrep, rowCount } from 'cad-brep';

const DEFAULT_SETTINGS = defaultSettings('coarse');

const step = path.resolve(import.meta.dirname,
  '../../../test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const skip = fs.existsSync(step) ? false : 'corpus not fetched';
const stepInput = (): ModelInput => ({ format: 'step', bytes: new Uint8Array(fs.readFileSync(step)) });

/** The models a run's mesh events handed over, by part (the page's side of model-load.ts's handOver). */
const handed = (events: readonly ModelEvent[]): [number, PartModel][] => events.flatMap((e) =>
  e.type === 'mesh' ? [[e.part, { model: e.model, ...(e.analysis ? { analysis: e.analysis } : {}) }] as
    [number, PartModel]] : []);

const firstFace = (data: Uint8Array) => {
  const d = openBrep(data);
  return rowCount(d, 'face') ? d.face.id[0]! : null;
};

/**
 * A stand-in tessellator: a triangle per request, its face the model's first, after `delay` ms; its pool's jobs (the
 * healing) run here, counted.
 */
function fake(delay = 0) {
  const requests: TessellationRequest[] = [];
  const runs: string[] = [];
  const pool = { run: async <T>(job: { export: string }, input: unknown, o: { onProgress?: (m: string) => void } = {}):
    Promise<T> => {
    runs.push(job.export);
    const heal = await import('cad-heal');
    return (heal as unknown as Record<string, (i: unknown, p: (m: string) => void) => Promise<T>>)[job.export]!(
      input, o.onProgress ?? (() => {}));
  } };
  const tess: Tessellator = {
    info: { name: 'fake', version: '1', license: 'MIT', formats: ['cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    init: async () => {},
    dispose: () => {},
    tessellate: async (req): Promise<TessellationResult> => {
      requests.push(req);
      await new Promise((r) => setTimeout(r, delay));
      return { origin: req.origin ?? [0, 0, 0], positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0),
        indices: Uint32Array.of(0, 1, 2), faces: [{ entityId: firstFace(req.data), start: 0, count: 3 }],
        diagnostics: [] };
    },
  };
  return { requests, runs, tessellation: { get: async () => ({ tess, workers: 2, pool }),
    describe: () => ({ backend: 'fake 1', pools: 1 }) } };
}

test('postable: the B-rep\'s model and functions gone, the rest as it was; a structured clone takes it', () => {
  const model = new BrepBuilder().finish();
  const part = { name: 'p', lods: [], brep: { format: 'step', model, outline: () => ({}) } };
  const mesh = { name: 'm', lods: [] };
  const scene = { parts: [part, mesh], components: [], roots: [] } as unknown as Scene;
  const p = postable(scene);
  assert.deepEqual(Object.keys(p.parts[0]!.brep!).filter((k) => p.parts[0]!.brep![k as 'model'] !== undefined),
    ['format']);
  assert.equal(p.parts[1], mesh);
  assert.equal(scene.parts[0]!.brep!.model, model);
  assert.doesNotThrow(() => structuredClone(p));
  assert.throws(() => structuredClone(scene));
});

test('loadModelIn: the input taken and its bytes collected before meshing; a source already taken refused',
  { skip }, async () => {
    v8.setFlagsFromString('--expose-gc');
    const gc = vm.runInNewContext('gc') as () => void;
    const source: { input?: ModelInput } = { input: stepInput() };
    const bytes = new WeakRef(source.input!.bytes);
    const { tessellation } = fake();
    const inner = (await tessellation.get()).tess;
    let freed: boolean | undefined;
    const tess = { ...inner, tessellate: async (req: TessellationRequest) => {
      if (freed === undefined) {
        for (let i = 0; i < 3 && bytes.deref(); i++) { await new Promise((r) => setTimeout(r, 0)); gc(); }
        freed = bytes.deref() === undefined;
      }
      return inner.tessellate(req);
    } };
    await loadModelIn(source, DEFAULT_SETTINGS, 2, { ...tessellation, get: async () => ({ tess, workers: 2,
      pool: { run: () => Promise.reject(new Error('no healing here')) } }) },
      () => {}, () => false);
    assert.equal(source.input, undefined);
    assert.equal(freed, true);
    await assert.rejects(loadModelIn(source, DEFAULT_SETTINGS, 2, tessellation, () => {}, () => false),
      /already taken/);
  });

test('meshable: placed brep parts only', () => {
  const s = fixture();
  assert.deepEqual(meshable(s), [0, 1]);
  // A third part, placed nowhere; a mesh part, placed.
  s.parts.push({ ...s.parts[0]!, name: 'spare' });
  s.parts.push({ name: 'tri', sources: [], properties: {}, origin: [0, 0, 0], lods: [] });
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
    await loadModelIn({ input: stepInput() }, DEFAULT_SETTINGS, 3, tessellation, (e, t) => {
      if (e.type === 'importing') told.push(e.progress.phase);
      else {
        events.push(e);
        transfers.push(t ?? []);
      }
    }, () => false);
    // The import's phases first, in order, before the scene (each told as it begins, and again only after
    // PROGRESS_MS within it: how often depends on the machine's speed), then healing's (on by default).
    assert.deepEqual([...new Set(told)], ['reading', 'structure', 'parts', 'assembly', 'healing']);
    assert.deepEqual(events.map((e) => e.type), ['scene', ...requests.map(() => 'mesh'), 'done']);
    assert.equal(requests.length, 5);
    const scene = (events[0] as { scene: Scene }).scene;
    assert.doesNotThrow(() => structuredClone(scene));
    // Meshes with their buffers to transfer: positions, indices, and the faces' outlines (the fake's one face is the
    // representation's id, not one of the file's faces, so every face of the file counts as failed: outlined from
    // the file); a profile's deflections exactly (not through degrees).
    // (And the edges found from their triangles, as the fake backend gives none: its buffer too.)
    // (And each part's B-rep model's buffer, handed over to the page with its mesh: its own, to transfer; and its
    // analysis's, healing on by default.)
    assert.ok(transfers.slice(1, -1).every((t) => t.length === 6));
    const meshes = events.filter((e) => e.type === 'mesh') as Extract<ModelEvent, { type: 'mesh' }>[];
    assert.ok(meshes.every((e, k) => e.model.byteLength > 0 && transfers[k + 1]!.includes(e.model)));
    assert.equal(new Set(meshes.map((e) => e.model)).size, meshes.length);
    assert.ok(meshes.every((e) => e.foundEdges && e.foundEdges.length > 0));
    assert.ok(meshes.every((e) => e.mesh!.faceOutlines!.length > 0 && e.mesh!.faces.length > 1));
    assert.equal(requests[0]!.angularDeflection, MESH_PROFILES.coarse.angularDeflection);
    // Custom: the settings' deflections, degrees to radians.
    const custom = fake();
    await loadModelIn({ input: stepInput() }, { ...DEFAULT_SETTINGS, profile: 'custom', angularDeflection: 10 }, 3,
      custom.tessellation, () => {}, () => false);
    assert.equal(custom.requests[0]!.angularDeflection, 10 * Math.PI / 180);
    // The edges found as the source says: a weld tolerance past the parts' size makes every triangle one point.
    const welded: ModelEvent[] = [];
    await loadModelIn({ input: stepInput(), edges: { angle: 10, grid: 1e6 } }, DEFAULT_SETTINGS, 3, fake().tessellation,
      (e) => { welded.push(e); }, () => false);
    const weldedMeshes = welded.filter((e) => e.type === 'mesh') as Extract<ModelEvent, { type: 'mesh' }>[];
    assert.ok(weldedMeshes.length === 5 && weldedMeshes.every((e) => e.foundEdges?.length === 0));
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
  const run = loadModelIn({ input: bytes }, DEFAULT_SETTINGS, 2, tessellation, (e) => {
    if (e.type !== 'importing') events.push(e);
    if (e.type === 'mesh') stop = true;
  }, () => stop);
  await run;
  assert.deepEqual(events.map((e) => e.type), ['scene', 'mesh']);
  const none: ModelEvent[] = [];
  await loadModelIn({ input: bytes }, DEFAULT_SETTINGS, 2, fake().tessellation, (e) => none.push(e), () => true);
  assert.deepEqual(none, []);
});

test('loadModelIn: a file with nothing to mesh ends at once', async () => {
  const bytes = { format: 'step' as const, bytes: new TextEncoder().encode('ISO-10303-21;\nHEADER;\n' +
    "FILE_DESCRIPTION((''),'2;1');\n" +
    "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\n" +
    'END-ISO-10303-21;\n') };
  const events: ModelEvent[] = [];
  await loadModelIn({ input: bytes }, DEFAULT_SETTINGS, 2, fake().tessellation,
    (e) => e.type !== 'importing' && events.push(e), () => false);
  assert.deepEqual(events.map((e) => e.type), ['scene', 'done']);
});

test("loadModelIn: STEP's tessellated geometry read and shown, nothing meshed", async () => {
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
  await loadModelIn({ input }, DEFAULT_SETTINGS, 2, tessellation, (e, t) => {
    if (e.type === 'importing') return;
    events.push(e);
    transfers.push(t ?? []);
  }, () => false);
  assert.deepEqual(events.map((e) => e.type), ['scene', 'done']);
  const scene = (events[0] as { scene: Scene }).scene;
  assert.deepEqual(scene.parts[0]!.lods[0]!.mesh.faces.map((f) => f.source), [101]);
  assert.equal(transfers[0]!.length > 0, true);
  assert.equal(requests.length, 0);
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
      await loadModelIn({ input }, DEFAULT_SETTINGS, 2, tessellation, (e, t) => {
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
    const tm = threemf(s, view, { extras: true, nonManifold: 'surface', hidden: 'keep' }).chunks;
    const bytes = new Uint8Array(tm.reduce((n, c) => n + c.length, 0));
    tm.reduce((at, c) => { bytes.set(c, at); return at + c.length; }, 0);
    const back = await importModel({ format: '3mf', bytes });
    // (Without the wire, the subassembly holds the plate alone: a leaf, read as the plate placed, leafParts.)
    const held = { ...s, components: s.components.map((c) => ({ ...c, parts: c.parts.filter((r) =>
      s.parts[r.part]!.lods[0]!.mesh.indices.length > 0) })), overrides: [...s.overrides] };
    leafParts(held);
    const heldView = exportView(held, lines);
    assert.deepEqual(viewDifferences({ scene: held, view: pruneView(heldView) },
      { scene: back, view: exportView(back, lines) }, { lines: false }), []);
    const { requests, tessellation } = fake();
    const events: ModelEvent[] = [];
    const sent: ArrayBuffer[][] = [];
    let worker: Scene | undefined;
    await loadModelIn({ input: { format: '3mf', bytes } }, DEFAULT_SETTINGS, 2, tessellation, (e, t) => {
      // (The scene as the page gets it: a copy, as posting it makes one; its levels aren't transferred here.)
      events.push(e.type === 'scene' ? structuredClone(e) : e);
      sent.push(t ?? []);
    }, () => false, {}, (s) => { worker = s; });
    // 3MF has no lines: the plate's edges found from its triangles, after the scene, before the end; its level's
    // buffers kept here for that (copied to the page, not transferred).
    assert.deepEqual(events.map((e) => e.type), ['scene', 'edges', 'done']);
    assert.equal(requests.length, 0);
    const found = events[1] as Extract<ModelEvent, { type: 'edges' }>;
    const sc = (events[0] as { scene: Scene }).scene;
    assert.ok(found.positions.length > 0 && sc.parts[found.part]!.lods[0]!.mesh.indices.length > 0);
    assert.deepEqual(sent[0], []);
    assert.deepEqual(sent[1], [found.positions.buffer]);
    // Its edges found, the worker's copy of that level released (detached, as the levels it transfers are), the
    // page's kept.
    const level = worker!.parts[found.part]!.lods[0]!.mesh;
    assert.equal(level.indices.length, 0);
    assert.ok(meshBuffers(level).every((b) => b.byteLength === 0 && b.detached));
    assert.ok(sc.parts[found.part]!.lods[0]!.mesh.indices.length > 0);
    // A .gltf whose .bin isn't given: the importer says so.
    const missing = await importModel({ format: 'gltf', bytes: new TextEncoder().encode(sidecar.json) });
    assert.equal(missing.diagnostics[0]?.severity, 'error');
  });

test('edgesOf: on 1 um; edgeJobs: placed file levels without edges', () => {
  // The two triangles of edges.test.ts, the shared edge's ends apart by d (mm): 0.4 um apart one vertex (4 segments),
  // 4 um apart two (6).
  const mesh = (d: number): Mesh => ({ origin: [0, 0, 0], faces: [], indices: Uint32Array.of(0, 1, 2, 3, 4, 5),
    positions: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1 + d, 0, 0, 1, 1, 0, d, 1, 0) });
  assert.equal(edgesOf(mesh(0.0004)).length / 6, 4);
  assert.equal(edgesOf(mesh(0.004)).length / 6, 6);
  assert.equal(needsEdges(mesh(0)), true);
  assert.equal(needsEdges({ ...mesh(0), edges: [{ source: 1, start: 0, count: 2, kind: 'shared' }] }), false);
  // The plate and a copy of it as file levels without edges, the copy unplaced; the wire (no triangles); a B-rep part.
  const s = fixture();
  const level = (m: Mesh) => [{ from: 'tessellated' as const, mesh: m }];
  s.parts = [{ ...s.parts[0]!, brep: undefined, lods: level(mesh(0)) }, { ...s.parts[1]!, brep: undefined,
    lods: level(wire()) }, { ...s.parts[0]!, brep: undefined, lods: level(mesh(0)) }, { ...s.parts[0]!,
    lods: level(mesh(0)) }];
  s.components[1]!.parts.push({ part: 3, transform: s.components[1]!.parts[0]!.transform });
  assert.deepEqual(edgeJobs(s, {}).map((j) => j.part), [0]);
  // With edges of its own: none.
  s.parts[0]!.lods = level({ ...mesh(0), edges: [{ source: 1, start: 0, count: 2, kind: 'shared' }] });
  assert.deepEqual(edgeJobs(s, {}), []);
});

test('loadModelIn: keep has the scene, its meshes as its parts\' levels once meshed (to export)', { skip },
  async () => {
  const { tessellation } = fake();
  let kept: Scene | undefined;
  await loadModelIn({ input: stepInput() }, DEFAULT_SETTINGS, 2, tessellation, () => {}, () => false, {},
    (s) => { kept = s; });
  assert.ok(kept);
  const meshed = kept!.parts.filter((p) => p.brep && p.lods.some((l) => l.from === 'tessellated'));
  assert.equal(meshed.length, kept!.parts.filter((p) => p.brep).length);
});

test('meshModelIn: the scene kept by a load meshed again (Mesh again): a mesh per placed brep part and the end, '
  + 'no scene or import', { skip }, async () => {
  let kept: Scene | undefined;
  const loaded: ModelEvent[] = [];
  await loadModelIn({ input: stepInput() }, DEFAULT_SETTINGS, 3, fake().tessellation, (e) => loaded.push(e),
    () => false, {}, (scene) => { kept = scene; });
  // Every placed part's model with the page once meshed: meshing again needs them back first.
  assert.ok(meshable(kept!).every((i) => isLent(kept!, i)));
  await assert.rejects(meshModelIn(kept!, DEFAULT_SETTINGS, 3, fake().tessellation, () => {}, () => false),
    /B-rep models are with the page/);
  takeBack(kept!, handed(loaded));
  assert.ok(meshable(kept!).every((i) => !isLent(kept!, i)));
  const { requests, tessellation } = fake();
  const events: ModelEvent[] = [];
  const settings = { ...DEFAULT_SETTINGS, profile: 'custom' as const, angularDeflection: 10 };
  await meshModelIn(kept!, settings, 3, tessellation, (e) => events.push(e), () => false);
  takeBack(kept!, handed(events));
  assert.deepEqual(events.map((e) => e.type), [...requests.map(() => 'mesh'), 'done']);
  assert.equal(requests.length, 5);
  assert.equal(requests[0]!.angularDeflection, 10 * Math.PI / 180);
  // Each part's levels: the first meshing's and this one's.
  assert.ok(meshable(kept!).every((i) => kept!.parts[i]!.lods.filter((l) => l.from === 'tessellated').length === 2));
  // The end only after `before` (a load's edges found for its file levels): here done 50 ms after the last mesh.
  let release!: () => void;
  const order: string[] = [];
  const more: ModelEvent[] = [];
  await meshModelIn(kept!, settings, 3, fake().tessellation, (e) => {
    more.push(e);
    order.push(e.type);
    if (order.filter((t) => t === 'mesh').length === 5 && e.type === 'mesh') setTimeout(release, 50);
  }, () => false, new Promise<void>((r) => { release = () => { order.push('before'); r(); }; }));
  assert.deepEqual(order.slice(-2), ['before', 'done']);
  takeBack(kept!, handed(more));
  // Cancelled at once: nothing, the models kept here.
  const none: ModelEvent[] = [];
  await meshModelIn(kept!, settings, 3, fake().tessellation, (e) => none.push(e), () => true);
  assert.deepEqual(none, []);
  assert.ok(meshable(kept!).every((i) => !isLent(kept!, i)));
});

test('handOver and takeBack: one copy, moved; the stand-in throws on any use; outlines made from the model taken '
  + 'back; parts sharing a buffer given their own', { skip }, async () => {
  const scene = await importModel(stepInput(), {}, { heal: { heal: false } });
  const part = meshable(scene)[0]!, brep = scene.parts[part]!.brep!;
  const before = [...new Uint8Array(brep.model.buffer)].join();
  const outlined = (s: Scene) => s.parts[part]!.brep!.outline!({ linearDeflection: 0.5, angularDeflection: 0.5 });
  const want = outlined(scene).outlines.length;
  assert.ok(want > 0);
  const held = handOver(scene, part);
  // (As imported, not healed: no analysis.)
  assert.deepEqual(Object.keys(held), ['model']);
  assert.ok(isLent(scene, part));
  assert.throws(() => brep.model.face, /part \d+'s B-rep model is with the page \(reading face\)/);
  assert.throws(() => handOver(scene, part), /with the page already/);
  assert.throws(() => needModels(scene, meshable(scene)), /B-rep models are with the page/);
  assert.doesNotThrow(() => needModels(scene, meshable(scene).filter((i) => i !== part)));
  // Back: the same bytes, the outlines from them (the import's closure held the old views).
  // (An analysis it didn't lend refused, nothing taken back.)
  assert.throws(() => takeBack(scene, [[part, { ...held, analysis: new ArrayBuffer(8) }]]),
    /analysis wasn't lent/);
  assert.ok(isLent(scene, part));
  takeBack(scene, [[part, held]]);
  assert.ok(!isLent(scene, part));
  assert.equal([...new Uint8Array(scene.parts[part]!.brep!.model.buffer)].join(), before);
  assert.equal(outlined(scene).outlines.length, want);
  assert.throws(() => takeBack(scene, [[part, held]]), /B-rep model wasn't lent/);
  // Two parts on one buffer: the second given a copy (a transfer would detach both), its outlines from the copy.
  const other = scene.parts.findIndex((p, i) => i !== part && p.brep);
  scene.parts[other]!.brep!.model = scene.parts[part]!.brep!.model;
  ownBuffers(scene);
  const [a, b] = [part, other].map((i) => scene.parts[i]!.brep!.model.buffer);
  assert.notEqual(a, b);
  assert.equal([...new Uint8Array(b!)].join(), before);
  assert.ok(scene.parts[other]!.brep!.outline!({ linearDeflection: 0.5, angularDeflection: 0.5 }).outlines.length > 0);
});

const healInput = async (): Promise<ModelInput> => {
  const { healTestScene, stepOf } = await import('../../cad-heal/test/scene.ts');
  return { format: 'step', bytes: stepOf(healTestScene()) };
};
const healingSaid = (d: { message: string }[]) => d.flatMap((x) => {
  const m = /^(strayPole|pcurve\w+|edgeTolerance|vertexTolerance|tolerances grown):/.exec(x.message);
  return m ? [m[1]!] : [];
});

test('loadModelIn with heal on: the scene first, then healing in the pool (its phase told), the healed models meshed '
  + 'and kept, healing\'s diagnostics with the end', async () => {
  const { requests, runs, tessellation } = fake();
  const events: ModelEvent[] = [];
  // (Each mesh event's transfer list.)
  const transfers: ArrayBuffer[][] = [];
  let kept: Scene | undefined;
  await loadModelIn({ input: await healInput() }, { ...DEFAULT_SETTINGS, heal: true }, 3, tessellation,
    (e, t) => {
      events.push(e);
      if (e.type === 'mesh') transfers.push(t ?? []);
    }, () => false, {}, (s) => { kept = s; });
  const types = events.map((e) => e.type === 'importing' ? e.progress.phase : e.type);
  const scene = types.indexOf('scene'), healing = types.lastIndexOf('healing'), mesh = types.indexOf('mesh');
  assert.ok(scene >= 0 && scene < types.indexOf('healing') && healing < mesh, types.join());
  const last = events.filter((e) => e.type === 'importing').at(-1) as { progress: { done: number; total: number } };
  assert.deepEqual([last.progress.done, last.progress.total], [4, 4]);
  assert.deepEqual(runs, ['healJob', 'healJob', 'healJob', 'healJob']);
  // The scene event's diagnostics have none of healing's; the end's do.
  assert.deepEqual(healingSaid((events[types.indexOf('scene')] as { scene: Scene }).scene.diagnostics), []);
  const done = events.at(-1) as Extract<ModelEvent, { type: 'done' }>;
  assert.ok(healingSaid(done.diagnostics).includes('strayPole'));
  // What's meshed and kept is healed: every part with an analysis, the meshes from the healed models' bytes.
  assert.ok(kept!.parts.every((p) => p.brep!.analysis));
  const data = new Set(requests.map((r) => r.data.length));
  // Each analysis handed over with its model, both transferred; stand-ins left for both.
  const meshes = events.filter((e) => e.type === 'mesh') as Extract<ModelEvent, { type: 'mesh' }>[];
  assert.equal(meshes.length, 4);
  assert.ok(meshes.every((e, k) => e.analysis && transfers[k]!.includes(e.analysis)
    && transfers[k]!.includes(e.model)));
  const analyses = meshes.map((e) => [...new Uint8Array(e.analysis!)].join());
  for (const p of kept!.parts) assert.throws(() => p.brep!.analysis!.edge, /B-rep analysis is with the page/);
  // An analysis that doesn't come back with its model refused, nothing taken back.
  const back = handed(events);
  assert.throws(() => takeBack(kept!, [...back.slice(0, -1), [back.at(-1)![0], { model: back.at(-1)![1].model }]]),
    /analysis didn't come back/);
  assert.ok(meshable(kept!).every((i) => isLent(kept!, i)));
  takeBack(kept!, back);
  for (const p of kept!.parts) assert.ok(data.has(new Uint8Array(p.brep!.model.buffer).length));
  // Back: the same bytes, each still its model's (by its hash).
  for (const [k, [part]] of back.entries()) {
    const brep = kept!.parts[part]!.brep!;
    assert.equal([...new Uint8Array(brep.analysis!.buffer)].join(), analyses[k]);
    await analysisFor(brep.model, brep.analysis!);
  }
});

test('meshModelIn (Mesh again) with other healing: as imported, healed as asked; healed the same again: kept; healed '
  + 'otherwise, or cancelled partway: healed again in place (off: the sources back), a moved pole kept, said',
  async () => {
  const off = { ...DEFAULT_SETTINGS, heal: false };
  // (Each run's models taken back after it, as the page lends them for the next.)
  const load = async () => {
    let kept: Scene | undefined;
    const events: ModelEvent[] = [];
    await loadModelIn({ input: await healInput() }, off, 3, fake().tessellation, (e) => events.push(e), () => false,
      {}, (s) => { kept = s; });
    takeBack(kept!, handed(events));
    return kept!;
  };
  const again = async (scene: Scene, settings: typeof off, cancelled = () => false) => {
    const f = fake(), events: ModelEvent[] = [];
    await meshModelIn(scene, settings, 3, f.tessellation, (e) => events.push(e), cancelled);
    takeBack(scene, handed(events));
    const done = events.find((e) => e.type === 'done') as Extract<ModelEvent, { type: 'done' }> | undefined;
    return { runs: f.runs.length, said: done ? healingSaid(done.diagnostics) : undefined };
  };
  const on = { ...off, heal: true };
  const bytes = (m: { buffer: ArrayBuffer }) => [...new Uint8Array(m.buffer)].join();
  const kept = await load();
  const imported = kept.parts.map((p) => bytes(p.brep!.model));
  // As imported again: nothing healed, nothing run.
  assert.deepEqual(await again(kept, off), { runs: 0, said: [] });
  const a = await again(kept, on);
  assert.equal(a.runs, 4);
  assert.ok(a.said!.includes('strayPole'));
  const stray = kept.parts.findIndex((p) => p.name === 'stray'), healed = bytes(kept.parts[stray]!.brep!.model);
  assert.notEqual(healed, imported[stray]);
  // The same healing again: kept, the same diagnostics, nothing run.
  assert.deepEqual(await again(kept, on), { runs: 0, said: a.said });
  assert.equal(bytes(kept.parts[stray]!.brep!.model), healed);
  const healedBytes = kept.parts.map((p) => bytes(p.brep!.model));
  // Off: each healed part put back as its source in place, but the moved pole, which stays, said.
  const o = await again(kept, off);
  assert.deepEqual(o.said, ['strayPole'], 'the moved poles said kept');
  kept.parts.forEach((p, i) => {
    if (i !== stray) assert.equal(bytes(p.brep!.model), imported[i]!, `part ${i}: as imported`);
  });
  assert.notEqual(bytes(kept.parts[stray]!.brep!.model), imported[stray]!, 'the pole still moved');
  // A fix off, then on again: healed in place, as healing the file afresh would, the pole said kept.
  const noPole = await again(kept, { ...on, healFixes: { ...on.healFixes, pcurveReplace: false } });
  assert.ok(noPole.said!.includes('strayPole'), noPole.said!.join());
  assert.deepEqual(await again(kept, on), { runs: 4, said: a.said });
  assert.deepEqual(kept.parts.map((p) => bytes(p.brep!.model)), healedBytes, 'as healed the first time');
  // Cancelled while healing: part healed; healed again as asked from there, in place.
  const fresh = await load();
  let calls = 0;
  assert.deepEqual(await again(fresh, on, () => ++calls > 2), { runs: 4, said: undefined });
  await again(fresh, on);
  assert.deepEqual(fresh.parts.map((p) => bytes(p.brep!.model)), healedBytes, 'healed as asked after the cancel');
});

test('healing keeps no models as imported: once healed, the imported ones are free to be collected', async () => {
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc') as () => void;
  let kept: Scene | undefined;
  const events: ModelEvent[] = [];
  await loadModelIn({ input: await healInput() }, { ...DEFAULT_SETTINGS, heal: false }, 3, fake().tessellation,
    (e) => events.push(e), () => false, {}, (s) => { kept = s; });
  takeBack(kept!, handed(events.splice(0)));
  const stray = kept!.parts.findIndex((p) => p.name === 'stray');
  // (Its buffer: the model's object is made again each time it's taken back.)
  const imported = new WeakRef(kept!.parts[stray]!.brep!.model.buffer);
  await meshModelIn(kept!, { ...DEFAULT_SETTINGS, heal: true }, 3, fake().tessellation, (e) => events.push(e),
    () => false);
  takeBack(kept!, handed(events.splice(0)));
  assert.notEqual(kept!.parts[stray]!.brep!.model.buffer, imported.deref());
  for (let i = 0; i < 5 && imported.deref(); i++) { await new Promise((r) => setTimeout(r, 0)); gc(); }
  assert.equal(imported.deref(), undefined, 'the stray part\'s model as imported is still held');
});

test('the default settings heal as cad-heal\'s HEAL_BY_DEFAULT says, its fixes as cad-heal has them', async () => {
  const { FIXES_OFF_BY_DEFAULT, HEAL_BY_DEFAULT, HEAL_FIXES } = await import('cad-heal/options');
  assert.equal(DEFAULT_SETTINGS.heal, HEAL_BY_DEFAULT);
  assert.deepEqual(Object.keys(DEFAULT_SETTINGS.healFixes), [...HEAL_FIXES]);
  for (const f of HEAL_FIXES) assert.equal(DEFAULT_SETTINGS.healFixes[f], !FIXES_OFF_BY_DEFAULT.includes(f));
});
