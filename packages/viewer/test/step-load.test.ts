import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Scene, TessellationRequest, TessellationResult, Tessellator } from 'cad-scene';
import { loadStepIn, meshable, meshBuffers, postable, type StepEvent } from '../src/step-load.ts';
import { scene as fixture } from './fixtures.ts';
import { DEFAULT_SETTINGS } from '../src/tessellation.ts';

const step = path.resolve(import.meta.dirname,
  '../../../test_corpus/third_party/gkv311-opencascade-dataset/step/as1-oc-214-mat.stp');
const skip = fs.existsSync(step) ? false : 'corpus not fetched';

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

test('postable: payload functions gone, the rest as it was; a structured clone takes it', () => {
  const brep = { kind: 'brep', name: 'p', payload: () => new Uint8Array(1), rootId: 7 };
  const mesh = { kind: 'mesh', name: 'm', lods: [] };
  const scene = { parts: [brep, mesh], components: [], roots: [] } as unknown as Scene;
  const p = postable(scene);
  assert.equal((p.parts[0] as { payload?: unknown }).payload, undefined);
  assert.equal((p.parts[0] as { rootId?: number }).rootId, 7);
  assert.equal(p.parts[1], mesh);
  assert.equal((scene.parts[0] as { payload?: unknown }).payload, brep.payload);
  assert.doesNotThrow(() => structuredClone(p));
  assert.throws(() => structuredClone(scene));
});

test('meshable: placed brep parts only', () => {
  const s = fixture();
  assert.deepEqual(meshable(s), [0, 1]);
  // A third part, placed nowhere; a mesh part, placed.
  s.parts.push({ ...s.parts[0]!, name: 'spare' });
  s.parts.push({ kind: 'mesh', name: 'tri', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] });
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

test('loadStepIn: the scene (postable), a mesh per placed brep part, then the end with what meshed it',
  { skip }, async () => {
    const { requests, tessellation } = fake();
    const events: StepEvent[] = [];
    const transfers: ArrayBuffer[][] = [];
    await loadStepIn(new Uint8Array(fs.readFileSync(step)), DEFAULT_SETTINGS, 3, tessellation,
      (e, t) => { events.push(e); transfers.push(t ?? []); }, () => false);
    assert.deepEqual(events.map((e) => e.type), ['scene', ...requests.map(() => 'mesh'), 'done']);
    assert.equal(requests.length, 5);
    const scene = (events[0] as { scene: Scene }).scene;
    assert.doesNotThrow(() => structuredClone(scene));
    // Meshes with their buffers to transfer; the deflections from the settings (degrees to radians).
    assert.ok(transfers.slice(1, -1).every((t) => t.length === 2));
    assert.equal(requests[0]!.angularDeflection, DEFAULT_SETTINGS.angularDeflection * Math.PI / 180);
    const done = events.at(-1) as Extract<StepEvent, { type: 'done' }>;
    assert.deepEqual(done.meshing, { backend: 'fake 1', pools: 1, workers: 2 });
  });

test('loadStepIn: cancelled, it stops: after the scene, or before meshing', { skip }, async () => {
  const bytes = new Uint8Array(fs.readFileSync(step));
  const { tessellation } = fake(20);
  const events: StepEvent[] = [];
  let stop = false;
  const run = loadStepIn(bytes, DEFAULT_SETTINGS, 2, tessellation, (e) => {
    events.push(e);
    if (e.type === 'mesh') stop = true;
  }, () => stop);
  await run;
  assert.deepEqual(events.map((e) => e.type), ['scene', 'mesh']);
  const none: StepEvent[] = [];
  await loadStepIn(bytes, DEFAULT_SETTINGS, 2, fake().tessellation, (e) => none.push(e), () => true);
  assert.deepEqual(none, []);
});

test('loadStepIn: a file with nothing to mesh ends at once', async () => {
  const bytes = new TextEncoder().encode("ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION((''),'2;1');\n" +
    "FILE_NAME('','',(''),(''),'','','');\nFILE_SCHEMA(('AUTOMOTIVE_DESIGN'));\nENDSEC;\nDATA;\nENDSEC;\n" +
    'END-ISO-10303-21;\n');
  const events: StepEvent[] = [];
  await loadStepIn(bytes, DEFAULT_SETTINGS, 2, fake().tessellation, (e) => events.push(e), () => false);
  assert.deepEqual(events.map((e) => e.type), ['scene', 'done']);
});
