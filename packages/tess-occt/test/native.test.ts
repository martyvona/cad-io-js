// The native route (native/occt_build.cpp): a part's cad-brep buffer built into OCCT's shapes, checked against the STEP
// route (the same model written as STEP and read by OCCT's reader), face by face. Needs the built module (./build.sh);
// the corpus file's test needs the corpus (test_corpus/third_party/pull.sh). Skipped without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, brepToJson, openBrep } from 'cad-brep';
import type { Curve } from 'cad-brep';
import type { TessellationRequest, TessellationResult } from 'cad-scene';
import { StepTessellator } from 'step-export';
import { importStep } from 'step-import';
import { MODELS } from '../../cad-brep/test/models.ts';
import { OcctTessellator } from '../src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const built = fs.existsSync(path.join(import.meta.dirname, '../dist/occt_tess.wasm'));
const skip = built ? false : 'tess-occt not built (run packages/tess-occt/build.sh)';
const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };

let routes: Promise<{ step: StepTessellator; native: OcctTessellator }> | undefined;
function both() {
  return routes ??= (async () => {
    const step = new StepTessellator(new OcctTessellator()), native = new OcctTessellator({ route: 'native' });
    await step.init();
    await native.init();
    return { step, native };
  })();
}
const request = (data: Uint8Array, unit = 1): TessellationRequest => ({ format: 'cad-brep', data, origin: [0, 0, 0],
  linearDeflection: 0.01 / unit, angularDeflection: 0.5, measures: true, edges: true });

/** Each face's triangles by id: their count, area, and area vector (the sum of their normals by area: the side
 * faced). */
function faces(r: TessellationResult) {
  // (Faces without an id by their place: n0, n1, ...)
  const out = new Map<number | string, { tris: number; area: number; normal: number[] }>();
  let unnamed = 0;
  const P = (j: number) => [0, 1, 2].map((c) => r.positions[3 * r.indices[j]! + c]!);
  for (const f of r.faces) {
    let area = 0;
    const normal = [0, 0, 0];
    for (let t = f.start; t < f.start + f.count; t += 3) {
      const [a, b, c] = [P(t), P(t + 1), P(t + 2)];
      const u = b.map((x, k) => x - a![k]!), w = c.map((x, k) => x - a![k]!);
      const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
      area += Math.hypot(...n) / 2;
      for (let k = 0; k < 3; k++) normal[k]! += n[k]! / 2;
    }
    out.set(f.entityId ?? `n${unnamed++}`, { tris: f.count / 3, area, normal });
  }
  return out;
}
/** The two routes' results the same face by face: ids, triangles, meshed area, OCCT's measures (to `tol` of a face's
 * area). */
function same(a: TessellationResult, b: TessellationResult, what: string, tol = 1e-9, data?: Uint8Array) {
  // Face ids the model hasn't: the STEP route's its writer's, the native route's none.
  const json = data && brepToJson(openBrep(data));
  const faceIds = json && new Set(json.faces.map((f) => f.id).filter((id) => id !== undefined));
  const known = (r: TessellationResult) => faceIds ? { ...r, faces: r.faces.map((f) => ({ ...f,
    entityId: f.entityId !== null && faceIds.has(f.entityId) ? f.entityId : null })) } : r;
  const fa = faces(known(a)), fb = faces(known(b));
  assert.deepEqual([...fb.keys()].map(String).sort(), [...fa.keys()].map(String).sort(), `${what}: face ids`);
  for (const [id, x] of fa) {
    const y = fb.get(id)!;
    assert.equal(y.tris, x.tris, `${what}: face #${id}'s triangles`);
    assert.ok(Math.abs(y.area - x.area) <= tol * Math.max(x.area, 1), `${what}: face #${id}'s area`);
    assert.ok(Math.hypot(...y.normal.map((c, k) => c - x.normal[k]!)) <= tol * Math.max(x.area, 1),
      `${what}: face #${id}'s side: ${y.normal} vs ${x.normal}`);
  }
  // The edges by id, with their kinds and points; the STEP route's ids for the model's edges without one (its
  // writer's) as the native route's, none.
  const ids = json && new Set(json.edges.map((e) => e.id).filter((id) => id !== undefined));
  const edges = (r: TessellationResult) => (r.edges ?? []).map((e) =>
    `${e.entityId !== null && ids?.has(e.entityId) !== false ? e.entityId : null} ${e.kind} ${e.count}`).sort();
  assert.deepEqual(edges(b), edges(a), `${what}: edges`);
  // OCCT's measures of the faces with the model's ids (by id: none for the others).
  const measured = (r: TessellationResult) => (r.measures ?? []).filter((m) => faceIds?.has(m.entityId) !== false);
  const ma = new Map(measured(a).map((m) => [m.entityId, m]));
  assert.equal(measured(b).length, measured(a).length, `${what}: measures`);
  for (const m of measured(b)) {
    const n = ma.get(m.entityId)!;
    assert.ok(Math.abs(m.area - n.area) <= tol * Math.max(n.area, 1), `${what}: face #${m.entityId}'s measure`);
    assert.equal(m.valid, n.valid, `${what}: face #${m.entityId}'s soundness`);
  }
}

test('the native route: the test models it builds meshed as the STEP route meshes them, face by face', { skip },
  async () => {
    const { step, native } = await both();
    assert.match(native.info.version, /native builder/);
    assert.deepEqual(native.info.formats, ['cad-brep', 'step']);
    for (const name of ['cube', 'withVoid', 'seamCylinder'] as const) {
      const req = request(new Uint8Array(MODELS[name]().finish().buffer));
      const a = await step.tessellate(req), b = await native.tessellate(req);
      assert.ok(b.indices.length > 0, name);
      assert.deepEqual(b.diagnostics.filter((d) => d.severity !== 'info'), [], name);
      same(a, b, name, 1e-9, req.data);
    }
  });

test('the native route: a part with a kind not built yet fails with an error and nothing meshed', { skip },
  async () => {
    const { native } = await both();
    for (const [name, kind] of [['facetedAndWire', 'a wire body'], ['everyKind', 'a curve item']] as const) {
      const r = await native.tessellate(request(new Uint8Array(MODELS[name]().finish().buffer)));
      assert.equal(r.indices.length, 0, name);
      assert.deepEqual(r.faces, [], name);
      assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
        [`native builder: not built yet: ${kind}`], name);
    }
  });

test('the native route: a face on a swept surface (no counterpart in OCCT) left out with a warning, the rest meshed',
  { skip }, async () => {
    const { native } = await both();
    // A face set: a unit square in z = 0, and a face on a curve-swept surface sharing its edges.
    const b = new BrepBuilder({ unit: 1 });
    const corners = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = corners.map((point) => b.addVertex({ point }));
    const sides = corners.map((a, j) => {
      const c = corners[(j + 1) % 4]!, direction = [c[0]! - a[0]!, c[1]! - a[1]!, 0];
      return b.addEdge({ curve: b.addCurve({ kind: 'line', point: a, direction, magnitude: 1 }), start: vs[j]!,
        end: vs[(j + 1) % 4]!, sameSense: true, range: [0, 1] });
    });
    const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
    const swept = b.addSurface({ kind: 'curveSwept', curve: 0, directrix: 1, referenceSurface: plane });
    const loop = (orientation: 'forward' | 'reversed') => ({ kind: 'edge' as const, bound: 'outer' as const,
      sense: true, coedges: sides.map((edge) => ({ edge, orientation })) });
    const flat = b.addFace({ surface: plane, sameSense: true, loops: [loop('forward')], id: 7 });
    const other = b.addFace({ surface: swept, sameSense: true, loops: [loop('reversed')], id: 8 });
    const set = b.addShell({ kind: 'faceSet', faces: [{ face: flat, sense: true }, { face: other, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: set, sense: true }] }) });
    const r = await native.tessellate(request(new Uint8Array(b.finish().buffer)));
    assert.deepEqual(r.faces.map((f) => [f.entityId, f.count / 3]), [[7, 2]]);
    const warnings = r.diagnostics.filter((d) => d.severity === 'warning').map((d) => d.message);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /^native builder: .*#8.*no counterpart in OCCT/);
    assert.equal(r.diagnostics.filter((d) => d.severity === 'error').length, 0);
  });

test('the native route: formats it doesn\'t take are caller bugs; the STEP route takes no models', { skip },
  async () => {
    const { native } = await both();
    const step = new OcctTessellator();
    await step.init();
    const req = request(new Uint8Array(MODELS.cube().finish().buffer));
    await assert.rejects(step.tessellate(req), /format 'cad-brep' isn't taken by the step route/);
    await assert.rejects(native.tessellate({ ...req, format: 'iges' as 'step' }), /format 'iges'/);
  });

// Corpus files every part of which the native route builds, and their parts, with the kinds they bring: as1's solids;
// B-spline surfaces and curves, cones, spheres, tori; ellipses; faces sharing a surface (a hole's halves on one
// cylinder: a surface each, or their edges' p-curves clash); rational B-splines closed in a direction between two
// circles (periodic form, or healing splits them into empty faces); an edge of no length, which OCCT marks degenerated
// (not the model's: healing gives it its p-curve); tori and B-splines whose p-curves the model has (OCCT's healing
// doesn't make the same ones); lines beside their vertices, moved through them.
const corpus = [['gkv311-opencascade-dataset/step/as1-oc-214-mat.stp', 5],
  ['gkv311-opencascade-dataset/step/trj7_k1-ac-203.stp', 1],
  ['nist-pmi-models/NIST_MBE_PMI_FTC_Definitions/NIST_MBE_PMI_FTC_Definitions/nist_ftc_07_asme1_rd.stp', 1],
  ['nist-pmi-models/NIST_MBE_PMI_CTC_Definitions/NIST_MBE_PMI_CTC_Definitions/nist_ctc_04_asme1_rd.stp', 2],
  ['gkv311-opencascade-dataset/step/trj5_s1-ug-214.stp', 8],
  ['gkv311-opencascade-dataset/step/trj7_k1-id-214.stp', 1],
  ['gkv311-opencascade-dataset/step/r103ec.stp', 1], ['gkv311-opencascade-dataset/step/trj3_s1-db-214.stp', 8],
  ['gkv311-opencascade-dataset/step/bug25415_part_of_hdrv8w64p254_4x2_1016x502h838p.stp', 1]] as const;
const corpusPath = (f: string) => path.join(root, 'test_corpus/third_party', f);
test('the native route on corpus files: every part meshed as the STEP route meshes it', {
  skip: skip || (corpus.every(([f]) => fs.existsSync(corpusPath(f))) ? false : 'corpus not fetched') }, async () => {
  const { step, native } = await both();
  for (const [f, parts] of corpus) {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(corpusPath(f))));
    let n = 0;
    for (const p of scene.parts) {
      if (!p.brep) continue;
      const req = { ...request(new Uint8Array(p.brep.model.buffer), p.unit), origin: p.origin };
      // (To 1e-5: where healing adds an edge at a sphere's pole, last-bit differences between the model and OCCT's
      // reading of its text move the p-curves' ends there, u being undefined at a pole; nist_ctc_04 face #11486.)
      same(await step.tessellate(req), await native.tessellate(req), `${path.basename(f)} part #${p.sources[0]!.id}`,
        1e-5, req.data);
      n++;
    }
    assert.equal(n, parts, f);
  }
});

test('the native route: planar faces bounded by each curve kind, every way round, meshed as the STEP route meshes them',
  { skip }, async () => {
    const { step, native } = await both();
    type V3 = [number, number, number];
    // Part 42's points on each curve, to put vertices on them (curve placements all at the origin, x and y axes).
    const kinds: { name: string; curve: Curve; at: (t: number) => V3; t: [number, number]; ring?: V3[] }[] = [
      // The first semi-axis the minor one (OCCT's x axis is the major).
      { name: 'ellipse', curve: { kind: 'ellipse', position: XY, semiAxis1: 1, semiAxis2: 3 },
        at: (t) => [Math.cos(t), 3 * Math.sin(t), 0], t: [0.3, 2] },
      { name: 'hyperbola', curve: { kind: 'hyperbola', position: XY, semiAxis: 1, semiImagAxis: 2 },
        at: (t) => [Math.cosh(t), 2 * Math.sinh(t), 0], t: [-1, 0.7] },
      { name: 'parabola', curve: { kind: 'parabola', position: XY, focalDist: 0.5 },
        at: (t) => [0.5 * t * t, t, 0], t: [-1, 1.5] },
      { name: 'polyline', curve: { kind: 'polyline', points: [[0, 0, 0], [2, 0, 0], [2, 1, 0], [0.5, 2, 0]] },
        at: (t) => t === 1 ? [0, 0, 0] : [0.5, 2, 0], t: [1, 4] },
      { name: 'B-spline', curve: { kind: 'bspline', degree: 2, knots: [0, 0.5, 1], multiplicities: [3, 1, 3],
        poles: [[0, 0, 0], [1, 1.5, 0], [2, 2, 0], [3, 0, 0]], closed: false, selfIntersect: false,
        form: 'unspecified' }, at: (t) => t === 0 ? [0, 0, 0] : [3, 0, 0], t: [0, 1] },
      // A knot given twice (OCCT takes them strictly increasing: merged, their multiplicities summed).
      { name: 'B-spline, a repeated knot', curve: { kind: 'bspline', degree: 2, knots: [0, 0.5, 0.5, 1],
        multiplicities: [3, 1, 1, 3], poles: [[0, 0, 0], [1, 1.5, 0], [2, 2, 0], [3, 1.5, 0], [4, 0, 0]], closed: false,
        selfIntersect: false, form: 'unspecified' }, at: (t) => t === 0 ? [0, 0, 0] : [4, 0, 0], t: [0, 1] },
      // An end multiplicity above degree + 1: cut to it, the pole it carried beyond dropped (as OCCT's reader takes
      // it), so the curve starts at the second pole.
      { name: 'B-spline, an end multiplicity above degree + 1', curve: { kind: 'bspline', degree: 2, knots: [0, 1],
        multiplicities: [4, 3], poles: [[-1, -5, 0], [0, 0, 0], [2, 2, 0], [4, 0, 0]], closed: false,
        selfIntersect: false, form: 'unspecified' }, at: (t) => t === 0 ? [0, 0, 0] : [4, 0, 0], t: [0, 1],
        ring: [[0, 0, 0], [2, 2, 0], [4, 0, 0]] },
      // A quarter circle, radius 2.
      { name: 'rational B-spline', curve: { kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
        poles: [[2, 0, 0], [2, 2, 0], [0, 2, 0]], weights: [1, Math.SQRT1_2, 1], closed: false, selfIntersect: false,
        form: 'circular_arc' }, at: (t) => t === 0 ? [2, 0, 0] : [0, 2, 0], t: [0, 1] },
    ];
    // Each curve from t0 to t1 and a line back: the loop as it runs, and the ways it can be said (the edge along or
    // against its curve; the loop's sense; the face along or against its plane, the plane facing up or down).
    const ways = [[true, true, true, true], [false, true, true, true], [true, false, true, true],
      [true, true, false, true], [false, false, false, true], [true, true, true, false]] as const;
    let n = 0;
    for (const k of kinds) for (const [edgeAlong, loopSense, faceSame, use] of ways) {
      const what = `${k.name} (edge ${edgeAlong ? 'along' : 'against'} its curve, loop sense ${loopSense}, `
        + `face ${faceSame ? 'with' : 'against'} its plane, used ${use ? 'as it is' : 'reversed'})`;
      const b = new BrepBuilder({ unit: 1 });
      const a = k.at(k.t[0]), c = k.at(k.t[1]);
      const va = b.addVertex({ point: a }), vc = b.addVertex({ point: c });
      const curve = b.addCurve(k.curve);
      const d = [a[0] - c[0], a[1] - c[1], 0], len = Math.hypot(...d);
      const back = b.addEdge({ curve: b.addCurve({ kind: 'line', point: c, direction: d.map((x) => x / len),
        magnitude: 1 }), start: vc, end: va, sameSense: true });
      // Along: from a to c with the curve; against: from c to a, so used reversed.
      const arc = edgeAlong ? b.addEdge({ curve, start: va, end: vc, sameSense: true })
        : b.addEdge({ curve, start: vc, end: va, sameSense: false });
      // The loop a -> c -> a, which way round it runs about +z by its signed area (the arc sampled).
      let signed = 0;
      // (A B-spline's or polyline's points: its control polygon, on the same side of the chord.)
      const ring: V3[] = k.ring ?? ('poles' in k.curve ? k.curve.poles as V3[] : 'points' in k.curve
        ? k.curve.points as V3[] : Array.from({ length: 65 }, (_, j) => k.at(k.t[0] + (k.t[1] - k.t[0]) * j / 64)));
      for (let j = 0; j < ring.length; j++) {
        const p = ring[j]!, q = ring[(j + 1) % ring.length]!;
        signed += p[0] * q[1] - q[0] * p[1];
      }
      const ccw = signed > 0;
      // The face's normal: +z where the loop runs counter-clockwise about it as used (Part 42's outer bound).
      const runs = ccw === loopSense;
      const up = runs === faceSame;
      const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, up ? 1 : -1],
        xDir: [1, 0, 0] } });
      // As written the loop runs a -> c -> a; a reversed loop sense says it's used the other way round.
      const coedges = loopSense
        ? [{ edge: arc, orientation: edgeAlong ? 'forward' as const : 'reversed' as const },
          { edge: back, orientation: 'forward' as const }]
        : [{ edge: back, orientation: 'reversed' as const },
          { edge: arc, orientation: edgeAlong ? 'reversed' as const : 'forward' as const }];
      const face = b.addFace({ surface: plane, sameSense: faceSame, id: 5, loops: [{ kind: 'edge', bound: 'outer',
        sense: loopSense, coedges }] });
      const shell = b.addShell({ kind: 'open', faces: [{ face, sense: use }] });
      b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
      const req = request(new Uint8Array(b.finish().buffer));
      const r1 = await step.tessellate(req), r2 = await native.tessellate(req);
      assert.ok(r2.indices.length > 0, what);
      assert.deepEqual(r2.diagnostics.filter((x) => x.severity !== 'info'), [], what);
      // (OCCT's STEP reader leaves out an ORIENTED_FACE, which is how the writer says a face is used reversed: the STEP
      // route has nothing to compare there.)
      if (use) same(r1, r2, what, 1e-9, req.data);
      else assert.equal(r1.faces.length, 0, what);
      // The face facing +z where its plane does and it's with it, or its plane doesn't and it's against it; the other
      // way where it's used reversed.
      const z = faces(r2).get(5)!.normal[2]!;
      assert.ok(Math.abs(z) > 0.1 && (z > 0) === ((up === faceSame) === use),
        `${what}: faces ${z > 0 ? 'up' : 'down'}`);
      n++;
    }
    assert.equal(n, kinds.length * ways.length);
  });

test('the native route: closed B-splines, a surface in periodic form, a sphere cap both ways round, a vertex off its '
  + 'edges\' lines, meshed as the STEP route meshes them', { skip }, async () => {
  const { step, native } = await both();
  type V3 = [number, number, number];
  const sheet = (b: BrepBuilder, face: number) => {
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  };
  const plane = (b: BrepBuilder) => b.addSurface({ kind: 'plane', position: XY });
  const loop = (coedges: { edge: number; orientation: 'forward' | 'reversed' }[], sense = true) =>
    ({ kind: 'edge' as const, bound: 'outer' as const, sense, coedges });
  const cases: [string, BrepBuilder][] = [];
  // A planar face bounded by one closed B-spline edge: OCCT's periodic form (no end multiplicities, the poles going
  // round: degree 2 over a hexagon), and a clamped curve said closed whose ends meet.
  for (const periodic of [true, false]) {
    const b = new BrepBuilder({ unit: 1 });
    const hex: V3[] = Array.from({ length: 6 }, (_, j) => [2 * Math.cos(j * Math.PI / 3), 2 * Math.sin(j * Math.PI / 3),
      0]);
    const curve: Curve = periodic
      ? { kind: 'bspline', degree: 2, knots: [0, 1, 2, 3, 4, 5, 6], multiplicities: [1, 1, 1, 1, 1, 1, 1], poles: hex,
        closed: true, selfIntersect: false, form: 'unspecified' }
      : { kind: 'bspline', degree: 2, knots: [0, 1, 2, 3, 4], multiplicities: [3, 1, 1, 1, 3],
        poles: [[2, 0, 0], [2, 2, 0], [-2, 2, 0], [-2, -2, 0], [2, -2, 0], [2, 0, 0]], closed: true,
        selfIntersect: false, form: 'unspecified' };
    // On the periodic curve, a knot's point is the middle of two poles.
    const v = b.addVertex({ point: periodic ? [(hex[0]![0] + hex[1]![0]) / 2, (hex[0]![1] + hex[1]![1]) / 2, 0]
      : [2, 0, 0] });
    const edge = b.addEdge({ curve: b.addCurve(curve), start: v, end: v, sameSense: true });
    sheet(b, b.addFace({ surface: plane(b), sameSense: true, id: 5,
      loops: [loop([{ edge, orientation: 'forward' }])] }));
    cases.push([periodic ? 'a closed B-spline in periodic form' : 'a clamped B-spline said closed', b]);
  }
  // A square prism's side as one face: a B-spline surface of degree 1, in periodic form round the square (OCCT's), its
  // two ends closed polylines, a vertex each.
  {
    const b = new BrepBuilder({ unit: 1 });
    const sq: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const at = (z: number) => sq.map(([x, y]) => [x, y, z] as V3);
    const surface = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1, 2, 3, 4],
      uMultiplicities: [2, 2], vMultiplicities: [1, 1, 1, 1, 1], poles: [at(0), at(1)], uClosed: false, vClosed: true,
      selfIntersect: false, form: 'unspecified' });
    const ends = [0, 1].map((z) => {
      const v = b.addVertex({ point: [0, 0, z] });
      return b.addEdge({ curve: b.addCurve({ kind: 'polyline', points: [...at(z), [0, 0, z]] }), start: v, end: v,
        sameSense: true });
    });
    sheet(b, b.addFace({ surface, sameSense: true, id: 5, loops: [loop([{ edge: ends[0]!, orientation: 'forward' }]),
      loop([{ edge: ends[1]!, orientation: 'reversed' }])] }));
    cases.push(['a B-spline surface in periodic form', b]);
  }
  // A sphere of radius 2 cut by a circle at z = 1: the cap above it, or below, by the loop's sense.
  for (const sense of [true, false]) {
    const b = new BrepBuilder({ unit: 1 });
    const r = Math.sqrt(3), v = b.addVertex({ point: [r, 0, 1] });
    const edge = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, 1] }, radius: r }),
      start: v, end: v, sameSense: true });
    sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: XY, radius: 2 }), sameSense: true, id: 5,
      loops: [loop([{ edge, orientation: 'forward' }], sense)] }));
    cases.push([`a sphere cap, the loop's sense ${sense}`, b]);
  }
  // A unit square whose corner (1, 1) lies 1e-3 off its two edges' lines (each line through the exact corner).
  {
    const b = new BrepBuilder({ unit: 1 });
    const exact: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = exact.map((p, j) => b.addVertex({ point: j === 2 ? [1 + 1e-3, 1 + 1e-3, 0] : p }));
    const edges = exact.map((p, j) => {
      const q = exact[(j + 1) % 4]!;
      return b.addEdge({ curve: b.addCurve({ kind: 'line', point: p, direction: [q[0] - p[0], q[1] - p[1], 0],
        magnitude: 1 }), start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true });
    });
    sheet(b, b.addFace({ surface: plane(b), sameSense: true, id: 5,
      loops: [loop(edges.map((edge) => ({ edge, orientation: 'forward' as const })))] }));
    cases.push(['a vertex off its edges\' lines', b]);
  }
  const areas: number[] = [];
  for (const [what, b] of cases) {
    const req = request(new Uint8Array(b.finish().buffer));
    const r1 = await step.tessellate(req), r2 = await native.tessellate(req);
    assert.ok(r2.indices.length > 0, what);
    assert.deepEqual(r2.diagnostics.filter((x) => x.severity !== 'info'), [], what);
    same(r1, r2, what, 1e-9, req.data);
    areas.push(faces(r2).get(5)!.area);
  }
  // The prism's side 4; the caps 2 pi r h of the sphere: h 1 above the circle, 3 below.
  assert.ok(Math.abs(areas[2]! - 4) < 1e-2, `prism ${areas[2]}`);
  assert.ok(Math.abs(areas[3]! - 4 * Math.PI) < 0.05 * 4 * Math.PI, `cap above ${areas[3]}`);
  assert.ok(Math.abs(areas[4]! - 12 * Math.PI) < 0.05 * 12 * Math.PI, `cap below ${areas[4]}`);
});

test('the native route, loops and edges as OCCT\'s STEP translator makes them: no loops, vertex loops, a degenerate '
  + 'edge, poly loops', { skip }, async () => {
  const { step, native } = await both();
  type V3 = [number, number, number];
  const sheet = (b: BrepBuilder, faces: number[], kind: 'open' | 'closed' = 'open') => {
    const shell = b.addShell({ kind, faces: faces.map((face) => ({ face, sense: true })) });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: kind === 'open' ? 'sheet' : 'solid',
      members: [{ ref: shell, sense: true }] }) });
  };
  const run = async (b: BrepBuilder) => {
    const req = request(new Uint8Array(b.finish().buffer));
    return { req, a: await step.tessellate(req), n: await native.tessellate(req) };
  };
  const warnings = (r: TessellationResult) => r.diagnostics.filter((d) => d.severity !== 'info')
    .map((d) => d.message);
  // A whole sphere (no loops: healing's natural bounds) and a hemisphere (its equator and a vertex loop at its pole:
  // a degenerate edge there).
  {
    const { req, a, n } = await run(MODELS.spheres());
    assert.deepEqual(warnings(n), []);
    same(a, n, 'spheres', 1e-9, req.data);
  }
  // A cone's side with a degenerate edge at its apex, its p-curve running against it (range 2 pi to 0), the seam
  // without p-curves.
  {
    const b = new BrepBuilder({ unit: 1 });
    const position = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
    const surface = b.addSurface({ kind: 'cone', position, radius: 1, semiAngle: Math.PI / 4 });
    const base = b.addCurve({ kind: 'circle', position, radius: 1 });
    const seam = b.addCurve({ kind: 'line', point: [0, 0, -1], direction: [Math.SQRT1_2, 0, Math.SQRT1_2],
      magnitude: Math.SQRT2 });
    const pApex = b.addCurve({ kind: 'line', point: [0, -1], direction: [1, 0], magnitude: 1 });
    const vb = b.addVertex({ point: [1, 0, 0] }), va = b.addVertex({ point: [0, 0, -1] });
    const eBase = b.addEdge({ curve: base, start: vb, end: vb, sameSense: true, id: 31 });
    const eSeam = b.addEdge({ curve: seam, start: va, end: vb, sameSense: true, id: 32 });
    const eApex = b.addEdge({ start: va, end: va, sameSense: true, degenerate: true, id: 33 });
    const face = b.addFace({ surface, sameSense: true, id: 5, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: eBase, orientation: 'forward' }, { edge: eSeam, orientation: 'reversed' },
        { edge: eApex, orientation: 'forward', pcurve: pApex, range: [2 * Math.PI, 0] },
        { edge: eSeam, orientation: 'forward' }] }] });
    sheet(b, [face]);
    const { a, n } = await run(b);
    assert.deepEqual(warnings(n), []);
    // (STEP has no degenerate edges: the writer writes it as an edge, which OCCT reads otherwise, so the STEP route
    // is no oracle for the triangles here; the side's area is: pi r l, l = sqrt 2.)
    const area = faces(n).get(5)!.area;
    assert.ok(Math.abs(area - Math.PI * Math.SQRT2) < 0.01 * Math.PI * Math.SQRT2, `the cone's side: ${area}`);
    assert.ok(Math.abs(area - faces(a).get(5)!.area) < 1e-3 * area);
  }
  // Vertex loops: on a plane or a torus left out with a warning; on a sphere, the face's only loop, its natural
  // bounds.
  for (const kind of ['plane', 'torus', 'sphere'] as const) {
    const b = new BrepBuilder({ unit: 1 });
    const v = b.addVertex({ point: kind === 'plane' ? [0, 0, 0] : kind === 'torus' ? [3, 0, 0] : [0, 0, 2] });
    const surface = b.addSurface(kind === 'plane' ? { kind, position: XY } : kind === 'torus'
      ? { kind, position: XY, majorRadius: 2, minorRadius: 1 } : { kind, position: XY, radius: 2 });
    const face = b.addFace({ surface, sameSense: true, id: 5, loops: [{ kind: 'vertex', bound: 'outer', sense: true,
      vertex: v }] });
    sheet(b, [face]);
    const { req, a, n } = await run(b);
    if (kind === 'sphere') {
      assert.deepEqual(warnings(n), []);
      same(a, n, 'a sphere bounded by a vertex loop', 1e-9, req.data);
      assert.ok(Math.abs(faces(n).get(5)!.area - 16 * Math.PI) < 0.01 * 16 * Math.PI);
    } else {
      assert.deepEqual(warnings(n).filter((w) => w.startsWith('native builder')),
        [`native builder: face #5: a vertex loop on a ${kind} left out (as OCCT's STEP reader leaves it out)`]);
    }
  }
  // A tetrahedron of poly loops, each face on its own plane, one said the other way round: its edges shared by the
  // faces (by their points), all six of them between two faces.
  {
    const b = new BrepBuilder({ unit: 1 });
    const p: V3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const tris = [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]];
    const sub = (x: V3, y: V3): V3 => [x[0] - y[0], x[1] - y[1], x[2] - y[2]];
    const cross = (x: V3, y: V3): V3 => [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0]];
    const unit = (x: V3): V3 => { const l = Math.hypot(...x); return [x[0] / l, x[1] / l, x[2] / l]; };
    const faceIds = tris.map((t, j) => {
      const [a, c, d] = t.map((k) => p[k]!) as [V3, V3, V3];
      const x = unit(sub(c, a));
      const plane = b.addSurface({ kind: 'plane', position: { origin: a, axis: unit(cross(sub(c, a), sub(d, a))),
        xDir: x } });
      // (The first face's points the other way round, its loop's sense false: the same face.)
      return b.addFace({ surface: plane, sameSense: true, id: 41 + j, loops: [{ kind: 'poly', bound: 'outer',
        sense: j !== 0, points: j === 0 ? [d, c, a] : [a, c, d] }] });
    });
    sheet(b, faceIds, 'closed');
    const { a, n } = await run(b);
    assert.deepEqual(warnings(n), []);
    const fa = faces(a), fn = faces(n);
    for (const id of [41, 42, 43, 44]) {
      assert.equal(fn.get(id)?.tris, fa.get(id)?.tris, `poly face #${id}`);
      assert.ok(Math.abs(fn.get(id)!.area - fa.get(id)!.area) < 1e-9, `poly face #${id}'s area`);
      // Facing out of the tetrahedron (its centroid inside, at 0.25 each).
      const nrm = fn.get(id)!.normal, at = tris[id - 41]!.map((k) => p[k]!)[0]!;
      assert.ok(nrm.reduce((acc, c, k) => acc + c * (at[k]! - 0.25), 0) > 0, `poly face #${id} faces out`);
    }
    // Six edges, each between two faces; the STEP route's (our writer gives each face its own points) all free.
    assert.deepEqual((n.edges ?? []).map((e) => e.kind).sort(), Array(6).fill('shared'));
    assert.ok((a.edges ?? []).every((e) => e.kind === 'free'));
  }
});

test('the native route, edges as OCCT\'s STEP translator makes them: a line beside its vertices moved through them, '
  + 'two vertices at one point merged, a vertex beyond its curve\'s end', { skip }, async () => {
  const { step, native } = await both();
  type V3 = [number, number, number];
  const square = (b: BrepBuilder, curveOf: (j: number, p: V3, q: V3) => number) => {
    const c: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = c.map((point) => b.addVertex({ point }));
    const es = c.map((p, j) => b.addEdge({ curve: curveOf(j, p, c[(j + 1) % 4]!), start: vs[j]!,
      end: vs[(j + 1) % 4]!, sameSense: true, id: 11 + j }));
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 5,
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: es.map((edge) => ({ edge,
        orientation: 'forward' as const })) }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  };
  const line = (b: BrepBuilder, p: V3, q: V3, off: V3 = [0, 0, 0]) => {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l = Math.hypot(...d);
    return b.addCurve({ kind: 'line', point: [p[0] + off[0], p[1] + off[1], p[2] + off[2]],
      direction: d.map((x) => x / l), magnitude: 1 });
  };
  const check = async (what: string, b: BrepBuilder, warning?: RegExp) => {
    const req = request(new Uint8Array(b.finish().buffer));
    const r1 = await step.tessellate(req), r2 = await native.tessellate(req);
    const ws = r2.diagnostics.filter((x) => x.severity !== 'info').map((x) => x.message);
    if (warning) assert.ok(ws.length === 1 && warning.test(ws[0]!), `${what}: ${ws}`);
    else assert.deepEqual(ws, [], what);
    same(r1, r2, what, 1e-9, req.data);
    return faces(r2);
  };
  // The bottom edge's line 0.01 below its vertices, along them.
  {
    const b = new BrepBuilder({ unit: 1 });
    square(b, (j, p, q) => line(b, p, q, j === 0 ? [0, -0.01, 0] : [0, 0, 0]));
    const f = await check('a line beside its vertices', b,
      /^native builder: edge #11: its line moved through its vertices/);
    assert.ok(Math.abs(f.get(5)!.area - 1) < 1e-9);
  }
  // A full circle bounding a disc, its edge's two ends two vertices at one point.
  {
    const b = new BrepBuilder({ unit: 1 });
    const v1 = b.addVertex({ point: [1, 0, 0] }), v2 = b.addVertex({ point: [1, 0, 0] });
    const edge = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: XY, radius: 1 }), start: v1, end: v2,
      sameSense: true, id: 11 });
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 5,
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge, orientation: 'forward' }] }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const f = await check('a closed edge with two vertices at one point', b);
    assert.ok(Math.abs(f.get(5)!.area - Math.PI) < 0.01 * Math.PI);
  }
  // The right edge a B-spline ending 1e-3 short of its end vertex (the vertex beyond the curve's end).
  {
    const b = new BrepBuilder({ unit: 1 });
    square(b, (j, p, q) => j === 1 ? b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1], multiplicities: [2, 2],
      poles: [p, [q[0], q[1] - 1e-3, q[2]]], closed: false, selfIntersect: false, form: 'unspecified' })
      : line(b, p, q));
    await check('a vertex beyond its curve\'s end', b);
  }
});
