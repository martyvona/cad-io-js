import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tessellateScene, type Scene, type TessellationRequest, type TessellationResult,
  type Tessellator } from '../src/index.ts';

// Five brep parts (inches for part 3) and a mesh part; the fake backend takes longer for earlier parts, so they
// finish in reverse order, and fails part 2.
function scene(): Scene {
  const brep = (i: number) => ({
    brep: { format: 'step' as const, payload: () => new Uint8Array([i]), rootId: 100 + i }, lods: [],
    name: `p${i}`, sources: [{ format: 'step', id: 100 + i }], properties: {}, unit: i === 3 ? 25.4 : 1,
    origin: [i, 0, 0] as [number, number, number],
  });
  return {
    unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [], properties: {},
    diagnostics: [],
    parts: [brep(0), brep(1), brep(2),
      { name: 'm', sources: [], properties: {}, unit: 1, origin: [0, 0, 0], lods: [] }, brep(3), brep(4)],
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
    const p = s.parts[i]!;
    // Faces 10, 11, 12 of each brep part; an outline of 2 points for each face asked for.
    p.brep!.outline = ({ faces, linearDeflection }) => {
      const want = [10, 11, 12].filter((f) => !faces || faces.has(f));
      asked.push({ part: i, faces: want, linearDeflection });
      return { faces: [10, 11, 12], positions: Float32Array.from(want.flatMap((f) => [f, 0, 0, f, 1, 0])),
        outlines: want.map((f, k) => ({ source: f, start: 2 * k, count: 2 })) };
    };
  }
  const t = fake();
  const tessellate = t.tessellate.bind(t);
  // Face 10 meshed, 11 a range of none, 12 left out; part 0 all three meshed (11 split, one piece empty).
  t.tessellate = async (req) => {
    const r = await tessellate(req);
    r.faces = [{ entityId: 10, start: 0, count: 3 }, { entityId: 11, start: 3, count: 0 }];
    // (Part 0: a triangle of area 0.5 a face, face 11's second piece empty; no measures.)
    if (req.data[0] === 0) {
      r.indices = Uint32Array.of(0, 1, 2, 0, 1, 2, 0, 1, 2);
      r.faces = [{ entityId: 10, start: 0, count: 3 }, { entityId: 11, start: 3, count: 3 },
        { entityId: 11, start: 6, count: 0 }, { entityId: 12, start: 6, count: 3 }];
    }
    // The backend's outlines: part 0's empty piece (dropped: the face meshed), part 1's face 11 (used instead of the
    // source's).
    if (req.data[0] === 0 || req.data[0] === 1) {
      r.outlinePositions = Float32Array.of(7, 7, 7, 8, 8, 8);
      r.outlines = [{ entityId: 11, start: 0, count: 2 }];
    }
    return r;
  };
  const r = await tessellateScene(s, t, { linearDeflection: 0.2, angularDeflection: 0.5, outlines: true });
  // Part 0: nothing failed (without measures, a face with triangles is whole), as it was.
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
  delete s.parts[2]!.brep!.outline;
  assert.ok(!(await tessellateScene(s, fake(), { outlines: true })).meshes.has(2));
});

test('tessellateScene measures: asked for and kept per part (who measured), not asked again; failures judged by them',
  async () => {
  // Part 0's faces: 10 a unit square (area 1, meshed whole), 11 the same square measured at 2 (half missing), 12
  // measured but not meshed, 13 invalid (unverified). The backend outlines 11 (its own edges), which a face that
  // failed only partly doesn't use: the source's whole outline instead.
  const s = scene();
  s.parts = [s.parts[0]!, s.parts[1]!];
  const asked: boolean[] = [];
  for (const p of s.parts) p.brep!.outline = ({ faces }) => {
    const want = [10, 11, 12, 13].filter((f) => !faces || faces.has(f));
    return { faces: [10, 11, 12, 13], positions: Float32Array.from(want.flatMap((f) => [f, 0, 0, f, 1, 0])),
      outlines: want.map((f, k) => ({ source: f, start: 2 * k, count: 2 })) };
  };
  const t = fake();
  t.tessellate = async (req) => {
    asked.push(!!req.measures);
    return { origin: req.origin!, positions: Float32Array.of(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0),
      indices: Uint32Array.of(0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3, 0, 1, 2, 0, 2, 3),
      faces: [{ entityId: 10, start: 0, count: 6 }, { entityId: 11, start: 6, count: 6 },
        { entityId: 13, start: 12, count: 6 }],
      outlinePositions: Float32Array.of(7, 7, 7, 8, 8, 8), outlines: [{ entityId: 11, start: 0, count: 2 }],
      diagnostics: [], ...(req.measures ? { measures: [{ entityId: 10, area: 1, perimeter: 4, valid: true },
        { entityId: 11, area: 2, perimeter: 6, valid: true }, { entityId: 12, area: 1, perimeter: 4, valid: true },
        { entityId: 13, area: 1, perimeter: 4, valid: false }] } : {}) };
  };
  // Part 1 has measures already (read from a file, say): not asked for, kept.
  const theirs = { by: 'source', faces: new Map([[10, { area: 1, perimeter: 4, valid: true }]]) };
  s.parts[1]!.measures = theirs;
  const r = await tessellateScene(s, t, { linearDeflection: 0.01, angularDeflection: 0.5, outlines: true });
  assert.deepEqual(asked, [true, false]);
  assert.equal(s.parts[0]!.measures!.by, 'fake 1');
  assert.deepEqual([...s.parts[0]!.measures!.faces.keys()], [10, 11, 12, 13]);
  assert.equal(s.parts[1]!.measures, theirs);
  // 11 partly (whole outline from the source, not the backend's), 12 failed (the source's), 13 unverified.
  const m = r.meshes.get(0)!;
  assert.deepEqual(m.faceOutlines!.map((o) => o.source).sort(), [11, 12, 13]);
  assert.ok(!Array.from(m.faceOutlinePositions!).includes(7), 'the backend\'s outline of a partly failed face');
  assert.deepEqual(m.faces.map((f) => [f.source, f.count]), [[10, 6], [11, 6], [13, 6], [12, 0]]);
  // Part 1 judged by its own measures: only face 10 measured, meshed whole; the rest by the no-triangles rule.
  assert.equal(r.meshes.get(1)!.faceOutlines!.map((o) => o.source).join(), '12');
  // Off: not asked for.
  asked.length = 0;
  const plain = scene();
  plain.parts = [plain.parts[0]!];
  await tessellateScene(plain, t, { linearDeflection: 0.01, measures: false });
  assert.deepEqual(asked, [false]);
  assert.equal(plain.parts[0]!.measures, undefined);
});
