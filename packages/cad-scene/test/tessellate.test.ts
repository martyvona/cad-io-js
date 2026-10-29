import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tessellateScene, type Scene, type TessellationRequest, type TessellationResult,
  type Tessellator } from '../src/index.ts';

// Five brep parts (inches for part 3) and a mesh part; the fake backend takes longer for earlier parts, so they
// finish in reverse order, and fails part 2.
function scene(): Scene {
  const brep = (i: number) => ({
    kind: 'brep' as const, format: 'step' as const, payload: () => new Uint8Array([i]), rootId: 100 + i,
    name: `p${i}`, sources: [{ format: 'step', id: 100 + i }], properties: {}, unit: i === 3 ? 25.4 : 1,
    origin: [i, 0, 0] as [number, number, number],
  });
  return {
    unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [], properties: {},
    diagnostics: [],
    parts: [brep(0), brep(1), brep(2),
      { kind: 'mesh', name: 'm', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] }, brep(3), brep(4)],
  };
}

function fake() {
  const seen: TessellationRequest[] = [];
  let inFlight = 0;
  const t = {
    peak: 0, seen,
    info: { name: 'fake', version: '1', license: 'x', formats: ['step' as const], supportsFaceIds: true,
      supportsEdges: false, supportsCurves: false },
    async init() {},
    dispose() {},
    async tessellate(req: TessellationRequest): Promise<TessellationResult> {
      seen.push(req);
      t.peak = Math.max(t.peak, ++inFlight);
      const i = req.data[0]!;
      await new Promise((r) => setTimeout(r, (5 - i) * 15));
      inFlight--;
      if (i === 2) throw new Error('boom');
      return { origin: req.origin!, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        indices: new Uint32Array([0, 1, 2]), faces: [], diagnostics: [{ severity: 'info', message: `part ${i}` }] };
    },
  };
  return t satisfies Tessellator;
}

for (const concurrency of [1, 3]) {
  test(`tessellateScene, concurrency ${concurrency}: requests per brep part, results in part order`, async () => {
    const t = fake();
    const finished: number[] = [];
    const r = await tessellateScene(scene(), t,
      { linearDeflection: 0.254, angularDeflection: 0.5, concurrency,
      onPart: (i, _m, done, total) => { finished.push(i); assert.equal(total, 5);
      assert.equal(done, finished.length); } });
    assert.equal(t.peak, concurrency);
    assert.deepEqual([...r.meshes.keys()], [0, 1, 4, 5]);
    assert.deepEqual(r.meshes.get(4)!.origin, [3, 0, 0]);
    assert.deepEqual(t.seen.map((q) => [q.rootId, q.linearDeflection]).sort(),
      [[100, 0.254], [101, 0.254], [102, 0.254], [103, 0.01], [104, 0.254]]);
    assert.deepEqual(r.diagnostics.map((d) => [d.message, d.source?.id]),
      [['part 0', 100], ['part 1', 101], ['tessellation failed: boom', 102], ['part 3', 103], ['part 4', 104]]);
    if (concurrency > 1) assert.notDeepEqual(finished, [0, 1, 2, 4, 5]);
  });
}

test('tessellateScene keeps results with only curves or only points, with their sources, and drops empty ones',
  async () => {
  const t = fake();
  t.tessellate = async (req: TessellationRequest): Promise<TessellationResult> => {
    const r: TessellationResult = { origin: req.origin!, positions: new Float32Array(), indices: new Uint32Array(),
      faces: [], diagnostics: [] };
    const i = req.data[0]!;
    if (i === 0) Object.assign(r,
      { curvePositions: new Float32Array([0, 0, 0, 1, 0, 0]), curves: [{ entityId: 7, start: 0, count: 2 }] });
    if (i === 1) Object.assign(r, { points: new Float32Array([1, 2, 3, 4, 5, 6]), pointIds: [8, null] });
    return r;
  };
  const r = await tessellateScene(scene(), t, { linearDeflection: 1, angularDeflection: 0.5, parts: [0, 1, 2] });
  assert.deepEqual([...r.meshes.keys()], [0, 1]);
  const [a, b] = [r.meshes.get(0)!, r.meshes.get(1)!];
  assert.deepEqual([a.curvePositions, a.curves, a.points],
    [new Float32Array([0, 0, 0, 1, 0, 0]), [{ source: 7, start: 0, count: 2 }], undefined]);
  assert.deepEqual([b.points, b.pointSources, b.curves], [new Float32Array([1, 2, 3, 4, 5, 6]), [8, null], undefined]);
});

test('tessellateScene: the meshing profile (default medium), its values replaced by any deflection given', async () => {
  const requests = async (opts: Parameters<typeof tessellateScene>[2]) => {
    const t = fake();
    await tessellateScene(scene(), t, opts);
    // Part 3 is in inches: its distance is converted, its angle not.
    const p3 = t.seen.find((q) => q.rootId === 103)!;
    return [p3.linearDeflection * 25.4, p3.angularDeflection];
  };
  const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 1e-12);
  assert.ok(near(await requests(undefined), [0.1, Math.PI / 12]), 'default: medium');
  assert.ok(near(await requests({ profile: 'coarse' }), [0.2, Math.PI / 6]), 'coarse');
  assert.ok(near(await requests({ profile: 'fine' }), [0.05, Math.PI / 24]), 'fine');
  assert.ok(near(await requests({ profile: 'fine', linearDeflection: 0.03 }), [0.03, Math.PI / 24]), 'distance');
  assert.ok(near(await requests({ angularDeflection: 0.5 }), [0.1, 0.5]), 'angle');
});

test('tessellateScene outlines: faces with no triangles or no range outlined; a failed part all outlines', async () => {
  const s = scene();
  const asked: { part: number; faces: number[]; linearDeflection: number }[] = [];
  for (const i of [0, 1, 2, 4]) {
    const p = s.parts[i] as Extract<Scene['parts'][number], { kind: 'brep' }>;
    // Faces 10, 11, 12 of each brep part; an outline of 2 points for each face asked for.
    p.outline = ({ faces, linearDeflection }) => {
      const want = [10, 11, 12].filter((f) => !faces || faces.has(f));
      asked.push({ part: i, faces: want, linearDeflection });
      return { faces: [10, 11, 12], positions: Float32Array.from(want.flatMap((f) => [f, 0, 0, f, 1, 0])),
        outlines: want.map((f, k) => ({ source: f, start: 2 * k, count: 2 })) };
    };
  }
  const t = fake();
  const tessellate = t.tessellate.bind(t);
  // Face 10 meshed, 11 a range of none, 12 left out; part 0 all three meshed (11 split, one piece a sliver).
  t.tessellate = async (req) => {
    const r = await tessellate(req);
    r.faces = [{ entityId: 10, start: 0, count: 3 }, { entityId: 11, start: 3, count: 0 }];
    // (Part 0: a triangle of area 0.5 a face; face 11's empty piece a sliver of 0.001.)
    if (req.data[0] === 0) {
      r.indices = Uint32Array.of(0, 1, 2, 0, 1, 2, 0, 1, 2);
      r.faces = [{ entityId: 10, start: 0, count: 3 }, { entityId: 11, start: 3, count: 3 },
        { entityId: 11, start: 6, count: 0, area: 0.001 }, { entityId: 12, start: 6, count: 3 }];
    }
    // The backend's outlines: part 0's sliver (dropped), part 1's face 11 (used instead of the source's).
    if (req.data[0] === 0 || req.data[0] === 1) {
      r.outlinePositions = Float32Array.of(7, 7, 7, 8, 8, 8);
      r.outlines = [{ entityId: 11, start: 0, count: 2 }];
    }
    return r;
  };
  const r = await tessellateScene(s, t, { linearDeflection: 0.2, angularDeflection: 0.5, outlines: true });
  // Part 0: nothing failed (11's empty piece a sliver), as it was.
  assert.equal(r.meshes.get(0)!.faceOutlines, undefined);
  assert.equal(r.meshes.get(0)!.faceOutlinePositions, undefined);
  // Part 1: 11 and 12 outlined (11 by the backend); 12 given a range of none at the end.
  const m1 = r.meshes.get(1)!;
  assert.deepEqual(m1.faceOutlines!.map((o) => o.source), [11, 12]);
  // 11's the backend's polyline, 12's the source's after it.
  assert.deepEqual(Array.from(m1.faceOutlinePositions!), [7, 7, 7, 8, 8, 8, 12, 0, 0, 12, 1, 0]);
  assert.deepEqual(m1.faceOutlines!.map((o) => [o.start, o.count]), [[0, 2], [2, 2]]);
  assert.deepEqual(m1.faces.map((f) => [f.source, f.count]), [[10, 3], [11, 0], [12, 0]]);
  assert.equal(m1.faces[2]!.start, m1.indices.length);
  // Part 2 failed: a mesh of its faces, no triangles, all outlined; the error still said.
  const m2 = r.meshes.get(2)!;
  assert.deepEqual([m2.indices.length, m2.faces.map((f) => [f.source, f.count])], [0, [[10, 0], [11, 0], [12, 0]]]);
  assert.deepEqual(m2.faceOutlines!.map((o) => o.source), [10, 11, 12]);
  assert.deepEqual(m2.origin, [2, 0, 0]);
  assert.ok(r.diagnostics.some((d) => d.severity === 'error' && /boom/.test(d.message)));
  // In the part's units, as the backend's request (scene part 4 is in inches).
  assert.ok(asked.every((a) => a.linearDeflection === (a.part === 4 ? 0.2 / 25.4 : 0.2)), JSON.stringify(asked));
  // Off by default: no outlines, failed parts absent.
  const plain = await tessellateScene(s, fake(), { linearDeflection: 0.2 });
  assert.ok(!plain.meshes.has(2) && [...plain.meshes.values()].every((m) => !m.faceOutlines));
  // A part that can't outline: as before.
  delete (s.parts[2] as { outline?: unknown }).outline;
  assert.ok(!(await tessellateScene(s, fake(), { outlines: true })).meshes.has(2));
});
