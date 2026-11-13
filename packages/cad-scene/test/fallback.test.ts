import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cube } from '../../cad-brep/test/models.ts';
import { quads, withPoint } from './meshes.ts';
import { FallbackTessellator, judgeResult, openEdgesMessage, oracleAreas, oracleMeasures, tessellateScene, type Scene,
  type TessellationRequest, type TessellationResult, type Tessellator } from '../src/index.ts';

/** The whole-part rules alone (the per-face fallback off). */
const whole = { perFace: false };

const model = cube().finish();
const FACES = [21, 22, 23, 24, 25, 26];

/** The cube's sound result: each face 2 triangles, measured at its true area 1 and perimeter 4. */
function sound(): TessellationResult {
  return { ...quads(model), measures: FACES.map((entityId) => ({ entityId, area: 1, perimeter: 4, valid: true })),
    oracle: oracleMeasures(model) };
}

/** A result with face `id`'s triangles taken away. */
function withoutFace(r: TessellationResult, id: number): TessellationResult {
  return { ...r, faces: r.faces.map((f) => (f.entityId === id ? { ...f, count: 0 } : f)) };
}

const failedPart = (): TessellationResult => ({ origin: [0, 0, 0], positions: new Float32Array(),
  indices: new Uint32Array(), faces: [], diagnostics: [{ severity: 'error', message: 'OCCT: it broke' }] });

/** A fake backend answering every request with `answer` (or throwing it), recording the requests. */
function fake(name: string, answer: () => TessellationResult | Error) {
  const seen: TessellationRequest[] = [];
  const inits: unknown[] = [];
  let disposed = 0;
  const t: Tessellator & { seen: TessellationRequest[]; inits: unknown[]; disposed: () => number } = {
    seen, inits, disposed: () => disposed,
    info: { name, version: '1', license: name === 'b' ? 'B' : 'A',
      formats: name === 'b' ? ['cad-brep', 'step'] : ['iges', 'cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: name !== 'b' },
    timeoutMs: name === 'a' ? 1000 : 2000,
    init: async (opts) => { inits.push(opts); },
    tessellate: async (req) => {
      seen.push(req);
      const r = answer();
      if (r instanceof Error) throw r;
      return { ...r, diagnostics: [{ severity: 'info', message: `${name} meshed` }, ...r.diagnostics] };
    },
    dispose: () => { disposed++; },
  };
  return t;
}

const request = (extra: Partial<TessellationRequest> = {}): TessellationRequest => ({ format: 'cad-brep',
  data: new Uint8Array(model.buffer), linearDeflection: 0.01, angularDeflection: 0.5, ...extra });

test('judge: a sound result passes; each problem is counted, ranked and said', () => {
  const ok = judgeResult(sound(), model, 0.01);
  assert.deepEqual(ok, { ok: true, problems: [], rank: [0, 0, 0, 0, 0, 0] });
  // A face without triangles (whether or not the backend said so: the model's face list tells).
  const gone = judgeResult(withoutFace(sound(), 23), model, 0.01);
  assert.deepEqual(gone, { ok: false, problems: ['1 face without triangles'], rank: [0, 0, 1, 0, 0, 0] });
  const left = { ...sound(), faces: sound().faces.filter((f) => f.entityId !== 23) };
  assert.deepEqual(judgeResult(left, model, 0.01), gone);
  // Wrong by its measures (without the oracle: an empty one): short (partly) and over (excess); unverified (no valid
  // measure) isn't counted.
  const measured = (area: number, valid = true) => ({ ...sound(), measures: sound().measures!.map((m) =>
    (m.entityId === 24 ? { ...m, area, valid } : m)) });
  const none = new Map();
  assert.deepEqual(judgeResult(measured(2), model, 0.01, none).problems, ['1 face meshed only in part']);
  assert.deepEqual(judgeResult(measured(0.5), model, 0.01, none).problems, ['1 face meshed over its area']);
  assert.ok(judgeResult(measured(0.5, false), model, 0.01, none).ok);
  // The oracle's areas (the cube's planes: 1 each) where it has them, over the measures: those wrong measures then
  // don't count, ...
  assert.deepEqual(oracleAreas(model), new Map(FACES.map((id) => [id, { area: 1, perimeter: 4 }])));
  assert.ok(judgeResult(measured(2), model, 0.01).ok);
  // ... and a face meshed wrongly and measured as wrongly is told: face 24's first corner pulled out along the
  // diagonal to twice its distance from the opposite one makes its mesh's area 2, which its measure says too.
  const plain = quads(model), r24 = plain.faces.find((f) => f.entityId === 24)!;
  const corner = (j: number) => Array.from(plain.positions.subarray(3 * plain.indices[r24.start]! + 3 * j,
    3 * plain.indices[r24.start]! + 3 * j + 3));
  const [c0, , c2] = [0, 1, 2].map(corner);
  const by = [0, 1, 2].map((i) => c0![i]! - c2![i]!) as [number, number, number];
  const big = { ...quads(model, { face: 24, corner: 0, by }), measures: sound().measures!.map((m) =>
    (m.entityId === 24 ? { ...m, area: 2 } : m)) };
  assert.ok(judgeResult(big, model, 0.01, none).ok);
  assert.deepEqual(judgeResult(big, model, 0.01).problems, ['1 face meshed over its area']);
  // Open edges, from the backend's error, by its count; another error by its message, one each.
  const open = { ...sound(), diagnostics: [{ severity: 'error' as const, message: openEdgesMessage(3) },
    { severity: 'error' as const, message: 'something else' },
    { severity: 'warning' as const, message: 'a warning' }] };
  assert.deepEqual(judgeResult(open, model, 0.01), { ok: false, problems: ['open along 3 edges', 'something else'],
    rank: [0, 0, 0, 0, 3, 1] });
  // "Faces failed to mesh" is counted by the faces, not again as an error.
  const said = { ...withoutFace(sound(), 23), diagnostics: [{ severity: 'error' as const,
    message: '1 faces failed to mesh' }] };
  assert.deepEqual(judgeResult(said, model, 0.01).rank, [0, 0, 1, 0, 0, 0]);
  // A failed part, and a request that threw: worse than any count, the throw worst.
  const failed = judgeResult(failedPart(), model, 0.01);
  assert.deepEqual(failed, { ok: false, problems: ['OCCT: it broke'], rank: [0, 1, 0, 0, 0, 0] });
  assert.deepEqual(judgeResult(new Error('timed out'), model, 0.01),
    { ok: false, problems: ['failed: timed out'], rank: [1, 0, 0, 0, 0, 0] });
  // Without measures or the oracle's, only faces without triangles; without the model, only the result's own faces.
  assert.ok(judgeResult({ ...sound(), measures: undefined, oracle: undefined }, model, 0.01, new Map()).ok);
  assert.ok(judgeResult({ ...left, measures: undefined, oracle: undefined }, undefined, 0.01).ok);
  // With the model, its face list tells of a face the result lacks, though nothing measures it.
  assert.deepEqual(judgeResult({ ...left, measures: undefined, oracle: undefined }, model, 0.01, new Map()).problems,
    ['1 face without triangles']);
  // (A measured face the result lacks fails, model or not; and one the oracle has.)
  assert.deepEqual(judgeResult({ ...left, measures: undefined }, undefined, 0.01).problems,
    ['1 face without triangles']);
  assert.deepEqual(judgeResult(left, undefined, 0.01).problems, ['1 face without triangles']);
});

test('judge: the oracle\'s areas given first, then the result\'s own (`oracle`), then made from the model', () => {
  // The result's oracle saying face 24 is 2 (as a backend's adapter would, wrongly): short, though the model's 1.
  const said = { ...sound(), oracle: [{ entityId: 24, area: 2, perimeter: 6 }] };
  assert.deepEqual(judgeResult(said, model, 0.01).problems, ['1 face meshed only in part']);
  // Given, it wins over the result's.
  assert.ok(judgeResult(said, model, 0.01, oracleAreas(model)).ok);
  // From bytes or the model, the same.
  assert.deepEqual(oracleMeasures(new Uint8Array(model.buffer)), oracleMeasures(model));
  assert.deepEqual(oracleMeasures(model).map((o) => o.entityId), FACES);
});

test('judge: a face several shells use is judged against its measures times its uses', () => {
  // Face 21 meshed twice (in two shells) and measured once: sound if the model says two shells use it.
  const r = sound();
  const twice = { ...r, faces: [...r.faces, { ...r.faces[0]! }] };
  assert.equal(judgeResult(twice, model, 0.01).problems[0], '1 face meshed over its area');
  const b = cube();
  const d = b.finish();
  const doubled = { ...d, faceUse: { ...d.faceUse, face: Int32Array.from([...d.faceUse.face, 0]),
    sense: Uint8Array.from([...d.faceUse.sense, 1]) } };
  assert.ok(judgeResult(twice, doubled as typeof d, 0.01).ok);
});

test('fallback: a sound part is the primary\'s alone; the fallback isn\'t asked', async () => {
  const a = fake('a', sound), b = fake('b', sound);
  const t = new FallbackTessellator(a, b);
  await t.init({ glue: 'x' });
  // The init options are the primary's.
  assert.deepEqual([a.inits, b.inits], [[{ glue: 'x' }], [undefined]]);
  const r = await t.tessellate(request());
  assert.equal(b.seen.length, 0);
  assert.equal(r.backend, 'a 1');
  assert.deepEqual(r.diagnostics, [{ severity: 'info', message: 'a meshed' }]);
  // Measured to be judged, the measures (and the oracle's) dropped as not asked for; kept when asked.
  assert.equal(a.seen[0]!.measures, true);
  assert.equal(r.measures, undefined);
  assert.equal(r.oracle, undefined);
  assert.equal((await t.tessellate(request({ measures: true }))).measures!.length, 6);
  // Edges asked for, to join and fill by, and dropped as not asked for; with both off, not asked for.
  assert.equal(a.seen[1]!.edges, true);
  assert.equal(r.edges, undefined);
  assert.equal(r.edgePositions, undefined);
  const plain = fake('a', sound), off = new FallbackTessellator(plain, fake('b', sound), { join: false, fill: false });
  await off.init();
  await off.tessellate(request());
  assert.equal(plain.seen[0]!.edges, undefined);
});

test('fallback: a part the primary fails is the fallback\'s where it has fewer problems, with a warning', async () => {
  const a = fake('a', () => withoutFace(sound(), 23)), b = fake('b', sound);
  const t = new FallbackTessellator(a, b, whole);
  await t.init();
  const r = await t.tessellate(request({ edges: true }));
  assert.equal(r.backend, 'b 1');
  assert.equal(b.seen.length, 1);
  assert.deepEqual(b.seen[0], { ...request({ edges: true }), measures: true });
  assert.deepEqual(r.diagnostics, [{ severity: 'warning', message: 'meshed by the fallback backend (b), since a\'s '
    + 'mesh had problems: 1 face without triangles' }, { severity: 'info', message: 'b meshed' }]);
  assert.equal(r.faces.find((f) => f.entityId === 23)!.count, 6);
});

/** The sound cube with an error saying it's open along `n` edges. */
const opened = (n: number): TessellationResult => ({ ...sound(), diagnostics: [{ severity: 'error',
  message: openEdgesMessage(n) }] });
/** The sound cube but face 24 measured 0.5 by the oracle (meshed at 1: over). */
const over = (): TessellationResult => ({ ...sound(), oracle: [{ entityId: 24, area: 0.5, perimeter: 3 }] });
/** The sound cube but face 24 measured 2 by the backend and the oracle (meshed at 1: short). */
const short = (): TessellationResult => ({ ...sound(), oracle: [{ entityId: 24, area: 2, perimeter: 6 }] });

test('fallback: both with problems: the better kind by kind, a tie the primary\'s (said in a note)', async () => {
  const two = () => withoutFace(withoutFace(sound(), 23), 24);
  const cases: [() => TessellationResult | Error, () => TessellationResult | Error, string][] = [
    [two, () => withoutFace(sound(), 23), 'b 1'],
    [() => withoutFace(sound(), 23), two, 'a 1'],
    [() => withoutFace(sound(), 23), () => withoutFace(sound(), 25), 'a 1'],
    [failedPart, () => withoutFace(sound(), 23), 'b 1'],
    [() => new Error('timed out'), failedPart, 'b 1'],
    [() => withoutFace(sound(), 23), () => new Error('crashed'), 'a 1'],
    // Kind by kind: a face missing is worse than any number of faces off their area, and one off its area worse than
    // any number of edges open.
    [() => withoutFace(sound(), 23), () => opened(9), 'b 1'],
    [() => opened(9), () => withoutFace(sound(), 23), 'a 1'],
    [() => withoutFace(sound(), 23), () => short(), 'b 1'],
    [() => short(), () => opened(9), 'b 1'],
    [() => over(), () => opened(9), 'b 1'],
    [() => opened(9), () => opened(2), 'b 1'],
  ];
  for (const [ra, rb, want] of cases) {
    const t = new FallbackTessellator(fake('a', ra), fake('b', rb), whole);
    await t.init();
    const r = await t.tessellate(request());
    assert.equal(r.backend, want);
    if (want === 'a 1') assert.match(r.diagnostics[0]!.message, /^the fallback backend \(b\) did no better than a \(/);
    assert.equal(r.diagnostics[0]!.severity, want === 'a 1' ? 'info' : 'warning');
  }
  // Both threw: the primary's error.
  const t = new FallbackTessellator(fake('a', () => new Error('first')), fake('b', () => new Error('second')));
  await t.init();
  await assert.rejects(t.tessellate(request()), /^Error: first$/);
});

test('fallback: info joins both; timeout the primary\'s; dispose both; tessellateScene names who meshed', async () => {
  const a = fake('a', () => withoutFace(sound(), 23)), b = fake('b', sound);
  const t = new FallbackTessellator(a, b, whole);
  await t.init();
  assert.deepEqual(t.info, { name: 'a+b', version: '1; fallback b 1', license: 'A; B', formats: ['cad-brep'],
    supportsFaceIds: true, supportsEdges: true, supportsCurves: false });
  assert.equal(t.timeoutMs, 1000);
  assert.equal(new FallbackTessellator(fake('a', sound), fake('a', sound)).info.license, 'A');
  const scene: Scene = { unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [],
    properties: {}, diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }], properties: {},
      origin: [0, 0, 0], lods: [], brep: { format: 'step', model } }] };
  const r = await tessellateScene(scene, t);
  assert.equal(scene.parts[0]!.lods[0]!.backend, 'b 1');
  assert.equal(scene.parts[0]!.measures!.by, 'b 1');
  assert.equal(r.diagnostics[0]!.severity, 'warning');
  t.dispose();
  assert.deepEqual([a.disposed(), b.disposed()], [1, 1]);
  // Nested: the inner one's result says which of its backends made it.
  const inner = new FallbackTessellator(fake('b', () => withoutFace(sound(), 23)), fake('c', sound), whole);
  const outer = new FallbackTessellator(fake('a', () => withoutFace(withoutFace(sound(), 23), 24)), inner, whole);
  await outer.init();
  assert.equal((await outer.tessellate(request())).backend, 'c 1');
});

test('per face: a face the primary leaves out is the fallback\'s alone, the rest the primary\'s', async () => {
  const a = fake('a', () => withoutFace(sound(), 23)), b = fake('b', sound);
  const t = new FallbackTessellator(a, b);
  await t.init();
  const r = await t.tessellate(request());
  assert.equal(r.backend, 'a 1, with 1 face by b 1');
  assert.deepEqual(r.diagnostics, [{ severity: 'warning', message: '1 face meshed by the fallback backend (b), since '
    + 'a\'s mesh had problems: 1 face without triangles: #23' }, { severity: 'info', message: 'a meshed' }]);
  assert.ok(judgeResult(r, model, 0.01).ok);
  // Face 23's triangles the fallback's (its vertices after the primary's), the others the primary's.
  const n = sound().positions.length / 3;
  for (const f of r.faces) {
    const vs = [...r.indices.subarray(f.start, f.start + f.count)];
    assert.ok(vs.length && vs.every((v) => (f.entityId === 23 ? v >= n : v < n)), `face ${f.entityId}`);
  }
  // Off: the fallback's whole mesh.
  const w = new FallbackTessellator(fake('a', () => withoutFace(sound(), 23)), fake('b', sound), whole);
  await w.init();
  assert.equal((await w.tessellate(request())).backend, 'b 1');
});

test('per face: a face meshed over its area, its edges open, the fallback\'s; not where the fallback\'s is as bad',
  async () => {
  // Face 23's first corner pulled out by 0.5: over its area, the two edges at the corner open beyond any join.
  const pulled = () => ({ ...quads(model, { face: 23, corner: 0, by: [0.5, 0.5, 0.5] }), measures: sound().measures,
    oracle: sound().oracle });
  const t = new FallbackTessellator(fake('a', pulled), fake('b', sound));
  await t.init();
  const r = await t.tessellate(request());
  assert.equal(r.backend, 'a 1, with 1 face by b 1');
  assert.ok(judgeResult(r, model, 0.01).ok, JSON.stringify(judgeResult(r, model, 0.01)));
  // The fallback as bad on that face: no face of it taken; the whole-part rules (a tie: the primary's).
  const u = new FallbackTessellator(fake('a', pulled), fake('b', pulled));
  await u.init();
  const k = await u.tessellate(request());
  assert.equal(k.backend, 'a 1');
  // The fallback's face not meeting the primary's (its whole mesh elsewhere): its whole mesh, better than the mix.
  const away = () => { const s = sound(); return { ...s, positions: s.positions.map((x) => x + 0.05) }; };
  const v = new FallbackTessellator(fake('a', pulled), fake('b', away));
  await v.init();
  assert.equal((await v.tessellate(request())).backend, 'b 1');
});

/** Each edge id's faces, by id, from the model's loops. */
function edgeFaces(): Map<number, number[]> {
  const users = new Map<number, number[]>();
  for (const f of FACES) {
    const row = [...model.face.id].indexOf(f);
    for (let k = model.face.firstLoop[row]!; k < model.face.firstLoop[row]! + model.face.loopCount[row]!; k++) {
      for (let j = model.loop.first[k]!; j < model.loop.first[k]! + model.loop.count[k]!; j++) {
        const e = model.edge.id[model.coedge.edge[j]!]!;
        users.set(e, [...(users.get(e) ?? []), f]);
      }
    }
  }
  return users;
}
const sharesEdge = (f: number, g: number) => [...edgeFaces().values()].some((us) => us.includes(f) && us.includes(g));

test('composeResults: the faces\' triangles, measures and edges the second\'s; failed faces and open edges told again',
  async () => {
  const { composeResults } = await import('../src/index.ts');
  const a = { ...withoutFace(sound(), 24), normals: new Float32Array(sound().positions.length),
    diagnostics: [{ severity: 'error' as const, message: '1 faces failed to mesh: #24' },
      { severity: 'error' as const, message: openEdgesMessage(4) }, { severity: 'warning' as const, message: 'x' }] };
  const s = sound();
  const b = { ...s, measures: s.measures!.map((m) => ({ ...m, area: 7 })), edges: s.edges!.map((e) => ({ ...e,
    kind: 'seam' as const })), diagnostics: [{ severity: 'warning' as const, message: 'y' }] };
  // (Faces 21 and the face across its first edge: that edge only they use.)
  const across = [...model.face.id].find((f) => f !== 21 && sharesEdge(21, f))!;
  const c = composeResults(model, a, b, new Set([21, across]));
  assert.deepEqual(c.measures!.filter((m) => m.area === 7).map((m) => m.entityId).sort(), [21, across].sort());
  assert.equal(c.measures!.filter((m) => m.entityId === 21).length, 1);
  // The edge only those two faces use the second's polyline; every other edge the first's.
  const users = edgeFaces();
  for (const e of c.edges!) {
    const us = users.get(e.entityId!)!;
    assert.equal(e.kind, us.every((f) => f === 21 || f === across) ? 'seam' : 'shared', `edge ${e.entityId}`);
  }
  assert.ok(c.edges!.some((e) => e.kind === 'seam'));
  assert.equal(c.edges!.length, 12);
  // Normals only where both have them; diagnostics the first's, its failed faces and open edges counted again.
  assert.equal(c.normals, undefined);
  assert.deepEqual(c.diagnostics, [{ severity: 'warning', message: 'x' },
    { severity: 'error', message: '1 faces failed to mesh: #24' }]);
  assert.equal(c.faces.reduce((n, f) => n + f.count, 0), c.indices.length);
});

test('per face: the face a join can\'t close an edge for, the fallback\'s; its faces joined to the primary\'s',
  async () => {
  // Face 23's corner 0.05 off the edge's end, with the deflection 0.04: too little off its area to judge it, too far
  // to join.
  const req = request({ linearDeflection: 0.04 });
  const off = () => ({ ...sound(), ...quads(model, { face: 23, corner: 0, by: [0, 0, 0.05] }),
    measures: sound().measures, diagnostics: [{ severity: 'error' as const, message: openEdgesMessage(2) }] });
  assert.deepEqual(judgeResult(off(), model, 0.04).rank, [0, 0, 0, 0, 2, 0]);
  const t = new FallbackTessellator(fake('a', off), fake('b', sound));
  await t.init();
  assert.equal((await t.tessellate(req)).backend, 'a 1, with 1 face by b 1');
  // The fallback's face 23 with a point of its own on a side (a T-junction with the primary's neighbour there):
  // the composite joined, then sound.
  const tj = () => ({ ...sound(), ...withPoint(quads(model), 23, 0) });
  const u = new FallbackTessellator(fake('a', () => withoutFace(sound(), 23)), fake('b', tj));
  await u.init();
  const r = await u.tessellate(request());
  assert.equal(r.backend, 'a 1, with 1 face by b 1');
  assert.ok(judgeResult(r, model, 0.01).ok);
});

test('per face: not a face the fallback meshes wrongly too; not a mix worse than the primary\'s mesh', async () => {
  // The primary without face 23, the fallback with it over its area (and so open at its corner): the fallback's whole
  // mesh, not the mix (as good, but with the fallback's bad face).
  const pulled = () => ({ ...sound(), ...quads(model, { face: 23, corner: 0, by: [0.5, 0.5, 0.5] }),
    measures: sound().measures, diagnostics: [{ severity: 'error' as const, message: openEdgesMessage(2) }] });
  const t = new FallbackTessellator(fake('a', () => withoutFace(sound(), 23)), fake('b', pulled));
  await t.init();
  assert.equal((await t.tessellate(request())).backend, 'b 1');
  // The primary open at face 23's corner (0.05 off, the deflection 0.04); the fallback without faces 25 and 26 and
  // everywhere 0.05 away, so its face 23 meets the primary's faces nowhere: the mix (more edges open) worse than the
  // primary's, the fallback's worse still: the primary's kept.
  const req = request({ linearDeflection: 0.04 });
  const off = () => ({ ...sound(), ...quads(model, { face: 23, corner: 0, by: [0, 0, 0.05] }),
    measures: sound().measures, diagnostics: [{ severity: 'error' as const, message: openEdgesMessage(2) }] });
  const away = () => { const s = withoutFace(withoutFace(sound(), 25), 26);
    return { ...s, positions: s.positions.map((x) => x + 0.05) }; };
  const u = new FallbackTessellator(fake('a', off), fake('b', away));
  await u.init();
  assert.equal((await u.tessellate(req)).backend, 'a 1');
});

test('judge: a face without triangles is failed however small (faceFailures doesn\'t judge faces under d^2)', () => {
  // Face 23 (area 1) left out, judged at a deflection of 2: under the deflection squared, failed all the same.
  assert.deepEqual(judgeResult(withoutFace(sound(), 23), model, 2).rank, [0, 0, 1, 0, 0, 0]);
  // A face the result has no range for at all: the same.
  const left = { ...sound(), faces: sound().faces.filter((f) => f.entityId !== 23) };
  assert.deepEqual(judgeResult(left, model, 2).rank, [0, 0, 1, 0, 0, 0]);
});
