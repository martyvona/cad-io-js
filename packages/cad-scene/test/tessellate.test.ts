import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tessellateScene, type Scene, type TessellationRequest, type TessellationResult, type Tessellator } from '../src/index.ts';

// Five brep parts (inches for part 3) and a mesh part; the fake backend takes longer for earlier parts, so they
// finish in reverse order, and fails part 2.
function scene(): Scene {
  const brep = (i: number) => ({
    kind: 'brep' as const, format: 'step' as const, payload: () => new Uint8Array([i]), rootId: 100 + i,
    name: `p${i}`, sources: [{ format: 'step', id: 100 + i }], properties: {}, unit: i === 3 ? 25.4 : 1, origin: [i, 0, 0] as [number, number, number],
  });
  return {
    unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [], properties: {}, diagnostics: [],
    parts: [brep(0), brep(1), brep(2), { kind: 'mesh', name: 'm', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] }, brep(3), brep(4)],
  };
}

function fake() {
  const seen: TessellationRequest[] = [];
  let inFlight = 0;
  const t = {
    peak: 0, seen,
    info: { name: 'fake', version: '1', license: 'x', formats: ['step' as const], supportsFaceIds: true, supportsEdges: false },
    async init() {},
    dispose() {},
    async tessellate(req: TessellationRequest): Promise<TessellationResult> {
      seen.push(req);
      t.peak = Math.max(t.peak, ++inFlight);
      const i = req.data[0]!;
      await new Promise((r) => setTimeout(r, (5 - i) * 15));
      inFlight--;
      if (i === 2) throw new Error('boom');
      return { origin: req.origin!, positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), faces: [], diagnostics: [{ severity: 'info', message: `part ${i}` }] };
    },
  };
  return t satisfies Tessellator;
}

for (const concurrency of [1, 3]) {
  test(`tessellateScene, concurrency ${concurrency}: requests per brep part, results in part order`, async () => {
    const t = fake();
    const finished: number[] = [];
    const r = await tessellateScene(scene(), t, { linearDeflection: 0.254, angularDeflection: 0.5, concurrency, onPart: (i, _m, done, total) => { finished.push(i); assert.equal(total, 5); assert.equal(done, finished.length); } });
    assert.equal(t.peak, concurrency);
    assert.deepEqual([...r.meshes.keys()], [0, 1, 4, 5]);
    assert.deepEqual(r.meshes.get(4)!.origin, [3, 0, 0]);
    assert.deepEqual(t.seen.map((q) => [q.rootId, q.linearDeflection]).sort(), [[100, 0.254], [101, 0.254], [102, 0.254], [103, 0.01], [104, 0.254]]);
    assert.deepEqual(r.diagnostics.map((d) => [d.message, d.source?.id]), [['part 0', 100], ['part 1', 101], ['tessellation failed: boom', 102], ['part 3', 103], ['part 4', 104]]);
    if (concurrency > 1) assert.notDeepEqual(finished, [0, 1, 2, 4, 5]);
  });
}
