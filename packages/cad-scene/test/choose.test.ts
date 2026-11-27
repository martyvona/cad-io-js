// The choice of each face's mesh by a target (docs/triage.md, "Choosing a mesh"): FallbackTessellator's per-face
// choice with TessellationRequest.target, and tessellateScene's `target` (its limits asked, faces in error withheld,
// the level keyed by the target).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cube } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { chooseLod, FallbackTessellator, oracleMeasures, type Scene, tessellateScene, TARGETS,
  type TessellationRequest, type TessellationResult, type Tessellator } from '../src/index.ts';

const model = cube().finish();
const FACES = [21, 22, 23, 24, 25, 26];

/** The cube's sound result: each face 2 triangles, measured at its true area. */
function sound(): TessellationResult {
  return { ...quads(model), measures: FACES.map((entityId) => ({ entityId, area: 1, perimeter: 4, valid: true })),
    oracle: oracleMeasures(model) };
}

const without = (r: TessellationResult, id: number): TessellationResult => ({ ...r, faces: r.faces.map((f) =>
  (f.entityId === id ? { ...f, count: 0 } : f)) });

/** `r` with a degenerate triangle (two corners one vertex) added to face `id`: (l), a warning under every target. */
function degenerate(r: TessellationResult, id: number): TessellationResult {
  const indices: number[] = [];
  const faces = r.faces.map((f) => {
    const start = indices.length;
    indices.push(...r.indices.subarray(f.start, f.start + f.count));
    if (f.entityId === id) indices.push(r.indices[f.start]!, r.indices[f.start]!, r.indices[f.start + 1]!);
    return { ...f, start, count: indices.length - start };
  });
  return { ...r, indices: Uint32Array.from(indices), faces };
}

/** `r` moved along x by `dx`, its edges too: sound in itself, its faces meeting no other result's. */
function moved(r: TessellationResult, dx: number): TessellationResult {
  const shift = (p: Float32Array) => p.map((x, i) => (i % 3 === 0 ? x + dx : x));
  return { ...r, positions: shift(r.positions), edgePositions: shift(r.edgePositions!) };
}

/** A fake backend answering every request with `answer` (or throwing it), recording the requests. */
function fake(name: string, answer: () => TessellationResult | Error) {
  const seen: TessellationRequest[] = [];
  const t: Tessellator & { seen: TessellationRequest[] } = {
    seen,
    info: { name, version: '1', license: 'A', formats: ['cad-brep'], supportsFaceIds: true, supportsEdges: true,
      supportsCurves: true },
    init: async () => {},
    tessellate: async (req) => {
      seen.push(req);
      const r = answer();
      if (r instanceof Error) throw r;
      return r;
    },
    dispose: () => {},
  };
  return t;
}

const request = (extra: Partial<TessellationRequest> = {}): TessellationRequest => ({ format: 'cad-brep',
  data: new Uint8Array(model.buffer), linearDeflection: 0.01, angularDeflection: 0.5,
  target: TARGETS.rendering, ...extra });

async function both(a: () => TessellationResult | Error, b: () => TessellationResult | Error) {
  const pa = fake('a', a), pb = fake('b', b);
  const t = new FallbackTessellator(pa, pb);
  await t.init();
  return { t, pa, pb };
}

test('by target: a part passing is the primary\'s, the fallback not asked; records asked for and kept', async () => {
  const { t, pa, pb } = await both(sound, sound);
  const r = await t.tessellate(request());
  assert.equal(pb.seen.length, 0);
  assert.equal(pa.seen[0]!.records, true);
  assert.equal(r.backend, 'a 1');
  assert.deepEqual([...r.records!.entityId], FACES);
  assert.deepEqual(r.diagnostics, []);
});

test('by target: a face in error the fallback\'s where it passes there, the rest the primary\'s, said', async () => {
  const { t, pb } = await both(() => without(sound(), 23), sound);
  const r = await t.tessellate(request());
  assert.equal(pb.seen.length, 1);
  assert.equal(r.backend, 'a 1, with 1 face by b 1');
  assert.deepEqual(r.diagnostics.map((d) => d.message), ['1 face meshed by the fallback backend (b) under the '
    + 'rendering target, since a\'s mesh had problems: 1 face in error under the rendering target: #23']);
  const n = sound().positions.length / 3;
  for (const f of r.faces) {
    const vs = [...r.indices.subarray(f.start, f.start + f.count)];
    assert.ok(vs.length && vs.every((v) => (f.entityId === 23 ? v >= n : v < n)), `face ${f.entityId}`);
  }
  assert.ok(r.records!.triangles.every((x) => x > 0));
});

test('by target: warnings send the part to the fallback only where the target asks on them (analysis); a passing '
  + 'face of it taken over a warned one', async () => {
  for (const target of [TARGETS.rendering, TARGETS.manufacturing, TARGETS.analysis]) {
    const { t, pb } = await both(() => degenerate(sound(), 22), sound);
    const r = await t.tessellate(request({ target }));
    assert.equal(pb.seen.length, target.name === 'analysis' ? 1 : 0, target.name);
    assert.equal(r.backend, target.name === 'analysis' ? 'a 1, with 1 face by b 1' : 'a 1', target.name);
  }
});

test('by target: once asked, only the faces the target wants replaced taken: one in error under every target, one '
  + 'warned of only under analysis', async () => {
  for (const target of [TARGETS.rendering, TARGETS.manufacturing, TARGETS.analysis]) {
    const { t } = await both(() => degenerate(without(sound(), 23), 22), sound);
    const r = await t.tessellate(request({ target }));
    const n = target.name === 'analysis' ? 2 : 1;
    assert.equal(r.backend, `a 1, with ${n} face${n > 1 ? 's' : ''} by b 1`, target.name);
    assert.match(r.diagnostics[0]!.message, n > 1 ? /: #22, #23$/ : /: #23$/, target.name);
  }
});

test('by target: both warned, the better by criteria, the primary\'s on a tie (said in a note)', async () => {
  // (Two degenerate triangles against one: l's count.)
  const { t } = await both(() => degenerate(degenerate(sound(), 22), 22), () => degenerate(sound(), 22));
  const r = await t.tessellate(request({ target: TARGETS.analysis }));
  assert.equal(r.backend, 'a 1, with 1 face by b 1');
  const tie = await both(() => degenerate(sound(), 22), () => degenerate(sound(), 22));
  const s = await tie.t.tessellate(request({ target: TARGETS.analysis }));
  assert.equal(s.backend, 'a 1');
  assert.match(s.diagnostics[0]!.message, /^the fallback backend \(b\) did no better than a under the analysis /);
});

test('by target: both in error, the primary\'s kept (tessellateScene withholds it); a failed part the fallback\'s '
  + 'whole; the fallback failing too, the primary\'s', async () => {
  const e = await both(() => without(sound(), 23), () => without(sound(), 23));
  assert.equal((await e.t.tessellate(request())).backend, 'a 1');
  const failed = (): TessellationResult => ({ origin: [0, 0, 0], positions: new Float32Array(),
    indices: new Uint32Array(), faces: [], diagnostics: [{ severity: 'error', message: 'it broke' }] });
  const f = await both(failed, sound);
  const r = await f.t.tessellate(request());
  assert.equal(r.backend, 'b 1');
  assert.match(r.diagnostics[0]!.message, /^meshed by the fallback backend \(b\), since a's mesh had problems: no /);
  const thrown = await both(() => new Error('timeout'), sound);
  assert.equal((await thrown.t.tessellate(request())).backend, 'b 1');
  // (Both threw: a failed part with both errors, not an exception; the primary threw and the fallback has no
  // triangles: the fallback's result, its errors with it.)
  const none = await both(() => new Error('timeout'), () => new Error('also'));
  assert.deepEqual((await none.t.tessellate(request())).diagnostics.map((d) => d.message), ['tessellation failed: '
    + 'timeout', 'the fallback backend (b) failed too: also']);
  const empty = await both(() => new Error('timeout'), failed);
  const e2 = await empty.t.tessellate(request());
  assert.equal(e2.backend, 'b 1');
  assert.deepEqual(e2.diagnostics.map((d) => d.message), ['meshed by the fallback backend (b), since a\'s mesh had '
    + 'problems: failed: timeout', 'it broke']);
  const neither = await both(failed, () => new Error('also'));
  assert.deepEqual((await neither.t.tessellate(request())).diagnostics.map((d) => d.message), ['it broke']);
});

test('by target: a face taken that the join leaves unsewn put back where that\'s an error (manufacturing), kept '
  + 'where a warning (rendering)', async () => {
  // (The fallback's mesh sound in itself, but moved: its face 23 meets none of the primary's.)
  const m = await both(() => without(sound(), 23), () => moved(sound(), 0.3));
  const r = await m.t.tessellate(request({ target: TARGETS.manufacturing }));
  assert.equal(r.backend, 'a 1');
  assert.equal(r.faces.find((f) => f.entityId === 23)!.count, 0);
  const g = await both(() => without(sound(), 23), () => moved(sound(), 0.3));
  assert.equal((await g.t.tessellate(request())).backend, 'a 1, with 1 face by b 1');
});

/**
 * `r` with face `id`'s quad (its corners in loop order) as an nu x nv grid: 2 nu nv triangles, its boundary's
 * 2 (nu + nv) edges unsewn to its neighbours' quads (a warning under rendering).
 */
function grid(r: TessellationResult, id: number, nu: number, nv: number): TessellationResult {
  const f = r.faces.find((x) => x.entityId === id)!;
  const c = [0, 1, 2, 3].map((k) => [...r.positions.subarray(3 * (r.indices[f.start]! + k),
    3 * (r.indices[f.start]! + k) + 3)]);
  const base = r.positions.length / 3, pos: number[] = [...r.positions], tri: number[] = [];
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv;
    for (let q = 0; q < 3; q++) pos.push((1 - u) * (1 - v) * c[0]![q]! + u * (1 - v) * c[1]![q]! + u * v * c[2]![q]!
      + (1 - u) * v * c[3]![q]!);
  }
  const at = (i: number, j: number) => base + j * (nu + 1) + i;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    tri.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
  }
  const indices: number[] = [];
  const faces = r.faces.map((x) => {
    const start = indices.length;
    for (const v of x.entityId === id ? tri : r.indices.subarray(x.start, x.start + x.count)) indices.push(v);
    return { ...x, start, count: indices.length - start };
  });
  return { ...r, positions: Float32Array.from(pos), indices: Uint32Array.from(indices), faces };
}

test('by target: each side\'s (h) the other\'s backend cap where it has one: a face past its limit in error once '
  + 'the fallback\'s count is shared, the fallback\'s taken', async () => {
  // Face 21 both sides' grids, warned of for their unsewn boundaries (a): the primary's 320 x 320 (204,800
  // triangles, 1,280 unsewn), the fallback's 200 x 503 (201,200, 1,406). The fallback reports its cap's count, as
  // tess-cadio does: 3,157, so (h)'s limit is 64 x 3,157 = 202,048 on both once shared.
  const capped = (): TessellationResult => ({ ...grid(sound(), 21, 200, 503), reported: FACES.map((entityId) => ({
    entityId, deviationCheck: 3, deviation: NaN, normalCheck: 3, normalAngle: NaN, expected: 3157 })) });
  const { t } = await both(() => without(grid(sound(), 21, 320, 320), 23), capped);
  assert.equal((await t.tessellate(request())).backend, 'a 1, with 2 faces by b 1');
  // (Without a count, the primary's face 21 unverified by (h) between the floor and the ceiling, and the better by
  // (a): kept.)
  const plain = await both(() => without(grid(sound(), 21, 320, 320), 23), () => grid(sound(), 21, 200, 503));
  assert.equal((await plain.t.tessellate(request())).backend, 'a 1, with 1 face by b 1');
});

test('by target: without one, today\'s rules (no records asked)', async () => {
  const { t, pa } = await both(() => without(sound(), 23), sound);
  const r = await t.tessellate(request({ target: undefined }));
  assert.equal(pa.seen[0]!.records, undefined);
  assert.equal(r.records, undefined);
  assert.equal(r.backend, 'a 1, with 1 face by b 1');
});

const scene = (): Scene => ({ roots: [], parts: [{ name: 'cube', sources: [{ id: 7 }], origin: [0, 0, 0], lods: [],
  brep: { model, format: 'cad-brep' } }], diagnostics: [], materials: [] } as unknown as Scene);

test('tessellateScene\'s target: its limits in each request, faces in error withheld with an error, warnings '
  + 'counted, the level keyed by the target', async () => {
  const b = fake('a', () => degenerate(without(sound(), 23), 22));
  const s = scene();
  const out = await tessellateScene(s, b, { target: 'analysis', linearDeflection: 0.01, angularDeflection: 0.5 });
  const req = b.seen[0]!;
  assert.equal(req.minAngle, TARGETS.analysis.meshing.minAngle);
  assert.equal(req.maxEdge, 0.05);
  assert.equal(req.elementaryStretchCap, 16);
  assert.equal(req.target, TARGETS.analysis);
  assert.equal(req.records, true);
  const lod = s.parts[0]!.lods[0]!;
  assert.equal(lod.target, 'analysis');
  assert.deepEqual(lod.withheld, [23]);
  const errors = out.diagnostics.filter((d) => d.severity === 'error' && /withheld/.test(d.message));
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /^1 face withheld, in error under the analysis target \(k 1, b 1\): #23$/);
  assert.deepEqual(errors[0]!.source, { id: 7 });
  assert.ok(out.diagnostics.some((d) => d.severity === 'warning' && /faces? warned of under the analysis target \(.*l 1/
    .test(d.message)));
  // (Face 22's degenerate triangle dropped by tessellateScene after: 2 a face.)
  assert.equal(lod.mesh.indices.length / 3, 10);
  // A minAngle given: its own; another target: its own level beside it; chooseLod by target.
  const c = fake('a', () => degenerate(sound(), 22));
  await tessellateScene(s, c, { target: 'rendering', minAngle: 0.1, linearDeflection: 0.01, angularDeflection: 0.5 });
  assert.equal(c.seen[0]!.minAngle, 0.1);
  assert.equal(c.seen[0]!.maxEdge, undefined);
  assert.equal(c.seen[0]!.elementaryStretchCap, undefined);
  assert.deepEqual(s.parts[0]!.lods.map((l) => l.target), ['analysis', 'rendering']);
  const want = { linearDeflection: 0.01, angularDeflection: 0.5 };
  assert.equal(chooseLod(s.parts[0]!, { ...want, minAngle: 0.1, target: 'rendering' })!.target, 'rendering');
  assert.equal(chooseLod(s.parts[0]!, { ...want, minAngle: TARGETS.analysis.meshing.minAngle, target: 'analysis' })!
    .target, 'analysis');
  // Two targets at one minAngle: a level each, each chosen by its target.
  const two = scene();
  for (const target of ['rendering', 'manufacturing'] as const) {
    await tessellateScene(two, fake('a', sound), { target, minAngle: 0.1, ...want });
  }
  assert.deepEqual(two.parts[0]!.lods.map((l) => l.target), ['rendering', 'manufacturing']);
  for (const target of ['rendering', 'manufacturing']) {
    assert.equal(chooseLod(two.parts[0]!, { ...want, minAngle: 0.1, target })!.target, target);
  }
  // A face with triangles in error (meshed at twice its area, past rendering's 25 %): its triangles left out.
  const over = scene();
  await tessellateScene(over, fake('a', () => ({ ...sound(), oracle: sound().oracle!.map((o) => (o.entityId === 24
    ? { ...o, area: 0.5 } : o)) })), { target: 'rendering', ...want, oracle: false });
  const ol = over.parts[0]!.lods[0]!;
  assert.deepEqual(ol.withheld, [24]);
  assert.equal(ol.mesh.faces.find((f) => f.source === 24)!.count, 0);
  assert.equal(ol.mesh.indices.length / 3, 10);
  // Without a target: nothing classed or withheld, no records.
  const d = fake('a', () => without(sound(), 23));
  const t = await tessellateScene(scene(), d, want);
  assert.equal(d.seen[0]!.target, undefined);
  assert.ok(!t.diagnostics.some((x) => /withheld|warned of/.test(x.message)));
});
