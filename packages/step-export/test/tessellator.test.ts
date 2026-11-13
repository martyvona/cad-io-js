// StepTessellator: B-rep model requests written as STEP for a backend that reads STEP; others passed on as they are.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder } from 'cad-brep';
import { openEdgesMessage, oracleMeasures, type TessellationRequest, type TessellationResult, type Tessellator } from
  'cad-scene';
import { parseStep } from 'step-parser';
import { cube, spheres, withoutIds } from '../../cad-brep/test/models.ts';
import { quads } from '../../cad-scene/test/meshes.ts';
import { STEP_ADAPTER, STEP_WRITER_VERSION, StepTessellator, stepPartBytes } from '../src/index.ts';

/** A STEP backend that keeps what it was sent, and answers with `answer` (default: nothing meshed). */
function backend(answer?: (req: TessellationRequest) => Partial<TessellationResult>) {
  const seen: TessellationRequest[] = [];
  const t: Tessellator & { seen: TessellationRequest[] } = {
    seen,
    info: { name: 'fake', version: '3', license: 'x', formats: ['step'], supportsFaceIds: true, supportsEdges: false,
      supportsCurves: false },
    timeoutMs: 1234,
    memoryBytes: () => 99,
    init: async () => {},
    dispose: () => {},
    tessellate: async (req): Promise<TessellationResult> => {
      seen.push(req);
      return { origin: req.origin ?? [0, 0, 0], positions: new Float32Array(), indices: new Uint32Array(), faces: [],
        diagnostics: [{ severity: 'info', message: 'meshed' }], ...answer?.(req) };
    },
  };
  return t;
}

test('a model request: written as STEP (the same bytes as stepPartBytes), its root the representation', async () => {
  const inner = backend();
  const t = new StepTessellator(inner);
  const d = cube().finish();
  const base = { origin: [1, 2, 3] as [number, number, number], linearDeflection: 0.1, angularDeflection: 0.5,
    edges: true, measures: true };
  const r = await t.tessellate({ ...base, format: 'cad-brep', data: new Uint8Array(d.buffer) });
  const sent = inner.seen[0]!;
  const w = stepPartBytes(d);
  assert.deepEqual(sent, { ...base, format: 'step', data: w.data, rootId: w.rootId });
  assert.ok(parseStep(sent.data).index.position(w.rootId) >= 0);
  assert.deepEqual(r.diagnostics.map((x) => x.message), ['writing STEP: 12 x edge parameter ranges (not written: STEP '
    + 'has none) (#9, #10, #11, #12, #13, ...)', 'meshed']);
  // A view of a buffer at an offset works as the buffer itself.
  const inside = new Uint8Array(d.buffer.byteLength + 8);
  inside.set(new Uint8Array(d.buffer), 8);
  await t.tessellate({ ...base, format: 'cad-brep', data: inside.subarray(8) });
  assert.deepEqual(inner.seen[1]!.data, w.data);
});

test('the writer\'s diagnostics come first, said to be the writer\'s', async () => {
  const inner = backend();
  const r = await new StepTessellator(inner).tessellate({ format: 'cad-brep',
    data: new Uint8Array(spheres().finish().buffer), linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(r.diagnostics, [
    { severity: 'warning', message: 'writing STEP: a face without loops (written with none: STEP needs at least one)' },
    { severity: 'info', message: 'meshed' }]);
});

test('other formats pass through; its info names the writer and takes models (unless the backend does); the rest '
  + 'is the backend\'s', async () => {
  const inner = backend();
  const t = new StepTessellator(inner);
  const req: TessellationRequest = { format: 'step', data: new Uint8Array([1, 2]), rootId: 5, linearDeflection: 1,
    angularDeflection: 1 };
  await t.tessellate(req);
  assert.equal(inner.seen[0], req);
  assert.deepEqual(t.info, { ...inner.info, version: `3, STEP writer ${STEP_WRITER_VERSION}, adapter ${STEP_ADAPTER}`,
    formats: ['cad-brep', 'step'] });
  assert.equal(t.timeoutMs, 1234);
  assert.equal(t.memoryBytes!(), 99);
  // A backend that takes models itself gets them as they are, and its info is its own (no writer to name).
  const models = backend();
  models.info.formats = ['cad-brep', 'step'];
  const m = new StepTessellator(models);
  const d = new BrepBuilder().finish();
  const mreq: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(d.buffer), linearDeflection: 1,
    angularDeflection: 1 };
  await m.tessellate(mreq);
  assert.equal(models.seen[0], mreq);
  assert.deepEqual(m.info, models.info);
  // Without memoryBytes, none.
  const bare = backend();
  delete (bare as { memoryBytes?: unknown }).memoryBytes;
  assert.equal(new StepTessellator(bare).memoryBytes, undefined);
});

test('the writer\'s ids read back as the model\'s: none for an entity without a source id, a face\'s copy its id',
  async () => {
  const d = withoutIds().finish();
  const w = stepPartBytes(d);
  // The second square's face (10) written twice, the copy under a new id; the first square's entities have no ids.
  const copy = [...w.sourceIds].find(([, x]) => x === 10)![0];
  const text = new TextDecoder().decode(w.data);
  const unnamed = Number(/#(\d+)=ADVANCED_FACE/.exec(text)![1]);
  const beyond = Math.max(copy, unnamed) + 1000;
  assert.deepEqual([...w.sourceIds], [[copy, 10]]);
  assert.ok(copy > w.largest && unnamed > w.largest);
  const range = (entityId: number | null) => ({ entityId, start: 0, count: 0 });
  const inner = backend(() => ({
    faces: [range(10), range(copy), range(unnamed), range(beyond), range(null)],
    measures: [{ entityId: 10, area: 1, perimeter: 4, valid: true }, { entityId: copy, area: 1, perimeter: 4,
      valid: false }, { entityId: unnamed, area: 1, perimeter: 4, valid: true }],
    edges: [{ ...range(5), kind: 'free' }, { ...range(unnamed), kind: 'free' }, { ...range(null), kind: 'seam' }],
    curves: [range(unnamed), range(3)], outlines: [range(copy)], pointIds: [30, unnamed, null, beyond],
  }));
  const r = await new StepTessellator(inner).tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer),
    linearDeflection: 0.1, angularDeflection: 0.5, edges: true });
  assert.deepEqual(r.faces.map((f) => f.entityId), [10, 10, null, null, null]);
  // One measure for face 10 (the face's, not summed over its copies), sound only if both are; none without an id.
  assert.deepEqual(r.measures, [{ entityId: 10, area: 1, perimeter: 4, valid: false }]);
  assert.deepEqual(r.edges!.map((e) => [e.entityId, e.kind]), [[5, 'free'], [null, 'free'], [null, 'seam']]);
  // (An id at or below the model's largest is the model's.)
  assert.deepEqual(r.curves!.map((c) => c.entityId), [null, 3]);
  assert.deepEqual(r.outlines!.map((o) => o.entityId), [10]);
  assert.deepEqual(r.pointIds, [30, null, null, null]);
  // What the backend leaves out stays out.
  const bare = await new StepTessellator(backend()).tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer),
    linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(Object.keys(bare).filter((k) => ['edges', 'curves', 'outlines', 'pointIds', 'measures'].includes(k)),
    []);
});

test('the mesh judged for open edges by the model: edges asked of the backend always, kept only if asked for',
  async () => {
  const d = cube().finish();
  const moved = quads(d, { face: 21, corner: 0, by: [0, 0, 1e-3] });
  const inner = backend(() => moved);
  const t = new StepTessellator(inner);
  for (const edges of [false, true]) {
    const r = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer), linearDeflection: 0.1,
      angularDeflection: 0.5, edges });
    assert.equal(inner.seen.at(-1)!.edges, true);
    assert.deepEqual(r.diagnostics.filter((x) => x.severity === 'error'),
      [{ severity: 'error', message: openEdgesMessage(2) }]);
    assert.equal(r.edges !== undefined && r.edgePositions !== undefined, edges);
  }
  // Closed: no error. With measures, the area oracle's areas (none without).
  const sound = await new StepTessellator(backend(() => quads(d))).tessellate({ format: 'cad-brep',
    data: new Uint8Array(d.buffer), linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(sound.diagnostics.filter((x) => x.severity === 'error'), []);
  assert.equal(sound.oracle, undefined);
  const measured = await new StepTessellator(backend(() => quads(d))).tessellate({ format: 'cad-brep',
    data: new Uint8Array(d.buffer), linearDeflection: 0.1, angularDeflection: 0.5, measures: true });
  assert.deepEqual(measured.oracle, oracleMeasures(d));
  assert.equal(measured.oracle!.length, 6);
});

test('an entity whose source id another has: written under a new id, read back as its own', async () => {
  // Two faces with id 7 (a model from a source whose ids aren't unique): the second written under a new id.
  const b = new BrepBuilder();
  for (const z of [0, 1]) {
    const corners = [[0, 0, z], [1, 0, z], [1, 1, z], [0, 1, z]];
    const vs = corners.map((point) => b.addVertex({ point }));
    const coedges = corners.map((p, k) => ({ edge: b.addEdge({ curve: b.addCurve({ kind: 'line', point: p,
      direction: corners[(k + 1) % 4]!.map((x, j) => x - p[j]!), magnitude: 1 }), start: vs[k]!, end: vs[(k + 1) % 4]!,
    sameSense: true }), orientation: 'forward' as const }));
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: { origin: [0, 0, z], axis: [0, 0, 1],
      xDir: [1, 0, 0] } }), sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }], id: 7 });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
      faces: [{ face, sense: true }] }), sense: true }] }) });
  }
  const d = b.finish();
  const w = stepPartBytes(d);
  const faces = [...new TextDecoder().decode(w.data).matchAll(/#(\d+)=ADVANCED_FACE/g)].map((m) => Number(m[1]));
  assert.equal(faces.length, 2);
  assert.equal(faces[0], 7);
  assert.deepEqual([...w.sourceIds], [[faces[1], 7]]);
  const inner = backend(() => ({ faces: faces.map((entityId) => ({ entityId, start: 0, count: 0 })) }));
  const r = await new StepTessellator(inner).tessellate({ format: 'cad-brep', data: new Uint8Array(d.buffer),
    linearDeflection: 0.1, angularDeflection: 0.5 });
  assert.deepEqual(r.faces.map((f) => f.entityId), [7, 7]);
});
