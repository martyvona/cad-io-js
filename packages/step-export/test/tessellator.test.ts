// StepTessellator: B-rep model requests written as STEP for a backend that reads STEP; others passed on as they are.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder } from 'cad-brep';
import type { TessellationRequest, TessellationResult, Tessellator } from 'cad-scene';
import { parseStep } from 'step-parser';
import { cube, spheres } from '../../cad-brep/test/models.ts';
import { STEP_WRITER_VERSION, StepTessellator, stepPartBytes } from '../src/index.ts';

/** A STEP backend that keeps what it was sent. */
function backend() {
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
        diagnostics: [{ severity: 'info', message: 'meshed' }] };
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

test('other formats pass through; its info names the writer and takes models; the rest is the backend\'s', async () => {
  const inner = backend();
  const t = new StepTessellator(inner);
  const req: TessellationRequest = { format: 'step', data: new Uint8Array([1, 2]), rootId: 5, linearDeflection: 1,
    angularDeflection: 1 };
  await t.tessellate(req);
  assert.equal(inner.seen[0], req);
  assert.deepEqual(t.info, { ...inner.info, version: `3, STEP writer ${STEP_WRITER_VERSION}`,
    formats: ['cad-brep', 'step'] });
  assert.equal(t.timeoutMs, 1234);
  assert.equal(t.memoryBytes!(), 99);
  // A backend that takes models itself gets them as they are.
  const models = backend();
  models.info.formats = ['cad-brep', 'step'];
  const m = new StepTessellator(models);
  const d = new BrepBuilder({ unit: 1 }).finish();
  const mreq: TessellationRequest = { format: 'cad-brep', data: new Uint8Array(d.buffer), linearDeflection: 1,
    angularDeflection: 1 };
  await m.tessellate(mreq);
  assert.equal(models.seen[0], mreq);
  assert.deepEqual(m.info.formats, ['cad-brep', 'step']);
  // Without memoryBytes, none.
  const bare = backend();
  delete (bare as { memoryBytes?: unknown }).memoryBytes;
  assert.equal(new StepTessellator(bare).memoryBytes, undefined);
});
