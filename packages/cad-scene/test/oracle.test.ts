import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder } from 'cad-brep';
import { box, cube } from '../../cad-brep/test/models.ts';
import { quads } from './meshes.ts';
import { areaMessage } from '../src/tessellate.ts';
import { FallbackTessellator, ORACLE_DISAGREE, ORACLE_REPLACE, oracleAreas, oracleMeasures, tessellateScene, type Scene,
  type TessellateOptions, type TessellationResult, type Tessellator } from '../src/index.ts';

const model = cube().finish();
const FACES = [21, 22, 23, 24, 25, 26];

/** A one-part scene of the cube, its measures `measures` if given (as read from one of our exports). */
function scene(measures?: Scene['parts'][number]['measures']): Scene {
  return { unit: 'millimetre', components: [], roots: [], materials: [], layers: [], overrides: [], properties: {},
    diagnostics: [], parts: [{ name: 'p', sources: [{ format: 'step', id: 7 }], properties: {},
      origin: [0, 0, 0], lods: [], brep: { format: 'step', model }, ...(measures ? { measures } : {}) }] };
}

/** A backend answering with `r`, the cube's mesh (each face 1), its measures `areas` (by face; 1 if not given). */
function fake(areas: Record<number, number | [number, boolean]> = {}, extra: Partial<TessellationResult> = {}) {
  const asked: boolean[] = [];
  const t: Tessellator & { asked: boolean[] } = {
    asked,
    info: { name: 'fake', version: '1', license: 'x', formats: ['cad-brep'], supportsFaceIds: true,
      supportsEdges: true, supportsCurves: false },
    init: async () => {},
    tessellate: async (req) => {
      asked.push(req.measures ?? false);
      return { ...quads(model), ...(req.measures ? {
        measures: FACES.map((entityId) => {
          const a = areas[entityId] ?? 1, [area, valid] = Array.isArray(a) ? a : [a, true];
          return { entityId, area, perimeter: 4, valid };
        }),
        oracle: oracleMeasures(model) } : {}), ...extra };
    },
    dispose: () => {},
  };
  return t;
}

const run = async (t: Tessellator, s = scene(), opts: TessellateOptions = {}) => {
  const r = await tessellateScene(s, t, opts);
  return { s, part: s.parts[0]!, diagnostics: r.diagnostics };
};

test('measures: the oracle\'s where the backend\'s are off by more than ORACLE_DISAGREE or unsound, with a warning',
  async () => {
  // Face 22 measured 3 (its mesh 1: the oracle's 1 kept, and the mesh sound); 23 just within the threshold (kept);
  // 24 unsound.
  const { part, diagnostics } = await run(fake({ 22: 3, 23: 1 + ORACLE_DISAGREE * 0.99, 24: [1, false] }));
  const m = part.measures!;
  assert.deepEqual([m.faces.get(22)!.area, m.faces.get(22)!.valid], [1, true]);
  assert.equal(m.faces.get(23)!.area, 1 + ORACLE_DISAGREE * 0.99);
  // The oracle's area and error beside each face's, whichever is kept (for users).
  for (const id of [22, 23, 24]) assert.deepEqual(m.faces.get(id)!.oracle, { area: 1, error: 0 });
  assert.deepEqual([m.faces.get(24)!.area, m.faces.get(24)!.valid], [1, true]);
  assert.equal(m.by, 'fake 1, the area oracle\'s for 2 faces');
  assert.deepEqual(diagnostics, [{ severity: 'warning', message: '2 faces\' measured area replaced by the area '
    + 'oracle\'s (the backend\'s more than 1% off, or unsound)', source: { format: 'step', id: 7 } }]);
  // Just past the threshold: replaced.
  const past = await run(fake({ 23: 1 + ORACLE_DISAGREE * 1.01 }));
  assert.equal(past.part.measures!.faces.get(23)!.area, 1);
  // Opted out: the backend's, and so face 22's mesh (1 of 3) is short: an error.
  const kept = await run(fake({ 22: 3 }), scene(), { oracle: false });
  assert.equal(kept.part.measures!.faces.get(22)!.area, 3);
  assert.equal(kept.part.measures!.by, 'fake 1');
  assert.deepEqual(kept.diagnostics.map((d) => d.message), [areaMessage([22])]);
});

test('measures: a sound backend measure gives way only to an oracle area whose error is within ORACLE_REPLACE of it',
  async () => {
  // Each face 1 by the oracle, the backend's 1.5 % over it: face 22's oracle area 0.5 % uncertain (judged, at
  // cad-oracle's JUDGE_RELATIVE, but as far off as the backend's could be): the backend's kept; 23's 1e-4 and 25's at
  // ORACLE_REPLACE itself: replaced; 24 unsound, its oracle area 0.5 % uncertain: the oracle's all the same.
  assert.equal(ORACLE_REPLACE, 1e-3);
  const error: Record<number, number> = { 22: 5e-3, 23: 1e-4, 24: 5e-3, 25: ORACLE_REPLACE, 26: 0 };
  const oracle = FACES.map((entityId) => ({ entityId, area: 1, perimeter: 4, error: error[entityId] ?? 0 }));
  const off = 1 + 1.5 * ORACLE_DISAGREE;
  const { part, diagnostics } = await run(fake({ 22: off, 23: off, 24: [off, false], 25: off }, { oracle }));
  const m = part.measures!;
  assert.deepEqual([22, 23, 24, 25, 26].map((id) => m.faces.get(id)!.area), [off, 1, 1, 1, 1]);
  assert.deepEqual(m.faces.get(22)!.oracle, { area: 1, error: 5e-3 });
  assert.equal(m.by, 'fake 1, the area oracle\'s for 3 faces');
  assert.equal(diagnostics.length, 1);
  // Without an error estimate (an oracle trusting at its own level): replaced.
  const bare = oracle.map(({ error: _, ...o }) => o);
  const b = await run(fake({ 22: off }, { oracle: bare }));
  assert.equal(b.part.measures!.faces.get(22)!.area, 1);
});

test('measures: a backend that measures nothing gets the oracle\'s, without a warning', async () => {
  const t = fake();
  const bare: Tessellator = { ...t, tessellate: async (req) => {
    const r = await t.tessellate(req);
    delete r.measures;
    return r;
  } };
  const { part, diagnostics } = await run(bare);
  assert.deepEqual([...part.measures!.faces.keys()].sort(), FACES);
  assert.equal(part.measures!.by, 'fake 1');
  assert.deepEqual(diagnostics, []);
});

test('faces meshed short of or over their area are errors, by the measures, the oracle\'s where it replaced them',
  async () => {
  // The backend measured face 24 at 2 and meshed it at 2 (a corner pulled out along its diagonal): the oracle's 1
  // replaces the measure, and the mesh is over it.
  const plain = quads(model), r24 = plain.faces.find((f) => f.entityId === 24)!;
  const corner = (j: number) => Array.from(plain.positions.subarray(3 * plain.indices[r24.start]! + 3 * j,
    3 * plain.indices[r24.start]! + 3 * j + 3));
  const [c0, , c2] = [0, 1, 2].map(corner);
  const by = [0, 1, 2].map((i) => c0![i]! - c2![i]!) as [number, number, number];
  const big = quads(model, { face: 24, corner: 0, by });
  const { part, diagnostics } = await run(fake({ 24: 2 }, { positions: big.positions }));
  assert.equal(part.measures!.faces.get(24)!.area, 1);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  // (The corner pulled out in face 24's mesh alone opens the mesh there too.)
  assert.deepEqual(errors, [{ severity: 'error', message: 'not a closed, oriented manifold over its closed shells: '
    + '4 mesh edges (4 used once); faces #24, #21, #25', source: { format: 'step', id: 7 } }, { severity: 'error',
    message: '1 face meshed short of or over its measured area: #24', source: { format: 'step', id: 7 } }]);
  // Measures from the source (an export's) judge the mesh too; this run measures nothing.
  const t = fake();
  const given = scene({ by: 'source', faces: new Map(FACES.map((id) => [id, { area: id === 21 ? 0.5 : 1,
    perimeter: 4, valid: true }])) });
  const g = await run(t, given);
  assert.deepEqual(t.asked, [false]);
  assert.deepEqual(g.diagnostics.map((d) => d.message), [areaMessage([21])]);
});

test('the area error names at most 10 faces, in order', () => {
  assert.equal(areaMessage([5]), '1 face meshed short of or over its measured area: #5');
  assert.equal(areaMessage([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]), '11 faces meshed short of or over their measured '
    + 'area: #1, #2, #3, #4, #5, #6, #7, #8, #9, #10, ...');
});

test('the oracle on a disc bounded by two arcs of one circle: each edge its own parameters', () => {
  const b = new BrepBuilder();
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const circle = b.addCurve({ kind: 'circle', position, radius: 2 });
  const v0 = b.addVertex({ point: [2, 0, 0] }), v1 = b.addVertex({ point: [-2, 0, 0] });
  const upper = b.addEdge({ curve: circle, start: v0, end: v1, sameSense: true, id: 1 });
  const lower = b.addEdge({ curve: circle, start: v1, end: v0, sameSense: true, id: 2 });
  const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position }), sameSense: true, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges: [{ edge: upper, orientation: 'forward' },
      { edge: lower, orientation: 'forward' }] }], id: 3 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  const a = oracleAreas(b.finish()).get(3)!;
  assert.ok(Math.abs(a.area - 4 * Math.PI) < 1e-6 * 4 * Math.PI, JSON.stringify(a));
  assert.ok(Math.abs(a.perimeter - 4 * Math.PI) < 1e-6 * 4 * Math.PI, JSON.stringify(a));
});

test('the oracle leaves out faces sharing an id (which of them it measured can\'t be told)', () => {
  const b = new BrepBuilder();
  for (const x of [0, 3]) {
    const shell = box(b, [1, 1, 1], [x, 0, 0]);
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: shell, sense: true }] }) });
  }
  assert.equal(oracleAreas(b.finish()).size, 0);
  assert.equal(oracleAreas(model).size, 6);
});

test('the measures name the backend that made the result, the oracle with it where it replaced any', async () => {
  // The primary leaves face 23 out; the fallback ("b") measures face 22 at 3, which the oracle replaces.
  const named = (name: string, t: Tessellator): Tessellator => ({ ...t, info: { ...t.info, name } });
  const a = named('a', fake({}, { faces: quads(model).faces.filter((f) => f.entityId !== 23) }));
  const t = new FallbackTessellator(a, named('b', fake({ 22: 3 })), { perFace: false });
  await t.init();
  const { part } = await run(t);
  assert.equal(part.measures!.by, 'b 1, the area oracle\'s for 1 face');
  assert.equal(part.lods[0]!.backend, 'b 1');
});

test('a face without triangles isn\'t an area error (the backend says it failed to mesh)', async () => {
  const { diagnostics } = await run(fake({}, { faces: quads(model).faces.map((f) => (f.entityId === 23
    ? { ...f, count: 0 } : f)) }));
  assert.deepEqual(diagnostics.filter((d) => d.severity === 'error'), []);
});

test('the oracle on a thin cone to its apex, the apex vertex a little off the axis (its points miss by more)',
  async () => {
  // A cone of radius 0.3 at v = 0 and semi-angle 0.5 degrees (its apex 34.4 from the origin), a face from the apex
  // to an arc of 2 radians of the circle at v = 0, the apex vertex 3e-9 off the axis: its area r^2 / (2 sin a) * 2.
  const { modelFaceArea } = await import('../src/index.ts');
  const r = 0.3, a = 0.5 * Math.PI / 180, apex = -r / Math.tan(a), du = 2;
  const b = new BrepBuilder();
  const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const cone = b.addSurface({ kind: 'cone', position, radius: r, semiAngle: a });
  const A = b.addVertex({ point: [3e-9, 0, apex] }), B = b.addVertex({ point: [r, 0, 0] });
  const C = b.addVertex({ point: [r * Math.cos(du), r * Math.sin(du), 0] });
  const line = (p: number[], q: number[]) => b.addCurve({ kind: 'line', point: p,
    direction: q.map((x, i) => x - p[i]!), magnitude: 1 });
  const ab = b.addEdge({ curve: line([0, 0, apex], [r, 0, 0]), start: A, end: B, sameSense: true, id: 1 });
  const ac = b.addEdge({ curve: line([0, 0, apex], [r * Math.cos(du), r * Math.sin(du), 0]), start: A, end: C,
    sameSense: true, id: 2 });
  const arc = b.addEdge({ curve: b.addCurve({ kind: 'circle', position, radius: r }), start: B, end: C,
    sameSense: true, id: 3 });
  const face = (orientations: ('forward' | 'reversed')[]) => b.addFace({ surface: cone, sameSense: true, id: 9,
    loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge: ab, orientation: orientations[0]! },
      { edge: ac, orientation: orientations[1]! }, { edge: arc, orientation: orientations[2]! }] }] });
  const f = face(['reversed', 'forward', 'reversed']);
  b.addItem({ kind: 'face', ref: f });
  const m = b.finish();
  const got = modelFaceArea(m, [...m.face.id].indexOf(9));
  const want = (r * r) / (2 * Math.sin(a)) * du;
  assert.ok(got.ok && Math.abs(got.area - want) < 1e-6 * want, JSON.stringify({ got, want }));
});

test('the oracle on a cone: an edge off it taken to its nearest points, not to the cone at its height', async () => {
  // A band of the cone of radius 2 at z = 0 and semi-angle b (70 degrees: shallow) up to z = H, its top circle moved d
  // off along the cone's normal (radius r + d cos b at height H - d sin b): its nearest points are the cone's circle at
  // H, so the area is the band's, pi (2 + r) H / cos b (the same height's is short by about d tan b times the circle's
  // length: 0.2 at d = 1e-2). The seam's line from the bottom vertex to the top one.
  const { modelFaceArea } = await import('../src/index.ts');
  const b = 70 * Math.PI / 180, H = 1, r = 2 + H * Math.tan(b), want = Math.PI * (2 + r) * H / Math.cos(b);
  for (const d of [0, 1e-3, 1e-2]) {
    const B = new BrepBuilder({ uncertainty: 1e-6 });
    const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
    const zt = H - d * Math.sin(b), rt = r + d * Math.cos(b), len = Math.hypot(rt - 2, zt);
    const v0 = B.addVertex({ point: [2, 0, 0] }), v1 = B.addVertex({ point: [rt, 0, zt] });
    const eb = B.addEdge({ curve: B.addCurve({ kind: 'circle', position: axis, radius: 2 }), start: v0, end: v0,
      sameSense: true, id: 1 });
    const et = B.addEdge({ curve: B.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, zt] }, radius: rt }),
      start: v1, end: v1, sameSense: true, id: 2 });
    const es = B.addEdge({ curve: B.addCurve({ kind: 'line', point: [2, 0, 0], direction: [(rt - 2) / len, 0, zt / len],
      magnitude: 1 }), start: v0, end: v1, sameSense: true, range: [0, len], id: 3 });
    const cone = B.addSurface({ kind: 'cone', radius: 2, semiAngle: b, position: axis });
    const face = B.addFace({ surface: cone, sameSense: true, id: 9, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: eb, orientation: 'forward' }, { edge: es, orientation: 'forward' },
        { edge: et, orientation: 'reversed' }, { edge: es, orientation: 'reversed' }] }] });
    const shell = B.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    B.addItem({ kind: 'body', ref: B.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const m = B.finish(), got = modelFaceArea(m, 0);
    assert.ok('area' in got && Math.abs(got.area - want) <= 1e-6 * want,
      `d ${d}: ${JSON.stringify(got)} against ${want}`);
  }
});

test('the oracle on a cone beyond its apex (the other nappe), past a semi-angle of 45 degrees too', async () => {
  // The sector between the apex and the circle at v = vb < -r / tan a (rho = r + vb tan a < 0, its points at angle
  // u + pi), over beta: area beta rho^2 / (2 sin a). Past 45 degrees a point on this nappe has its foot on the near
  // nappe's generator on that generator's own side of the apex.
  const { modelFaceArea } = await import('../src/index.ts');
  for (const [r, a, beta, vb] of [[1, Math.PI / 6, 1, -4], [1, 1.2, 1, -2], [2, Math.PI / 3, 2, -3]] as const) {
    const B = new BrepBuilder();
    const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
    const s = B.addSurface({ kind: 'cone', radius: r, semiAngle: a, position });
    const apex = [0, 0, -r / Math.tan(a)], rho = r + vb * Math.tan(a);
    const rim = (u: number) => [rho * Math.cos(u), rho * Math.sin(u), vb];
    const A = B.addVertex({ point: apex }), P0 = B.addVertex({ point: rim(0) }), Pb = B.addVertex({ point: rim(beta) });
    const generator = (to: number[], end: number, id: number) => B.addEdge({ curve: B.addCurve({ kind: 'line',
      point: apex, direction: to.map((x, i) => x - apex[i]!), magnitude: 1 }), start: A, end, sameSense: true, id });
    const g0 = generator(rim(0), P0, 1), gb = generator(rim(beta), Pb, 2);
    const arc = B.addEdge({ curve: B.addCurve({ kind: 'circle', position: { ...position, origin: [0, 0, vb] },
      radius: -rho }), start: P0, end: Pb, sameSense: true, range: [Math.PI, Math.PI + beta], id: 3 });
    const face = B.addFace({ surface: s, sameSense: true, id: 9, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: arc, orientation: 'forward' }, { edge: gb, orientation: 'reversed' },
        { edge: g0, orientation: 'forward' }] }] });
    const shell = B.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    B.addItem({ kind: 'body', ref: B.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const m = B.finish(), got = modelFaceArea(m, 0), want = beta * rho * rho / (2 * Math.sin(a));
    assert.ok('area' in got && Math.abs(got.area - want) <= 1e-6 * want, `${r} ${a} ${vb}: ${JSON.stringify(got)} `
      + `against ${want}`);
  }
});

test('the oracle on a sphere: a face over a hemisphere flagged (its loops bound its complement alike); a loose face '
  + 'flagged', async () => {
  const { modelFaceArea } = await import('../src/index.ts');
  // A unit sphere's face (in a sheet's shell) bounded by the circle at latitude -0.5, its loop either way round: one
  // side 2 pi (1 - sin 0.5) = 3.27, trusted; the other 2 pi (1 + sin 0.5) = 9.30, over a hemisphere, flagged. As a
  // face item in no shell, either way flagged loose.
  const face = (o: 'forward' | 'reversed', loose = false) => {
    const b = new BrepBuilder();
    const z = -Math.sin(0.5), rr = Math.cos(0.5);
    const sphere = b.addSurface({ kind: 'sphere', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
      radius: 1 });
    const v = b.addVertex({ point: [rr, 0, z] });
    const e = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { origin: [0, 0, z], axis: [0, 0, 1],
      xDir: [1, 0, 0] }, radius: rr }), start: v, end: v, sameSense: true, id: 1 });
    const f = b.addFace({ surface: sphere, sameSense: true, id: 9, loops: [{ kind: 'edge', bound: 'outer',
      sense: true, coedges: [{ edge: e, orientation: o }] }] });
    if (loose) b.addItem({ kind: 'face', ref: f });
    else {
      const shell = b.addShell({ kind: 'open', faces: [{ face: f, sense: true }] });
      b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    }
    const m = b.finish();
    return modelFaceArea(m, [...m.face.id].indexOf(9));
  };
  const areas = (['forward', 'reversed'] as const).map((o) => face(o));
  for (const o of ['forward', 'reversed'] as const) {
    const r = face(o, true);
    assert.ok(r.ok && r.flags.includes('loose'), JSON.stringify(r));
  }
  const small = 2 * Math.PI * (1 - Math.sin(0.5)), big = 2 * Math.PI * (1 + Math.sin(0.5));
  const byArea = [...areas].sort((x, y) => (x.ok ? x.area : 0) - (y.ok ? y.area : 0));
  assert.ok(byArea[0]!.ok && Math.abs(byArea[0]!.area - small) < 1e-6 && byArea[0]!.flags.length === 0,
    JSON.stringify(byArea[0]));
  assert.ok(byArea[1]!.ok && Math.abs(byArea[1]!.area - big) < 1e-6 && byArea[1]!.flags.includes('sphere-side'),
    JSON.stringify(byArea[1]));
});
