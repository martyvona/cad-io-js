// CadioTessellator on cad-brep's test models through the WebAssembly module (build.sh module; skipped where it isn't
// built): the result's shape as cad-scene's other backends give it, closed where the model is (cad-scene's
// openEdges), faces cad-geom can't mesh reported, positions minus the origin, normals finite and unit, the same bytes
// twice in one instance and in fresh ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { openEdges, oracleMeasures, type TessellationProgress, type TessellationResult } from 'cad-scene';
import { MODELS } from '../../cad-brep/test/models.ts';
import { type BrepData, BrepBuilder, curveEvaluator, openBrep } from '../../cad-brep/src/index.ts';
import { CadioTessellator, EXPECTED_HEAD, INSERTED_HEAD, INSERTED_KINDS, POLES_HEAD, progressReporter, ROUNDS_HEAD,
  VERSION } from '../src/index.ts';
import { CAUSES_HEAD, failedCauses, KEPT_HEAD, keptDefects } from '../src/causes.ts';
import { ANALYSES, MODELS as TESS_MODELS, affineFeetOff, bentApex, bsplineApexHole, bsplineDome, bumpPatch, cap,
  poleRowFan,
  cuspPocket_, fold, halfCap, knotAtEnd,
  loopless, luneOnSeam, luneQuarter, meridianHemisphere, seamByInversion, seamFlipped, torusOuterHalf, uFold }
  from '../native/test/models.ts';

const dist = path.join(import.meta.dirname, '..', 'dist', 'tess_cadio.wasm');
const skip = fs.existsSync(dist) ? false : 'tess-cadio\'s module not built (run packages/tess-cadio/build.sh module)';
const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')) as
  { version: string; license: string };

async function tessellator(): Promise<CadioTessellator> {
  const t = new CadioTessellator();
  await t.init();
  return t;
}
const req = (name: keyof typeof MODELS, extra: object = {}) => ({ format: 'cad-brep' as const,
  data: new Uint8Array(MODELS[name]().finish().buffer), linearDeflection: 0.01, angularDeflection: 0.26,
  edges: true, ...extra });
/** Each face range's triangles' area, by its id. */
function areas(r: TessellationResult): Map<number | null, number> {
  const out = new Map<number | null, number>(), p = r.positions;
  for (const f of r.faces) {
    let a = 0;
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [i, j, k] = [r.indices[t]! * 3, r.indices[t + 1]! * 3, r.indices[t + 2]! * 3];
      const u = [p[j]! - p[i]!, p[j + 1]! - p[i + 1]!, p[j + 2]! - p[i + 2]!];
      const v = [p[k]! - p[i]!, p[k + 1]! - p[i + 1]!, p[k + 2]! - p[i + 2]!];
      a += 0.5 * Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!,
        u[0]! * v[1]! - u[1]! * v[0]!);
    }
    out.set(f.entityId, (out.get(f.entityId) ?? 0) + a);
  }
  return out;
}
const bytes = (r: TessellationResult) => JSON.stringify([Array.from(r.positions), Array.from(r.normals ?? []),
  Array.from(r.indices), r.faces, r.edges, Array.from(r.edgePositions ?? []), r.diagnostics]);

test('info: the workspace version and the module\'s hash, AGPL-3.0-only, cad-brep only', { skip }, async () => {
  assert.equal(VERSION, pkg.version);
  const t = await tessellator();
  assert.match(t.info.version, new RegExp(`^${pkg.version.replace(/\./g, '\\.')}, wasm [0-9a-f]{12}$`));
  assert.equal(t.info.license, 'AGPL-3.0-only');
  assert.equal(t.info.license, pkg.license);
  assert.deepEqual(t.info.formats, ['cad-brep']);
  await assert.rejects(t.tessellate({ ...req('cube'), format: 'step' }), /isn't taken/);
});

test('measures: the area oracle\'s areas (this thread\'s oracleMeasures), none of its own; none unasked', { skip },
  async () => {
  const t = await tessellator();
  const r = await t.tessellate({ ...req('cube'), measures: true });
  assert.deepEqual(r.oracle, oracleMeasures(new Uint8Array(req('cube').data)));
  assert.equal(r.oracle!.length, 6);
  assert.equal(r.measures, undefined);
  assert.equal((await t.tessellate(req('cube'))).oracle, undefined);
});

test('closed models: every face meshed to its area, no open edge, every edge shared at its dihedral', { skip },
  async () => {
  const t = await tessellator();
  // (reversedUses: faces built inside out and used reversed, their sense false.)
  for (const name of ['cube', 'withVoid', 'reversedUses'] as const) {
    const d = MODELS[name]().finish();
    const r = await t.tessellate(req(name));
    assert.deepEqual(r.diagnostics, [], name);
    assert.ok(r.faces.length > 0 && r.faces.every((f) => f.count > 0), name);
    assert.equal(r.faces.reduce((n, f) => n + f.count, 0), r.indices.length);
    const { open, unjudged } = openEdges(d, r);
    assert.deepEqual(open, [], name);
    assert.deepEqual(unjudged, [], name);
    assert.ok(r.edges!.length > 0 && r.edges!.every((e) => e.kind === 'shared'), name);
    for (const e of r.edges!) assert.ok(Math.abs(e.dihedral! - Math.PI / 2) < 1e-6, `${name}: ${e.dihedral}`);
    // Each face's triangles' area its own, by cad-scene's area oracle (planes: exact).
    const got = areas(r);
    for (const o of oracleMeasures(d)) assert.ok(Math.abs(got.get(o.entityId)! - o.area) < 1e-6 * o.area, name);
  }
});

test('a fold of two planes, one built facing down with its sense false: both up, the dihedral 45 degrees', { skip },
  async () => {
    const t = await tessellator();
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(fold().finish().buffer) });
    assert.deepEqual(r.diagnostics, []);
    const shared = r.edges!.filter((e) => e.kind === 'shared');
    assert.equal(shared.length, 1);
    assert.ok(Math.abs(shared[0]!.dihedral! - Math.PI / 4) < 1e-6, String(shared[0]!.dihedral));
    // Both faces' normals up (+z component), as their senses say.
    for (let i = 2; i < r.normals!.length; i += 3) assert.ok(r.normals![i]! > 0.5);
  });

test('a model without ids: faces and edges with null entityIds, still meshed', { skip }, async () => {
  const t = await tessellator();
  const r = await t.tessellate(req('withoutIds'));
  assert.ok(r.faces.some((f) => f.entityId === null && f.count > 0));
  assert.ok(r.faces.some((f) => f.entityId !== null && f.count > 0));
  assert.ok(r.edges!.some((e) => e.entityId === null));
  assert.ok(!r.faces.some((f) => f.entityId === 0) && !r.edges!.some((e) => e.entityId === 0));
});

test('loose items as the other backends give them: curve items and wire edges as polylines within the deflection, '
  + 'composites by segment, unbounded curves left out and said, points with their ids', { skip }, async () => {
  const t = await tessellator();
  // Distance from p to curve row `row` of the model (cad-brep's own evaluator, independent of cad-geom's).
  const off = (d: BrepData, row: number) => {
    const c = curveEvaluator(d, row)!;
    return (p: number[]) => {
      const u = c.param(p);
      return u === undefined ? Infinity : Math.hypot(...c.point(u).map((x, j) => x - p[j]!));
    };
  };
  const at = (r: TessellationResult, k: number) => Array.from(r.curvePositions!.subarray(3 * k, 3 * k + 3));
  // everyKind: its 11 3D curves as items, none with an item id, the line (#501) the only curve with one.
  const model = MODELS.everyKind().finish(), r = await t.tessellate({ ...req('everyKind'), edges: false });
  const d = openBrep(model.buffer);
  // The line, hyperbola and parabola unbounded, left out; the composite's line segment too, its polyline given.
  // In item order: circle, ellipse, B-splines, polyline, trimmed, the composite's segment (row 7), offset.
  const rows = [1, 2, 5, 6, 7, 8, 7, 10];
  assert.equal(r.curves!.length, rows.length);
  const warn = r.diagnostics.find((x) => x.message.includes('wireframe curves left out'));
  assert.match(warn?.message ?? '',
    /^4 wireframe curves left out, or a composite's segments .*: #501, no id, no id, no id$/);
  // Each polyline within the deflection of its curve: its points on it, its chords' quarter points within 0.01.
  r.curves!.forEach((c, i) => {
    const dist = off(d, rows[i]!);
    assert.ok(c.count >= 2);
    for (let k = c.start; k < c.start + c.count; k++) assert.ok(dist(at(r, k)) < 1e-6, `curve ${rows[i]} point ${k}`);
    for (let k = c.start; k + 1 < c.start + c.count; k++) {
      const a = at(r, k), b = at(r, k + 1);
      for (const w of [0.25, 0.5, 0.75]) {
        assert.ok(dist(a.map((x, j) => x + w * (b[j]! - x))) <= 0.01 + 1e-9, `curve ${rows[i]} chord ${k}`);
      }
    }
  });
  // The circle (row 1) periodic: closed, in at least 3 spans; the composite's segment reversed, (1, 1, 1) to (0, 0, 0).
  const circle = r.curves![0]!, last = r.curves![6]!;
  assert.ok(circle.count >= 4);
  const near = (p: number[], q: number[]) => Math.hypot(...p.map((x, j) => x - q[j]!)) < 1e-5;
  assert.ok(near(at(r, circle.start), at(r, circle.start + circle.count - 1)));
  assert.deepEqual([at(r, last.start), at(r, last.start + last.count - 1)], [[1, 1, 1], [0, 0, 0]]);
  assert.ok(r.curves!.every((c) => c.entityId === null));
  assert.deepEqual(Array.from(r.points!), [9, 8, 7]);
  assert.deepEqual(r.pointIds, [701]);
  // Minus the origin, as faces are.
  const o = await t.tessellate({ ...req('everyKind'), edges: false, origin: [1, 2, 3] });
  assert.deepEqual(Array.from(o.points!), [8, 6, 4]);
  assert.ok(near(Array.from(o.curvePositions!.subarray(0, 3)), at(r, 0).map((x, j) => x - [1, 2, 3][j]!)));
  // A wire body's edges, from vertex to vertex: (5, 0, 0) to (6, 0, 0) and on to (6, 1, 0), no ids.
  const w = await t.tessellate({ ...req('facetedAndWire'), edges: false });
  assert.deepEqual(w.curves!.map((c) => [c.entityId, c.count]), [[null, 2], [null, 2]]);
  assert.deepEqual(Array.from(w.curvePositions!), [5, 0, 0, 6, 0, 0, 6, 0, 0, 6, 1, 0]);
  assert.equal(w.points, undefined);
  // Points without an id null.
  const n = await t.tessellate(req('withoutIds'));
  assert.deepEqual(n.pointIds, [null, 30]);
  assert.deepEqual(Array.from(n.points!), [5, 5, 5, 6, 6, 6]);
  assert.equal(n.curves, undefined);
  assert.equal(t.info.supportsCurves, true);
  // Ids: an item's own, else its curve's.
  const b = new BrepBuilder();
  const ring = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1, id: 77 });
  b.addItem({ kind: 'curve', ref: ring });
  b.addItem({ kind: 'curve', ref: ring, id: 88 });
  const ids = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(b.finish().buffer), linearDeflection: 0.01,
    angularDeflection: 0.26 });
  assert.deepEqual(ids.curves!.map((c) => c.entityId), [77, 88]);
  // A composite inside one reversed: its segments in reverse order, each reversed.
  const c = new BrepBuilder();
  const s1 = c.addCurve({ kind: 'polyline', points: [[0, 0, 0], [1, 0, 0]] });
  const s2 = c.addCurve({ kind: 'polyline', points: [[1, 0, 0], [1, 1, 0]] });
  const inner = c.addCurve({ kind: 'composite', segments: [{ curve: s1, sameSense: true, transition: 'continuous' },
    { curve: s2, sameSense: true, transition: 'continuous' }], selfIntersect: false });
  const outer = c.addCurve({ kind: 'composite', segments: [{ curve: inner, sameSense: false,
    transition: 'continuous' }], selfIntersect: false });
  c.addItem({ kind: 'curve', ref: outer, id: 5 });
  const nested = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(c.finish().buffer),
    linearDeflection: 0.01, angularDeflection: 0.26 });
  assert.deepEqual(nested.curves!.map((x) => [x.entityId, x.count]), [[5, 2], [5, 2]]);
  assert.deepEqual(Array.from(nested.curvePositions!), [1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0]);
  // The angle alone (a unit circle at d = 1): no span turns more than 0.26, so at least 2 pi / 0.26 spans; no angle
  // and d = 10, one span would do but a periodic curve has at least 3.
  const unit = (angularDeflection: number, linearDeflection: number) => {
    const u = new BrepBuilder();
    u.addItem({ kind: 'curve', ref: u.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, 0, 1],
      xDir: [1, 0, 0] }, radius: 1 }) });
    return t.tessellate({ format: 'cad-brep', data: new Uint8Array(u.finish().buffer), linearDeflection,
      angularDeflection });
  };
  assert.ok((await unit(0.26, 1)).curves![0]!.count - 1 >= Math.ceil(2 * Math.PI / 0.26));
  assert.ok((await unit(0, 10)).curves![0]!.count - 1 >= 3);
  // A wire edge that can't be sampled (on a line, from a vertex back to it): left out and said, no empty polyline.
  const e = new BrepBuilder();
  const v = e.addVertex({ point: [0, 0, 0] });
  const line = e.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 });
  const edge = e.addEdge({ curve: line, start: v, end: v, sameSense: true, id: 9 });
  e.addItem({ kind: 'body', ref: e.addBody({ kind: 'wire', members: [{ ref: edge, sense: true }] }) });
  const bad = await t.tessellate({ format: 'cad-brep', data: new Uint8Array(e.finish().buffer),
    linearDeflection: 0.01, angularDeflection: 0.26 });
  assert.equal(bad.curves, undefined);
  assert.ok(bad.diagnostics.some((x) => /^1 wireframe curves left out.*: #9$/.test(x.message)),
    JSON.stringify(bad.diagnostics));
});

test('the seam cylinder: its seam a seam; a sphere\'s faces: the whole one (no loops) and the hemisphere meshed',
  { skip },
  async () => {
    const t = await tessellator();
    const c = await t.tessellate(req('seamCylinder'));
    assert.deepEqual(c.diagnostics, []);
    const kinds = c.edges!.map((e) => e.kind).sort();
    assert.deepEqual(kinds, ['free', 'free', 'seam']);
    const s = await t.tessellate(req('spheres'));
    assert.equal(s.faces.length, 2);
    assert.ok(s.faces[0]!.count > 0);
    assert.ok(s.faces[1]!.count > 0);
    assert.ok(!s.diagnostics.some((x) => x.severity === 'error'), JSON.stringify(s.diagnostics));
    for (const r of [c, s]) {
      for (let i = 0; i < r.normals!.length; i += 3) {
        const n = Math.hypot(r.normals![i]!, r.normals![i + 1]!, r.normals![i + 2]!);
        assert.ok(Math.abs(n - 1) < 1e-6, `normal ${i / 3}: ${n}`);
      }
    }
  });

test('triangles still refused counted, those in a pole\'s fan apart: none at poles made as fans; ' +
  'a lune\'s, unfanned; a cylinder\'s',
  { skip }, async () => {
    const t = await tessellator();
    const re = /^(\d+) faces meshed with triangles their criteria still refuse: (\d+) triangles, (\d+) of them slivers/;
    const refused = async (model: { finish(): { buffer: ArrayBuffer } }, l: number, a: number) => {
      const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(model.finish().buffer),
        linearDeflection: l, angularDeflection: a });
      return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    };
    // Faces through, round or at their poles, at settings that refused triangles in poles' fans before they were
    // made as fans: none there now.
    for (const [name, model] of [['halfCap', halfCap], ['luneQuarter', luneQuarter],
      ['meridianHemisphere', meridianHemisphere], ['cap', cap]] as const) {
      for (const [l, a] of [[0.01, 0.05], [0.001, 0.05], [0.001, 0.1]] as const) {
        const c = await refused(model(), l, a);
        assert.equal(c?.[3] ?? '0', '0', `${name} at ${l}, ${a}: ${c?.[2]} refused, ${c?.[3]} at a pole`);
      }
    }
    // luneOnSeam, with no p-curves, by inversion left its seam's side unsettled (no fan made on a guess); projected,
    // the side is the rule's (seamUseTakesTwin): settled, fanned, none refused at its poles, no unsettled seam.
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(luneOnSeam().finish().buffer),
      linearDeflection: 0.01, angularDeflection: 0.05 });
    const l = r.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    assert.equal(l?.[3] ?? '0', '0', `${l?.[2]} refused, ${l?.[3]} at a pole`);
    assert.ok(!r.diagnostics.some((x) => /seam whose side/.test(x.message)));
    // By inversion (projection off), luneOnSeam's seam side is unsettled, no fan made: its pole's refused triangles,
    // the mesher's own, counted as at the pole (at 0.02 rad: at 0.05 its uses traced sample by sample leave none).
    const inverting = new CadioTessellator();
    await inverting.init({ projectMissingPcurves: false });
    const ri = await inverting.tessellate({ ...req('cube'), data: new Uint8Array(luneOnSeam().finish().buffer),
      linearDeflection: 0.01, angularDeflection: 0.02 });
    const li = ri.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    assert.ok(li, JSON.stringify(ri.diagnostics));
    assert.ok(Number(li[3]) >= 1 && Number(li[3]) <= Number(li[2]), `${li[2]} refused, ${li[3]} at a pole`);
    assert.ok(ri.diagnostics.some((x) => /seam whose side in \(u, v\) their neighbours didn't settle/.test(x.message)));
    // bsplineApexHole's at 1e-3 mm and 0.1 rad: refused, none in a pole's fan (kept: past the deflection, the
    // check would fail or mark the face).
    const keeping = new CadioTessellator();
    await keeping.init({ checkDeviation: false });
    const ro = await keeping.tessellate({ ...req('cube'), data: new Uint8Array(bsplineApexHole().finish().buffer),
      linearDeflection: 1e-3, angularDeflection: 0.1 });
    const o = ro.diagnostics.map((x) => re.exec(x.message)).find((m) => m);
    assert.ok(o);
    assert.ok(Number(o[2]) >= 1);
    assert.equal(o[3], '0');
  });

test('init({checkDeviation}): a face left farther from its surface than the deflection fails; false never checked',
  { skip }, async () => {
    // torusOuterHalf from its boundary alone (one point, its turned triangles kept): its triangles across the tube
    // past the deflection. Checked (without keepDefects), its face fails (the failed faces' diagnostic, no triangles
    // for it); not checked, kept as meshed.
    const data = new Uint8Array(torusOuterHalf().finish().buffer);
    const run = async (checkDeviation: boolean) => {
      const t = new CadioTessellator();
      await t.init({ checkDeviation, keepDefects: false, maxPointsPerFace: 1, failCapped: false,
        failTurnedOver: false });
      return t.tessellate({ ...req('cube'), data, linearDeflection: 0.1 });
    };
    const strict = await run(true), never = await run(false);
    const failed = (r: TessellationResult) => r.diagnostics.some((x) => /faces failed to mesh/.test(x.message));
    assert.ok(failed(strict), JSON.stringify(strict.diagnostics));
    assert.ok(!failed(never), JSON.stringify(never.diagnostics));
    assert.ok(strict.indices.length < never.indices.length);
  });

test('init({maxPointsPerFace}): a face that reaches it fails, said as capped, not as an unsettled seam', { skip },
  async () => {
  const t = new CadioTessellator();
  await t.init({ maxPointsPerFace: 20, checkDeviation: false, keepDefects: false });
  const r = await t.tessellate({ ...req('spheres'), linearDeflection: 1e-3 });
  assert.ok(r.diagnostics.some((x) => /^\d+ faces failed with refinement stopped at their point cap$/.test(x.message)),
    JSON.stringify(r.diagnostics));
  assert.ok(r.diagnostics.some((x) => x.severity === 'error' && /faces failed to mesh/.test(x.message)));
  assert.ok(!r.diagnostics.some((x) => /seam whose side/.test(x.message)));
  const u = new CadioTessellator();
  await u.init();
  const ru = await u.tessellate({ ...req('spheres'), linearDeflection: 1e-3 });
  assert.ok(!ru.diagnostics.some((x) => /point cap/.test(x.message)));
});

test('init({failCapped, failTurnedOver, keepDefects}): false keeps a capped face, meshed; without keepDefects it '
  + 'fails, with it (the default) it\'s kept and said', { skip }, async () => {
  const faces = async (opts: { failCapped?: boolean; keepDefects?: boolean }) => {
    const t = new CadioTessellator();
    await t.init({ maxPointsPerFace: 20, checkDeviation: false, ...opts });
    const r = await t.tessellate({ ...req('spheres'), linearDeflection: 1e-3 });
    return { failed: r.diagnostics.some((x) => x.severity === 'error' && /faces failed to mesh/.test(x.message)),
      kept: keptDefects(r) };
  };
  assert.equal((await faces({ keepDefects: false })).failed, true);
  assert.equal((await faces({ failCapped: false, keepDefects: false })).failed, false);
  // (Its deviation not checked here: kept for the cap alone.)
  const kept = await faces({});
  assert.equal(kept.failed, false);
  assert.deepEqual([...kept.kept.values()], ['at its point cap']);
  // torusOuterHalf with next to no refinement: a triangle turned against its surface, failing its face but with
  // failTurnedOver false.
  const turned = async (failTurnedOver: boolean) => {
    const t = new CadioTessellator();
    await t.init({ maxPointsPerFace: 1, failCapped: false, checkDeviation: false, failTurnedOver, keepDefects: false });
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(torusOuterHalf().finish().buffer),
      linearDeflection: 0.1 });
    return r.diagnostics.some((x) => x.severity === 'error' && /faces failed to mesh/.test(x.message));
  };
  assert.equal(await turned(true), true);
  assert.equal(await turned(false), false);
});

test('a request\'s analysis read (info.readsAnalysis): an edge past repair met as any other, its faces meshed, its '
  + 'distance (at its tolerance, within the deflection here) no defect, its samples neither respaced nor split',
{ skip }, async () => {
  const t = new CadioTessellator();
  await t.init();
  assert.equal(t.info.readsAnalysis, true);
  const data = new Uint8Array(TESS_MODELS.poleLunes().finish().buffer);
  const run = (analysis?: Uint8Array) => t.tessellate({ ...req('cube'), data, linearDeflection: 0.01,
    ...(analysis ? { analysis } : {}) });
  const healed = await run(ANALYSES.lunesEdgePast!.data()), plain = await run();
  assert.equal(failedCauses(healed).size, 0);
  assert.equal(keptDefects(healed).size, 0);
  assert.ok(healed.indices.length > 0 && healed.indices.length < plain.indices.length);
});

test('init({develop}): false meshes each face in (u, v), true (the default) in its developed plane where that is the '
  + 'nearer isotropic frame', { skip }, async () => {
  // (cylinderVast, radius 8000: u in radians, so its developed plane divides its metric's stretch by the radius.)
  const data = new Uint8Array(TESS_MODELS.cylinderVast().finish().buffer);
  const mesh = async (opts: { develop?: boolean }) => {
    const t = new CadioTessellator();
    await t.init(opts);
    const r = await t.tessellate({ ...req('cube'), data, linearDeflection: 0.1, edges: false });
    assert.equal(failedCauses(r).size, 0);
    return [...r.positions].join(',') + '|' + [...r.indices].join(',');
  };
  const plain = await mesh({}), developed = await mesh({ develop: true }), uv = await mesh({ develop: false });
  assert.equal(plain, developed);
  assert.notEqual(uv, developed);
});

test('an edge off its face\'s surface past max(d, tol): the face kept, the edge and its distance said, past the '
  + 'limits; with keepDefects off, failed for it', { skip }, async () => {
  // (edgeBulge: a 10 mm square whose top side is an arc 0.5 over it, its use placed on its feet: 50 x 0.01.)
  const data = new Uint8Array(TESS_MODELS.edgeBulge().finish().buffer);
  const run = async (keepDefects: boolean) => {
    const t = new CadioTessellator();
    await t.init({ keepDefects });
    return t.tessellate({ ...req('cube'), data, linearDeflection: 0.01 });
  };
  const kept = await run(true);
  assert.equal(failedCauses(kept).size, 0);
  const what = '50 x the larger of d and tol, edge #0 0.5 mm off its surface, past the limits';
  assert.equal(keptDefects(kept).get(0), what);
  assert.deepEqual(kept.defects, [{ entityId: 0, pastLimits: true, what }]);
  assert.equal([...failedCauses(await run(false)).values()][0],
    'invalidModel: an edge (#0) 0.5 mm off its surface, 50 x max(d, tol)');
});

test('init({countAngles}): the faces\' triangles under the minimum angle said, by angle; none without it',
  { skip }, async () => {
  const run = async (countAngles: boolean) => {
    const t = new CadioTessellator();
    await t.init({ countAngles, minAngle: 0.4 });
    // (A plane's cusps: triangles under the angle whatever the metric.)
    return (await t.tessellate({ ...req('cube'), data: new Uint8Array(cuspPocket_().finish().buffer),
      linearDeflection: 0.01 })).diagnostics.map((x) => x.message);
  };
  const re = /^\d+ faces with triangles under the minimum angle: (\d+) triangles \(by degrees: under 1 \d+, 1-2 \d+, /;
  const said = (await run(true)).map((x) => re.exec(x)).find((x) => x);
  assert.ok(said && Number(said[1]) > 0, String(said));
  assert.ok(!(await run(false)).some((x) => re.test(x)));
});

test('init({countRounds}): the part\'s split rounds said (none on a cube\'s planes, some on spheres meshed fine, '
  + 'at most the cap); nothing without it', { skip }, async () => {
  const rounds = async (countRounds: boolean, name: keyof typeof MODELS, linearDeflection: number) => {
    const t = new CadioTessellator();
    await t.init({ countRounds });
    const said = (await t.tessellate({ ...req(name), linearDeflection })).diagnostics.map((x) =>
      new RegExp(`^${ROUNDS_HEAD}(\\d+)$`).exec(x.message)).filter((x) => x);
    return said.length === 1 ? Number(said[0]![1]) : said.length ? NaN : undefined;
  };
  assert.equal(await rounds(true, 'cube', 0.1), 0);
  const fine = await rounds(true, 'spheres', 0.001);
  assert.ok(fine! >= 1 && fine! <= 24, String(fine));
  assert.equal(await rounds(false, 'spheres', 0.001), undefined);
});

test('init({listPoles}): every face\'s poles as its closed surface has them, 5 numbers each, in the part\'s '
  + 'coordinates (the spheres\' surfaces\' poles, those their faces reach at a mesh vertex; none on a cube); nothing '
  + 'without it', { skip }, async () => {
  const poles = async (listPoles: boolean, name: keyof typeof MODELS) => {
    const t = new CadioTessellator();
    await t.init({ listPoles });
    const r = await t.tessellate(req(name));
    const said = r.diagnostics.filter((x) => x.message.startsWith(POLES_HEAD));
    return { r, said: said.length ? JSON.parse(said[0]!.message.slice(POLES_HEAD.length)) as number[] : undefined,
      count: said.length };
  };
  assert.deepEqual((await poles(true, 'cube')).said, []);
  const { r, said, count } = await poles(true, 'spheres');
  assert.equal(count, 1);
  assert.ok(said!.length >= 5 && said!.length % 5 === 0, String(said!.length));
  // (A surface's poles, whether its face reaches them or not: those it does at a vertex of the mesh.)
  let atVertex = 0;
  for (let k = 0; k < said!.length; k += 5) {
    const p = said!.slice(k + 2, k + 5);
    let nearest = Infinity;
    for (let i = 0; i < r.positions.length / 3; i++)
      nearest = Math.min(nearest, Math.hypot(...[0, 1, 2].map((c) => r.positions[3 * i + c]! + r.origin[c]! - p[c]!)));
    atVertex += nearest < 1e-4 ? 1 : 0;
  }
  assert.ok(atVertex >= 1, String(atVertex));
  assert.equal((await poles(false, 'spheres')).said, undefined);
});

test('init({minAngle}): the mesher\'s target smallest angle, 10 degrees by default, more triangles at 0.5 rad',
  { skip }, async () => {
  const count = async (minAngle?: number) => {
    const t = new CadioTessellator();
    await t.init(minAngle === undefined ? {} : { minAngle });
    return (await t.tessellate({ ...req('spheres'), linearDeflection: 0.01 })).indices.length / 3;
  };
  const [none, byDefault, tenDegrees, shaped] = [await count(0), await count(), await count(Math.PI / 18),
    await count(0.5)];
  assert.equal(byDefault, tenDegrees);
  assert.notEqual(byDefault, none);
  assert.ok(shaped > byDefault && shaped > none, `${none}, ${byDefault}, ${shaped}`);
  // A request's own minAngle (cad-scene's TessellationRequest) in place of init's, for that request.
  const t = new CadioTessellator();
  await t.init();
  const own = async (minAngle: number) =>
    (await t.tessellate({ ...req('spheres'), linearDeflection: 0.01, minAngle })).indices.length / 3;
  assert.equal(await own(0.5), shaped);
  assert.equal(await own(0), none);
});

test('init({maxEdge}): no triangle edge longer than that fraction of the part\'s size (partSize); none by default',
  { skip },
  async () => {
  // (longPlate: 100 by 4, its size the diagonal.)
  const data = new Uint8Array(TESS_MODELS.longPlate().finish().buffer), size = Math.hypot(100, 4);
  const longest = async (maxEdge?: number) => {
    const t = new CadioTessellator();
    await t.init(maxEdge === undefined ? {} : { maxEdge });
    const r = await t.tessellate({ format: 'cad-brep', data, linearDeflection: 0.1, angularDeflection: 0.26 });
    assert.equal(r.faces.filter((f) => f.count === 0).length, 0);
    let l = 0;
    const p = r.positions, ix = r.indices;
    for (let k = 0; k < ix.length; k += 3)
      for (let j = 0; j < 3; j++) {
        const a = 3 * ix[k + j]!, b = 3 * ix[k + (j + 1) % 3]!;
        l = Math.max(l, Math.hypot(p[a]! - p[b]!, p[a + 1]! - p[b + 1]!, p[a + 2]! - p[b + 2]!));
      }
    return l;
  };
  const t = new CadioTessellator();
  await t.init();
  assert.ok(Math.abs(t.partSize(data) - size) <= 1e-9 * size, String(t.partSize(data)));
  assert.throws(() => t.partSize(new Uint8Array(16)), /not a cad-brep model/);
  const limit = 0.03 * size, capped = await longest(0.03);
  assert.ok(capped <= limit * (1 + 1e-6) && capped > 0.5 * limit, `${capped} against ${limit}`);
  for (const off of [undefined, 0]) assert.ok(await longest(off) > 4 * limit);
});

test('refinement blocked by a pole ring\'s fixed segment, said with the face and its rounds: bentApex at 0.01; ' +
  'not at 0.05', { skip }, async () => {
  // (At 0.35 rad: at the 10-degree default bentApex at 0.05 asks a ring segment split once too.)
  const t = new CadioTessellator();
  await t.init({ checkDeviation: false, minAngle: 0.35 });
  const re = /^1 faces with refinement blocked by a fixed ring segment: #\d+ \((\d+) rounds\)$/;
  const blocked = async (d: number) => {
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(bentApex().finish().buffer),
      linearDeflection: d });
    return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m)?.[1];
  };
  assert.ok(Number(await blocked(0.01)) >= 2);
  assert.equal(await blocked(0.05), undefined);
});

test('faces with deviations sampled, said: a B-spline dome\'s at its pole; a torus\'s inner half (bounded by its ' +
  'derivatives where its closed form fails), a sphere\'s, a B-spline\'s without a pole not',
  { skip }, async () => {
    const t = await tessellator();
    const re = /^(\d+) faces meshed with their deviation from the surface sampled, not bounded/;
    const sampled = async (data: Uint8Array) => {
      const r = await t.tessellate({ ...req('cube'), data });
      return r.diagnostics.map((x) => re.exec(x.message)).find((m) => m)?.[1];
    };
    assert.equal(await sampled(new Uint8Array(torusOuterHalf().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(bsplineDome().finish().buffer)), '1');
    assert.equal(await sampled(new Uint8Array(bumpPatch().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(MODELS.seamCylinder().finish().buffer)), undefined);
    assert.equal(await sampled(new Uint8Array(MODELS.spheres().finish().buffer)), undefined);
  });

test('faces failed to mesh, each by status and cause: a plane with no loops (no natural extent); its sphere meshed',
  { skip }, async () => {
    const t = await tessellator();
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(loopless().finish().buffer) });
    assert.equal(r.faces.length, 2);
    assert.equal(r.faces[0]!.count, 0);
    assert.ok(r.faces[1]!.count > 0);
    const m = r.diagnostics.find((x) => x.message.startsWith(CAUSES_HEAD));
    assert.ok(m, JSON.stringify(r.diagnostics));
    const cause = 'unsupported: no edge loops, and its surface\'s natural extent doesn\'t close (a whole plane, '
      + 'cylinder or cone)';
    assert.ok(m.message.startsWith(`faces failed to mesh, by cause: ${cause} 1 (#`), m.message);
    // Read back (causes.ts): the failed face's id (0: the test model's faces have none) to its cause, nothing for the
    // one meshed.
    assert.deepEqual([...failedCauses(r)], [[0, cause]]);
  });

test('failedCauses: each entry\'s faces to its "status: cause", a cause holding colons, digits and brackets kept '
  + 'whole; other diagnostics and malformed entries left out', () => {
  const d = (message: string) => ({ message });
  // (A message without the head, its length's worth of other words before one that would read as an entry.)
  const got = failedCauses({ diagnostics: [d('3 faces failed to mesh: #1, #2, #30'),
    d(`${'x'.repeat(CAUSES_HEAD.length)}other: words 1 (#5)`),
    d(`${CAUSES_HEAD}noConvergence: meshed past its deflection: at least 1.5 x (0.2 mm) 2 (#1, #30); `
      + 'singular: a seam\'s side (u, v) 1 (#2); bad entry; unknown: x 1 (#)'),
    d(`${CAUSES_HEAD}invalidModel: y 1 (#7)`)] });
  assert.deepEqual([...got], [[1, 'noConvergence: meshed past its deflection: at least 1.5 x (0.2 mm)'],
    [30, 'noConvergence: meshed past its deflection: at least 1.5 x (0.2 mm)'], [2, 'singular: a seam\'s side (u, v)'],
    [7, 'invalidModel: y']]);
  assert.equal(failedCauses({ diagnostics: [] }).size, 0);
});

test('keptDefects: each kept face\'s id to its defects as said; other diagnostics left out', () => {
  const d = (message: string) => ({ message });
  const got = keptDefects({ diagnostics: [d('2 faces kept: #1 (x)'), d(`${KEPT_HEAD}3 (#4 (2 triangles turned), `
    + '#12 (1.4 x the larger of d and tol, at its point cap), #7 (at its point cap))')] });
  assert.deepEqual([...got], [[4, '2 triangles turned'], [12, '1.4 x the larger of d and tol, at its point cap'],
    [7, 'at its point cap']]);
  assert.equal(keptDefects({ diagnostics: [] }).size, 0);
});

test('progress: each face as it starts, throttled to one report per 100 ms; a real part reports its faces', { skip },
  async () => {
    // The reporter's rate, by a clock of its own: of reports at 0, 50, 99, 100, 150 and 250 ms, those at 0, 100, 250.
    let clock = 0;
    const got: TessellationProgress[] = [];
    const report = progressReporter((p) => got.push(p), 100, () => clock);
    for (const [t, row] of [[0, 0], [50, 1], [99, 2], [100, 3], [150, 4], [250, 5]] as const) {
      clock = t;
      report(3, row + 10, row, 0, row, 6);
    }
    assert.deepEqual(got.map((p) => p.row), [0, 3, 5]);
    assert.equal(got[1]!.message, 'face #13 (row 3), first pass, 3 of 6 faces done');
    assert.deepEqual({ ...got[2], message: undefined }, { message: undefined, faceId: 15, row: 5, round: 0,
      facesDone: 5, facesTotal: 6 });
    report(3, 0, 7, 2, 1, 4);
    clock = 400;
    report(3, 0, 7, 2, 1, 4);
    assert.equal(got.at(-1)!.message, 'a face with no id (row 7), split round 2, 1 of 4 faces done');
    clock = 600;
    report(1, 0, -1, 0, 5, 40);
    assert.deepEqual(got.at(-1), { message: 'sampling edges: an edge, 5 of 40 edges and uses done', round: 0 });
    clock = 800;
    report(1, 21, 3, 0, 30, 40);
    assert.deepEqual(got.at(-1), { message: 'sampling edges: a use on face #21 (row 3), 30 of 40 edges and uses done',
      faceId: 21, row: 3, round: 0 });
    // The deviation check after the rounds (part.h's PartProgress::deviation), its face and the faces checked so far.
    clock = 1000;
    report(5, 21, 3, 2, 3, 6);
    assert.deepEqual(got.at(-1), { message: 'checking meshes\' deviation: face #21 (row 3), 3 of 6 faces done',
      faceId: 21, row: 3, round: 2, facesDone: 3, facesTotal: 6 });
    // Across a real part (the cube's 6 faces, quick: the first report only), its first phase on its first face.
    const t = await tessellator();
    const seen: TessellationProgress[] = [];
    const r = await t.tessellate(req('cube'), (p) => seen.push(p));
    assert.ok(r.indices.length > 0);
    assert.ok(seen.length >= 1);
    assert.match(seen[0]!.message, /^making surfaces: face #\d+ \(row 0\), 0 of 6 done$/);
    assert.equal(seen[0]!.faceId, r.faces[0]!.entityId);
  });

test('the origin subtracted in double precision; without edges, none', { skip }, async () => {
  const t = await tessellator();
  const a = await t.tessellate(req('cube'));
  const b = await t.tessellate(req('cube', { origin: [0.5, -1, 2], edges: false }));
  assert.equal(b.edges, undefined);
  assert.deepEqual(b.origin, [0.5, -1, 2]);
  assert.equal(a.positions.length, b.positions.length);
  const o = [0.5, -1, 2];
  for (let i = 0; i < a.positions.length; i++) {
    assert.ok(Math.abs(b.positions[i]! - (a.positions[i]! - o[i % 3]!)) <= 1e-6, `coordinate ${i}`);
  }
});

test('the same part gives the same bytes: twice in one instance, and in a fresh one', { skip }, async () => {
  const t = await tessellator(), u = await tessellator();
  for (const name of ['cube', 'seamCylinder', 'spheres'] as const) {
    const a = bytes(await t.tessellate(req(name))), b = bytes(await t.tessellate(req(name)));
    const c = bytes(await u.tessellate(req(name)));
    assert.equal(a, b, name);
    assert.equal(a, c, name);
  }
});

test('bytes that aren\'t a model: an error, no triangles', { skip }, async () => {
  const t = await tessellator();
  const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(64) });
  assert.equal(r.indices.length, 0);
  assert.match(r.diagnostics[0]!.message, /not a cad-brep model/);
});

test('a loop against its face\'s sense (a projected seam use\'s side contradicting it): meshed, reported with its id',
  { skip }, async () => {
  const t = await tessellator();
  const run = async (model: { finish(): { buffer: ArrayBuffer } }) => t.tessellate({ ...req('cube'),
    data: new Uint8Array(model.finish().buffer) });
  const flipped = await run(seamFlipped());
  assert.ok(flipped.indices.length > 0);
  const d = flipped.diagnostics.find((x) => /loop against the face's sense/.test(x.message));
  assert.ok(d, JSON.stringify(flipped.diagnostics));
  assert.match(d.message, /^1 faces .*: faces \d+$/);
  const valid = await run(seamByInversion());
  assert.ok(!valid.diagnostics.some((x) => /loop against the face's sense/.test(x.message)));
});

test('uses traced sample by sample: a local step that fell back on the global search said, with its edge and why',
  { skip }, async () => {
  // uFoldFar, projection off: its loop's middle 3 mm off its arm, past the tolerance and the spacing, so the samples
  // after its vertex fall back; uFold's 0.07 stays local, nothing said.
  const t = new CadioTessellator();
  await t.init({ projectMissingPcurves: false });
  const said = async (model: { finish(): { buffer: ArrayBuffer } }) => {
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(model.finish().buffer), linearDeflection: 0.1,
      angularDeflection: 0.26 });
    return r.diagnostics.find((x) => /fell back on the global search/.test(x.message));
  };
  assert.equal(await said(uFold()), undefined);
  const d = await said(uFold(-3));
  assert.ok(d);
  assert.equal(d.severity, 'info');
  assert.match(d.message, /^\d+ samples of uses traced sample by sample fell back on the global search \(\d+ traced /);
  assert.match(d.message, /edge \d+ at [\d.e-]+ \([\d.e-]+ off\): the local foot farther from the surface/);
});

test('uses without p-curves counted by how they were sampled, said where one fell back to the edge\'s tolerance',
  { skip }, async () => {
  const t = await tessellator();
  const counts = async (l: number) => {
    const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(affineFeetOff().finish().buffer),
      linearDeflection: l, angularDeflection: 0.26 });
    const re = /^(\d+) uses without p-curves: (\d+) projected .*, (\d+) at the edge's .*, (\d+) by/;
    const m = r.diagnostics.map((x) => re.exec(x.message)).find((x) => x);
    return m?.slice(1).map(Number);
  };
  // At 0.05 every use within 2.5e-3 of its feet (the side 1.5e-3 to 2.1e-3 off): nothing said; at 1e-3, the side
  // only at its tolerance (5e-5 under its gap), said.
  assert.equal(await counts(0.05), undefined);
  const c = await counts(1e-3);
  assert.ok(c);
  const [n, within, atTol, inverted] = c as [number, number, number, number];
  assert.deepEqual([n, inverted], [4, 0]);
  assert.ok(atTol >= 1 && within + atTol === 4, `${within}, ${atTol}`);
});

test('init({countInsertions}): the points inserted by what queued them, said; the mesh the same; off by default',
  { skip }, async () => {
    const run = async (on: boolean | undefined, data: Uint8Array) => {
      const t = new CadioTessellator();
      await t.init(on === undefined ? {} : { countInsertions: on });
      return t.tessellate({ ...req('cube'), data, edges: false });
    };
    const counts = (r: TessellationResult) => {
      const d = r.diagnostics.filter((x) => x.message.startsWith(INSERTED_HEAD));
      if (!d.length) return undefined;
      assert.equal(d.length, 1);
      assert.equal(d[0]!.severity, 'info');
      const parts = d[0]!.message.slice(INSERTED_HEAD.length).split(', ');
      assert.deepEqual(parts.map((x) => x.slice(0, x.lastIndexOf(' '))), INSERTED_KINDS);
      return new Map(parts.map((x) => [x.slice(0, x.lastIndexOf(' ')), Number(x.slice(x.lastIndexOf(' ') + 1))]));
    };
    // Independently: a face's vertices off its boundary in its triangles (no seam, pole or split boundary on these).
    const interior = (r: TessellationResult) => {
      let n = 0;
      for (const f of r.faces) {
        const used = new Set<number>(), side = new Map<string, number>();
        for (let k = f.start; k < f.start + f.count; k += 3) {
          for (let c = 0; c < 3; c++) {
            const a = r.indices[k + c]!, b = r.indices[k + (c + 1) % 3]!;
            used.add(a);
            const key = a < b ? `${a},${b}` : `${b},${a}`;
            side.set(key, (side.get(key) ?? 0) + 1);
          }
        }
        const boundary = new Set([...side].filter(([, m]) => m === 1).flatMap(([k]) => k.split(',').map(Number)));
        n += [...used].filter((v) => !boundary.has(v)).length;
      }
      return n;
    };
    const sum = (c: Map<string, number>) => [...c.values()].reduce((a, b) => a + b, 0);
    for (const [name, data] of [['bumpPatch', bumpPatch()], ['knotAtEnd', knotAtEnd()]] as const) {
      const bytesOf = new Uint8Array(data.finish().buffer);
      const on = await run(true, bytesOf), off = await run(false, bytesOf), dflt = await run(undefined, bytesOf);
      const c = counts(on);
      assert.ok(c, name);
      assert.equal(sum(c), interior(on), name);
      assert.ok(sum(c) > 0, name);
      // (A B-spline has no closed form.)
      assert.equal(c.get('deviation in closed form'), 0, name);
      assert.equal(counts(off), undefined), assert.equal(counts(dflt), undefined);
      const strip = (r: TessellationResult) => ({ ...r, diagnostics: r.diagnostics.filter((x) =>
        !x.message.startsWith(INSERTED_HEAD)) });
      assert.equal(bytes(strip(on)), bytes(off), name);
    }
    // A sphere's deviation is in closed form: some by it, none sampled or bounded.
    const sp = counts(await run(true, new Uint8Array(MODELS.spheres().finish().buffer)))!;
    assert.ok(sp.get('deviation in closed form')! > 0);
    assert.equal(sp.get('deviation sampled'), 0), assert.equal(sp.get('deviation bounded'), 0);
  });

test('init({countExpected}): each meshed face\'s triangles as its size metric expects them beside its mesh\'s, 3 '
  + 'numbers a face; the same mesh; nothing without it', { skip }, async () => {
  const run = async (countExpected: boolean) => {
    const t = new CadioTessellator();
    await t.init({ countExpected });
    const r = await t.tessellate(req('spheres'));
    const said = r.diagnostics.filter((x) => x.message.startsWith(EXPECTED_HEAD));
    return { r, said };
  };
  const on = await run(true), off = await run(false);
  assert.equal(off.said.length, 0);
  assert.equal(on.said.length, 1);
  const rows = JSON.parse(on.said[0]!.message.slice(EXPECTED_HEAD.length)) as number[];
  assert.equal(rows.length, 3 * on.r.faces.length);
  // (In the faces' order; the fixture's faces have no ids.)
  for (let k = 0; k < rows.length; k += 3) {
    assert.ok(rows[k + 1]! > 0);
    assert.equal(rows[k + 2], on.r.faces[k / 3]!.count / 3);
  }
  assert.deepEqual([...on.r.indices], [...off.r.indices]);
  // Faces failed at their point cap still there, with 0 meshed.
  const t = new CadioTessellator();
  await t.init({ countExpected: true, maxPointsPerFace: 50, keepDefects: false });
  const capped = await t.tessellate(req('spheres'));
  const failed = failedCauses(capped);
  assert.ok(failed.size > 0 && [...failed.values()].every((c) => /point cap/.test(c)), JSON.stringify([...failed]));
  const said = capped.diagnostics.find((x) => x.message.startsWith(EXPECTED_HEAD));
  const cappedRows = JSON.parse(said!.message.slice(EXPECTED_HEAD.length)) as number[];
  assert.equal(cappedRows.length, rows.length);
  for (let k = 0; k < cappedRows.length; k += 3) assert.ok(cappedRows[k + 1]! > 0);
  assert.ok(cappedRows.some((x, k) => k % 3 === 2 && x === 0));
});

test('a face bounded by holes only (sphereBelt\'s belt between two circles) said in an info diagnostic, meshed as '
  + 'its surface less them; none on a cube', { skip }, async () => {
  const t = new CadioTessellator();
  await t.init();
  const said = async (data: Uint8Array) => (await t.tessellate({ ...req('cube'), data })).diagnostics
    .filter((x) => x.message.includes('bounded by holes only'));
  const belt = await said(new Uint8Array(TESS_MODELS.sphereBelt().finish().buffer));
  assert.equal(belt.length, 1);
  assert.match(belt[0]!.message,
    /^1 faces bounded by holes only, meshed as their surface's natural extent less them: faces \d+$/);
  assert.equal(belt[0]!.severity, 'info');
  assert.equal((await said(new Uint8Array(MODELS.cube().finish().buffer))).length, 0);
});

test('an apex\'s fan consistent along its chain: bsplineApexHole meshed by default (failFoldedFans on), '
  + 'its triangles at the apex manifold', { skip }, async () => {
  // (bsplineApexHole at 1e-3 mm and 0.1 rad: its apex's fan folded, 2 edges used twice the same way welded; either
  // its far ends' corners left out or its triangles each against the mesher's use of their ring segment mends it.)
  const t = new CadioTessellator();
  await t.init({ checkDeviation: false });
  const r = await t.tessellate({ ...req('cube'), data: new Uint8Array(bsplineApexHole().finish().buffer),
    linearDeflection: 1e-3, angularDeflection: 0.1 });
  assert.equal(failedCauses(r).size, 0);
  const key = (i: number) => [0, 1, 2].map((c) => r.positions[3 * i + c]).join(',');
  const used = new Map<string, number>();
  for (let k = 0; k < r.indices.length; k += 3) for (let i = 0; i < 3; i++) {
    const e = key(r.indices[k + i]!) + '>' + key(r.indices[k + (i + 1) % 3]!);
    used.set(e, (used.get(e) ?? 0) + 1);
  }
  assert.ok(r.indices.length > 0);
  assert.deepEqual([...used].filter(([, n]) => n > 1), []);
});

test('bsplineApexHole, its hole within its tolerance of the apex, meshes manifold with both rules against folds off '
  + '(its ring cut exactly into every edge: no fan to fold); failFoldedFans changes nothing', { skip }, async () => {
  // (At 1e-3 mm and 0.1 rad its ring's reach is under the part's tolerance: cut where its crossings are, the fan
  // stays on its side of the ring.)
  const data = new Uint8Array(bsplineApexHole().finish().buffer);
  const run = async (failFoldedFans?: boolean) => {
    const t = new CadioTessellator();
    await t.init({ checkDeviation: false, consistentFans: false, apexCorners: false,
      ...(failFoldedFans === undefined ? {} : { failFoldedFans }) });
    return t.tessellate({ ...req('cube'), data, linearDeflection: 1e-3, angularDeflection: 0.1 });
  };
  for (const r of [await run(), await run(false)]) {
    assert.equal(failedCauses(r).size, 0);
    assert.ok(r.indices.length > 0);
    const key = (i: number) => [0, 1, 2].map((c) => r.positions[3 * i + c]).join(',');
    const used = new Map<string, number>();
    for (let k = 0; k < r.indices.length; k += 3) for (let i = 0; i < 3; i++) {
      const e = key(r.indices[k + i]!) + '>' + key(r.indices[k + (i + 1) % 3]!);
      used.set(e, (used.get(e) ?? 0) + 1);
    }
    assert.deepEqual([...used].filter(([, n]) => n > 1), []);
  }
});

test('a pole whose row reaches as far as its ring gets no fan: poleRowFan meshed, whatever '
  + 'consistentFans and apexCorners', { skip }, async () => {
  // (poleRowFan at medium: VW #2452's #298974, its pole a row 0.12 long, its ring's reach 0.11: folded with a fan.)
  const data = new Uint8Array(poleRowFan().finish().buffer);
  for (const fans of [{}, { consistentFans: false, apexCorners: false }] as Record<string, boolean>[]) {
    const t = new CadioTessellator();
    await t.init(fans);
    const r = await t.tessellate({ ...req('cube'), data, linearDeflection: 0.1,
      angularDeflection: 15 * Math.PI / 180 });
    assert.equal(failedCauses(r).size, 0);
    assert.ok(r.indices.length > 0);
  }
});

test('init({capFloor, capMultiple, capCeiling}): a face past max(floor, multiple x its expected triangles) fails, '
  + 'its cap and expected count in the cause; by the defaults it meshes', { skip }, async () => {
  // (bumpPatch at 1e-3 mm meshes some 33,000 triangles against about 4,500 expected.)
  const data = new Uint8Array(bumpPatch().finish().buffer);
  const run = async (opts: { capFloor?: number; capMultiple?: number; capCeiling?: number }) => {
    const t = new CadioTessellator();
    await t.init({ ...opts, keepDefects: false });
    return t.tessellate({ ...req('cube'), data, linearDeflection: 1e-3, angularDeflection: 0.26 });
  };
  const tight = failedCauses(await run({ capFloor: 1000, capMultiple: 1 }));
  assert.equal(tight.size, 1);
  assert.match([...tight.values()][0]!,
    /^noConvergence: refinement stopped at its point cap, \d+ triangles \(its cap \d+: \d+ expected\)$/);
  assert.equal(failedCauses(await run({})).size, 0);
  assert.equal(failedCauses(await run({ capFloor: 1000, capMultiple: 1, capCeiling: 500 })).size, 1);
});
