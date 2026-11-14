// The native route (native/occt_build.cpp): a part's cad-brep buffer built into OCCT's shapes, checked against the STEP
// route (the same model written as STEP and read by OCCT's reader), face by face. Needs the built module (./build.sh);
// the corpus file's test needs the corpus (test_corpus/third_party/pull.sh). Skipped without them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, brepFromJson, brepToJson, ITEM_KIND, LOOP_KIND, openBrep, rowCount } from 'cad-brep';
import type { Curve } from 'cad-brep';
import type { TessellationRequest, TessellationResult } from 'cad-scene';
import { StepTessellator } from 'step-export';
import { importStep } from 'step-import';
import { box, MODELS } from '../../cad-brep/test/models.ts';
import { OcctTessellator } from '../src/index.ts';

const root = path.resolve(import.meta.dirname, '../../..');
const built = fs.existsSync(path.join(import.meta.dirname, '../dist/occt_tess.wasm'));
const skip = built ? false : 'tess-occt not built (run packages/tess-occt/build.sh)';
const XY = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };

let routes: Promise<{ step: StepTessellator; native: OcctTessellator }> | undefined;
function both() {
  return routes ??= (async () => {
    const step = new StepTessellator(new OcctTessellator({ route: 'step' })), native = new OcctTessellator();
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
function same(a: TessellationResult, b: TessellationResult, what: string, tol = 1e-9, data?: Uint8Array,
  copiedEdges = 0, edgeKinds = true) {
  const json = data && brepToJson(openBrep(data));
  const fa = faces(a), fb = faces(b);
  assert.deepEqual([...fb.keys()].map(String).sort(), [...fa.keys()].map(String).sort(), `${what}: face ids`);
  for (const [id, x] of fa) {
    const y = fb.get(id)!;
    assert.equal(y.tris, x.tris, `${what}: face #${id}'s triangles`);
    assert.ok(Math.abs(y.area - x.area) <= tol * Math.max(x.area, 1), `${what}: face #${id}'s area`);
    assert.ok(Math.hypot(...y.normal.map((c, k) => c - x.normal[k]!)) <= tol * Math.max(x.area, 1),
      `${what}: face #${id}'s side: ${y.normal} vs ${x.normal}`);
  }
  // The edges by id, with their kinds and points; a curve-bounded face's segments (edges without vertices, and a
  // loose face's edges, which the writer writes as its boundaries' segments) without ids on both (OCCT's reader takes
  // ids from EDGE_CURVEs only, the native route keeps the segments').
  const segments = new Set(json?.edges.filter((e) => e.start === undefined).map((e) => e.id));
  if (data) {
    const d = openBrep(data), inShell = new Set(Array.from(d.faceUse.face));
    for (let k = 0; k < rowCount(d, 'item'); k++) {
      const f = d.item.ref[k]!;
      if (d.item.kind[k] !== ITEM_KIND.face || inShell.has(f)) continue;
      for (let l = d.face.firstLoop[f]!; l < d.face.firstLoop[f]! + d.face.loopCount[f]!; l++) {
        if (d.loop.kind[l] !== LOOP_KIND.edge) continue;
        for (let c = d.loop.first[l]!; c < d.loop.first[l]! + d.loop.count[l]!; c++) {
          segments.add(d.edge.id[d.coedge.edge[c]!]!);
        }
      }
    }
  }
  // (`copiedEdges`: edges the STEP route's healing copies, without ids, where sheets share a face.)
  const edges = (r: TessellationResult) => (r.edges ?? []).map((e) =>
    `${e.entityId !== null && !segments.has(e.entityId) ? e.entityId : null} ${edgeKinds ? e.kind : '?'} ${e.count}`)
    .sort();
  const ea = edges(a), eb = edges(b);
  for (let k = 0; k < copiedEdges; k++) {
    const j = ea.findIndex((e) => e.startsWith(edgeKinds ? 'null free' : 'null ?'));
    assert.ok(j >= 0, `${what}: an edge copied`);
    ea.splice(j, 1);
  }
  assert.deepEqual(eb, ea, `${what}: edges`);
  // Curves (wireframes, geometric sets): their points by id; loose points: ids and positions.
  const curves = (r: TessellationResult) => (r.curves ?? []).map((c) => `${c.entityId} ${c.count}`).sort();
  assert.deepEqual(curves(b), curves(a), `${what}: curves`);
  const points = (r: TessellationResult) => (r.pointIds ?? []).map((id, k) => `${id} `
    + [0, 1, 2].map((c) => r.points![3 * k + c]!.toFixed(4)).join()).sort();
  assert.deepEqual(points(b), points(a), `${what}: points`);
  // OCCT's measures by id.
  const measured = (r: TessellationResult) => r.measures ?? [];
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
    for (const name of ['cube', 'withVoid', 'seamCylinder', 'reversedUses', 'withoutIds'] as const) {
      const req = request(new Uint8Array(MODELS[name]().finish().buffer));
      const a = await step.tessellate(req), b = await native.tessellate(req);
      assert.ok(b.indices.length > 0, name);
      assert.deepEqual(b.diagnostics.filter((d) => d.severity !== 'info'), [], name);
      // (withoutIds: each square's face and its copy, used reversed by a second sheet, share their 4 edges natively
      // (shared), the STEP route's healing copying them per shell (each free): their kinds not compared.)
      same(a, b, name, 1e-9, req.data, name === 'withoutIds' ? 8 : 0, name !== 'withoutIds');
    }
  });

test('the native route: a part with a kind not built yet fails with an error and nothing meshed', { skip },
  async () => {
    const { native } = await both();
    // A square whose first edge's curve is a composite of two lines (not built yet as an edge's curve).
    const b = new BrepBuilder();
    const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const vs = c.map((point) => b.addVertex({ point }));
    const line = (p: number[], q: number[]) => b.addCurve({ kind: 'line', point: p, direction: [q[0]! - p[0]!,
      q[1]! - p[1]!, 0].map((x) => x / Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!)), magnitude: 1 });
    const half = (t1: number, t2: number) => b.addCurve({ kind: 'trimmed', basis: line(c[0]!, c[1]!),
      trim1: { parameter: t1 }, trim2: { parameter: t2 }, sense: true, preference: 'parameter' });
    const composite = b.addCurve({ kind: 'composite', segments: [{ curve: half(0, 0.5), sameSense: true,
      transition: 'continuous' }, { curve: half(0.5, 1), sameSense: true, transition: 'continuous' }],
    selfIntersect: false });
    const es = c.map((p, j) => b.addEdge({ curve: j === 0 ? composite : line(p, c[(j + 1) % 4]!), start: vs[j]!,
      end: vs[(j + 1) % 4]!, sameSense: true }));
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true,
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: es.map((edge) => ({ edge,
        orientation: 'forward' as const })) }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const r = await native.tessellate(request(new Uint8Array(b.finish().buffer)));
    assert.equal(r.indices.length, 0);
    assert.deepEqual(r.faces, []);
    assert.deepEqual(r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message),
      ['native builder: not built yet: a composite curve']);
  });

test('the native route: ids above 2^31 come back as they are (u32), a face or edge without one as null', { skip },
  async () => {
    const { native } = await both();
    const b = new BrepBuilder();
    // Vertices from 2^32 - 30 + 1, edges from + 9, faces + 21 to + 26 (the largest 2^32 - 4).
    const base = 2 ** 32 - 30;
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [0, 0, 0], base),
      sense: true }] }) });
    const d = openBrep(b.finish().buffer.slice(0));
    d.face.id[0] = 0;
    d.edge.id[0] = 0;
    const r = await native.tessellate({ ...request(new Uint8Array(d.buffer)), edges: true });
    assert.deepEqual([...new Set(r.faces.map((f) => f.entityId))].sort(),
      [null, ...[22, 23, 24, 25, 26].map((k) => base + k)].sort());
    assert.ok(r.faces.every((f) => f.count > 0));
    const edges = new Set(r.edges!.map((e) => e.entityId));
    assert.deepEqual([...edges].sort(), [null, ...Array.from({ length: 11 }, (_, k) => base + 10 + k)].sort());
  });

test('the native route: a face on a swept surface (no counterpart in OCCT) left out with a warning, the rest meshed',
  { skip }, async () => {
    const { native } = await both();
    // A face set: a unit square in z = 0, and a face on a curve-swept surface sharing its edges.
    const b = new BrepBuilder();
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

test('the native route, the default: formats it doesn\'t take are caller bugs; the STEP route takes no models', { skip },
  async () => {
    const { native } = await both();
    assert.equal(native.route, 'native');
    assert.deepEqual(native.info.formats, ['cad-brep', 'step']);
    const step = new OcctTessellator({ route: 'step' });
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
// doesn't make the same ones); lines beside their vertices, moved through them; wireframes and geometric sets (curve,
// point, surface and curve-bounded face items, wire bodies; lone boundaries on spheres and tori, which healing's
// natural bounds would turn into the rest of the surface); extrusions, revolutions; trimmed p-curves.
const corpus = [['gkv311-opencascade-dataset/step/as1-oc-214-mat.stp', 5],
  ['gkv311-opencascade-dataset/step/trj7_k1-ac-203.stp', 1],
  ['nist-pmi-models/NIST_MBE_PMI_FTC_Definitions/NIST_MBE_PMI_FTC_Definitions/nist_ftc_07_asme1_rd.stp', 1],
  ['nist-pmi-models/NIST_MBE_PMI_CTC_Definitions/NIST_MBE_PMI_CTC_Definitions/nist_ctc_04_asme1_rd.stp', 2],
  ['gkv311-opencascade-dataset/step/trj5_s1-ug-214.stp', 8],
  ['gkv311-opencascade-dataset/step/trj7_k1-id-214.stp', 1],
  ['gkv311-opencascade-dataset/step/r103ec.stp', 1], ['gkv311-opencascade-dataset/step/trj3_s1-db-214.stp', 8],
  ['gkv311-opencascade-dataset/step/bug25415_part_of_hdrv8w64p254_4x2_1016x502h838p.stp', 1],
  ['gkv311-opencascade-dataset/step/trj8_c2-ac-214.stp', 2], ['gkv311-opencascade-dataset/step/trj9_c2-sy-214.stp', 1],
  ['gkv311-opencascade-dataset/step/trj10_ch1-tu-203.stp', 1],
  ['gkv311-opencascade-dataset/step/trj6_c1-ct-214.stp', 3], ['gkv311-opencascade-dataset/step/tr8_ha1_ug.stp', 2],
  ['gkv311-opencascade-dataset/step/trj4_k1_geo-ac-214.stp', 2],
  ['gkv311-opencascade-dataset/step/trj7_k1-ct-214.stp', 1], ['gkv311-opencascade-dataset/step/trj7_k1-ec-214.stp', 1],
  ['gkv311-opencascade-dataset/step/trj3_s1-tc-214.stp', 8],
  ['gkv311-opencascade-dataset/step/trj4_s1-pe-214.stp', 8],
  ['gkv311-opencascade-dataset/step/trj4_k1_geo-pe-214.stp', 2]] as const;
const corpusPath = (f: string) => path.join(root, 'test_corpus/third_party', f);
test('the native route on corpus files: every part meshed as the STEP route meshes it', {
  skip: skip || (corpus.every(([f]) => fs.existsSync(corpusPath(f))) ? false : 'corpus not fetched') }, async () => {
  const { step, native } = await both();
  for (const [f, parts] of corpus) {
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(corpusPath(f))));
    let n = 0;
    for (const p of scene.parts) {
      if (!p.brep) continue;
      const req = { ...request(new Uint8Array(p.brep.model.buffer)), origin: p.origin };
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
      const b = new BrepBuilder();
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
      // (A face used reversed is written turned over, which OCCT's STEP reader reads: compared every way round.)
      same(r1, r2, what, 1e-9, req.data);
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
    const b = new BrepBuilder();
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
    const b = new BrepBuilder();
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
    const b = new BrepBuilder();
    const r = Math.sqrt(3), v = b.addVertex({ point: [r, 0, 1] });
    const edge = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, 1] }, radius: r }),
      start: v, end: v, sameSense: true });
    sheet(b, b.addFace({ surface: b.addSurface({ kind: 'sphere', position: XY, radius: 2 }), sameSense: true, id: 5,
      loops: [loop([{ edge, orientation: 'forward' }], sense)] }));
    cases.push([`a sphere cap, the loop's sense ${sense}`, b]);
  }
  // A unit square whose corner (1, 1) lies 1e-3 off its two edges' lines (each line through the exact corner).
  {
    const b = new BrepBuilder();
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
  // A cone's side with a degenerate edge at its apex (its p-curve and range given), the seam without p-curves; its
  // loop counter-clockwise in (u, v): the apex along v = -1, the seam up, the base back, the seam down.
  {
    const b = new BrepBuilder();
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
      coedges: [{ edge: eApex, orientation: 'forward', pcurve: pApex, range: [0, 2 * Math.PI] },
        { edge: eSeam, orientation: 'forward' }, { edge: eBase, orientation: 'reversed' },
        { edge: eSeam, orientation: 'reversed' }] }] });
    sheet(b, [face]);
    const { req, a, n } = await run(b);
    assert.deepEqual(warnings(n), []);
    // The degenerate edge left out on both routes (STEP has none: the writer leaves it out), healing making OCCT's
    // own, without the model's id; so the two alike, the face sound, the side's area pi r l, l = sqrt 2.
    same(a, n, 'a cone with a degenerate apex', 1e-9, req.data);
    const area = faces(n).get(5)!.area;
    assert.ok(Math.abs(area - Math.PI * Math.SQRT2) < 0.01 * Math.PI * Math.SQRT2, `the cone's side: ${area}`);
    assert.deepEqual(n.measures?.map((m) => [m.entityId, m.valid]), [[5, true]]);
    assert.deepEqual((n.edges ?? []).filter((e) => e.kind === 'degenerate').map((e) => e.entityId), [null]);
  }
  // Vertex loops: on a plane or a torus left out with a warning; on a sphere, the face's only loop, its natural
  // bounds.
  for (const kind of ['plane', 'torus', 'sphere'] as const) {
    const b = new BrepBuilder();
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
  // A degenerate torus (the tube through its axis: an outer part and an inner one) bounded by itself alone: no loops,
  // or a vertex loop left out: healing bounds it by the surface, both parts, select_outer set aside (a warning; none
  // for the torus not degenerate). Its vertices on both parts: (rho - R)^2 + z^2 = r^2 on the outer, (rho + R)^2 on
  // the inner.
  for (const [selectOuter, loop] of [[false, false], [true, true], [undefined, false]] as const) {
    const b = new BrepBuilder();
    const R = 1, r = 2;
    const surface = b.addSurface({ kind: 'torus', position: XY, majorRadius: selectOuter === undefined ? 3 : R,
      minorRadius: r, ...(selectOuter === undefined ? {} : { selectOuter }) });
    const face = b.addFace({ surface, sameSense: true, id: 5, loops: loop ? [{ kind: 'vertex', bound: 'outer',
      sense: true, vertex: b.addVertex({ point: [R + r, 0, 0] }) }] : [] });
    sheet(b, [face]);
    const n = await native.tessellate(request(new Uint8Array(b.finish().buffer)));
    const what = `selectOuter ${selectOuter}${loop ? ', a vertex loop' : ''}`;
    const expected = [...(loop ? ['native builder: face #5: a vertex loop on a torus left out (as OCCT\'s STEP reader '
      + 'leaves it out)'] : []), ...(selectOuter === undefined ? [] : ['native builder: face #5: bounded by its '
      + 'degenerate torus alone: both of the torus\'s parts, which part is meant (select_outer) set aside, as OCCT\'s '
      + 'STEP reader sets it aside'])];
    assert.deepEqual(warnings(n), expected, what);
    if (selectOuter === undefined) continue;
    const parts = new Set<string>();
    for (let i = 0; i < n.positions.length; i += 3) {
      const [x, y, z] = [n.positions[i]!, n.positions[i + 1]!, n.positions[i + 2]!], rho = Math.hypot(x, y);
      if (rho < 1e-3) continue;
      if (Math.abs(Math.hypot(rho - R, z) - r) < 1e-3) parts.add('outer');
      else if (Math.abs(Math.hypot(rho + R, z) - r) < 1e-3) parts.add('inner');
      else parts.add('neither');
    }
    assert.deepEqual([...parts].sort(), ['inner', 'outer'], what);
  }
  // A real one (the ohmm demo model's roller): its degenerate tori's faces, select_outer false, bounded by their
  // loops: no warning, and meshed on the inner part alone.
  {
    const file = path.join(root, 'test_corpus/demo/ohmm-ap242.step');
    const { scene } = await importStep(new Uint8Array(fs.readFileSync(file)));
    const part = scene.parts.find((p) => p.name === 'R76-4CM-ROLLER_half')!;
    const data = new Uint8Array(part.brep!.model.buffer);
    const j = brepToJson(openBrep(data));
    const tori = new Map(j.faces.flatMap((f) => {
      const t = j.surfaces[f.surface]!;
      return t.kind === 'torus' && t.selectOuter === false && f.id !== undefined ? [[f.id, t] as const] : [];
    }));
    assert.equal(tori.size, 4);
    const n = await native.tessellate({ ...request(data), origin: part.origin });
    assert.deepEqual(warnings(n).filter((w) => /torus/.test(w)), []);
    for (const f of n.faces) {
      const t = tori.get(f.entityId ?? -1);
      if (!t) continue;
      const o = t.position.origin, z = t.position.axis ?? [0, 0, 1];
      let inner = 0;
      const tri = n.indices.subarray(f.start, f.start + f.count);
      for (const i of tri) {
        const q = [0, 1, 2].map((c) => n.positions[3 * i + c]! + n.origin[c]! - o[c]!);
        const h = q[0]! * z[0]! + q[1]! * z[1]! + q[2]! * z[2]!;
        const rho = Math.hypot(...q.map((c, k) => c - h * z[k]!));
        const tol = 1e-3 * t.minorRadius;
        assert.ok(Math.abs(Math.hypot(rho + t.majorRadius, h) - t.minorRadius) < tol
          && Math.abs(Math.hypot(rho - t.majorRadius, h) - t.minorRadius) >= tol, `face #${f.entityId}: off the inner`);
        inner++;
      }
      assert.ok(inner > 0);
      tori.delete(f.entityId!);
    }
    assert.equal(tori.size, 0, 'every torus face meshed');
  }
  // A tetrahedron of poly loops, each face on its own plane, one said the other way round: its edges shared by the
  // faces (by their corners, vertices), all six of them between two faces.
  {
    const b = new BrepBuilder();
    const p: V3[] = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
    const corners = p.map((point) => b.addVertex({ point }));
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
        sense: j !== 0, vertices: (j === 0 ? [...t].reverse() : t).map((k) => corners[k]!) }] });
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
    // Six edges, each between two faces, on both routes (the writer shares the faces' points as the model does).
    assert.deepEqual((n.edges ?? []).map((e) => e.kind).sort(), Array(6).fill('shared'));
    assert.deepEqual((a.edges ?? []).map((e) => e.kind).sort(), Array(6).fill('shared'));
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
    const b = new BrepBuilder();
    square(b, (j, p, q) => line(b, p, q, j === 0 ? [0, -0.01, 0] : [0, 0, 0]));
    const f = await check('a line beside its vertices', b,
      /^native builder: edge #11: its line moved through its vertices/);
    assert.ok(Math.abs(f.get(5)!.area - 1) < 1e-9);
  }
  // A full circle bounding a disc, its edge's two ends two vertices at one point.
  {
    const b = new BrepBuilder();
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
    const b = new BrepBuilder();
    square(b, (j, p, q) => j === 1 ? b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1], multiplicities: [2, 2],
      poles: [p, [q[0], q[1] - 1e-3, q[2]]], closed: false, selfIntersect: false, form: 'unspecified' })
      : line(b, p, q));
    await check('a vertex beyond its curve\'s end', b);
  }
});

test('the native route, swept and derived surfaces: faces on an extrusion, a revolution, an offset plane, a trimmed '
  + 'cylinder, meshed as the STEP route meshes them', { skip }, async () => {
  const { step, native } = await both();
  type V3 = [number, number, number];
  // A face over the rectangle u0..u1 x v0..v1 of a surface, its edges the surface's iso-curves as given (3D curves
  // through the corners in order).
  const patch = (b: BrepBuilder, surface: number, corners: V3[], sides: number[]) => {
    const vs = corners.map((point) => b.addVertex({ point }));
    const es = sides.map((curve, j) => b.addEdge({ curve, start: vs[j]!, end: vs[(j + 1) % 4]!, sameSense: true,
      id: 11 + j }));
    const face = b.addFace({ surface, sameSense: true, id: 5, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: es.map((edge) => ({ edge, orientation: 'forward' as const })) }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
  };
  const line = (b: BrepBuilder, p: V3, q: V3) => {
    const d = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], l = Math.hypot(...d);
    return b.addCurve({ kind: 'line', point: p, direction: d.map((x) => x / l), magnitude: 1 });
  };
  // (From t1 to t2 the short way: against the basis where t2 < t1.)
  const trim = (b: BrepBuilder, basis: number, t1: number, t2: number) => b.addCurve({ kind: 'trimmed', basis,
    trim1: { parameter: t1 }, trim2: { parameter: t2 }, sense: t2 > t1, preference: 'parameter' });
  const cases: [string, (b: BrepBuilder) => void, number][] = [
    // A quarter of a circle of radius 1 extruded 2 up (the vector's magnitude 2, its v 0 to 1).
    ['an extrusion', (b) => {
      const arc = b.addCurve({ kind: 'circle', position: XY, radius: 1 });
      const top = b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, 2] }, radius: 1 });
      const s = b.addSurface({ kind: 'extrusion', curve: arc, direction: [0, 0, 1], magnitude: 2 });
      patch(b, s, [[1, 0, 0], [0, 1, 0], [0, 1, 2], [1, 0, 2]], [trim(b, arc, 0, Math.PI / 2),
        line(b, [0, 1, 0], [0, 1, 2]), trim(b, top, Math.PI / 2, 0), line(b, [1, 0, 2], [1, 0, 0])]);
    }, Math.PI],
    // The line x = 1, z from 0 to 1, turned a quarter about z: a quarter of a cylinder of radius 1.
    ['a revolution', (b) => {
      const gen = b.addCurve({ kind: 'line', point: [1, 0, 0], direction: [0, 0, 1], magnitude: 1 });
      const s = b.addSurface({ kind: 'revolution', curve: gen, axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1] });
      const c0 = b.addCurve({ kind: 'circle', position: XY, radius: 1 });
      const c1 = b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, 1] }, radius: 1 });
      patch(b, s, [[1, 0, 0], [0, 1, 0], [0, 1, 1], [1, 0, 1]], [trim(b, c0, 0, Math.PI / 2),
        line(b, [0, 1, 0], [0, 1, 1]), trim(b, c1, Math.PI / 2, 0), line(b, [1, 0, 1], [1, 0, 0])]);
    }, Math.PI / 2],
    // The plane z = 0 offset 0.5: the unit square at z = 0.5.
    ['an offset plane', (b) => {
      const s = b.addSurface({ kind: 'offset', basis: b.addSurface({ kind: 'plane', position: XY }), distance: 0.5,
        selfIntersect: false });
      const c: V3[] = [[0, 0, 0.5], [1, 0, 0.5], [1, 1, 0.5], [0, 1, 0.5]];
      patch(b, s, c, c.map((p, j) => line(b, p, c[(j + 1) % 4]!)));
    }, 1],
    // A cylinder of radius 1 trimmed to u 0..pi/2, v 0..1: the face its quarter.
    ['a trimmed cylinder', (b) => {
      const s = b.addSurface({ kind: 'rectangularTrimmed', basis: b.addSurface({ kind: 'cylinder', position: XY,
        radius: 1 }), u1: 0, u2: Math.PI / 2, v1: 0, v2: 1, uSense: true, vSense: true });
      const c0 = b.addCurve({ kind: 'circle', position: XY, radius: 1 });
      const c1 = b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, 1] }, radius: 1 });
      patch(b, s, [[1, 0, 0], [0, 1, 0], [0, 1, 1], [1, 0, 1]], [trim(b, c0, 0, Math.PI / 2),
        line(b, [0, 1, 0], [0, 1, 1]), trim(b, c1, Math.PI / 2, 0), line(b, [1, 0, 1], [1, 0, 0])]);
    }, Math.PI / 2],
  ];
  for (const [what, make, area] of cases) {
    const b = new BrepBuilder();
    make(b);
    const req = request(new Uint8Array(b.finish().buffer));
    const r1 = await step.tessellate(req), r2 = await native.tessellate(req);
    assert.deepEqual(r2.diagnostics.filter((x) => x.severity !== 'info').map((x) => x.message), [], what);
    same(r1, r2, what, 1e-9, req.data);
    const got = faces(r2).get(5)!.area;
    assert.ok(Math.abs(got - area) < 0.01 * area, `${what}'s area: ${got}`);
  }
});

test('the native route, items placed (baked by the builder): a transform (a rotation, a mirror, a scale, a '
  + 'translation) moves an item; an instance places another item again, both copies under fresh ids', { skip },
async () => {
  const { native } = await both();
  // The unit cube (0..1 each way) as item 1, after a box elsewhere (item 0); item 2 places the cube, x -> 2y,
  // y -> -2x, z -> -2z (a turn and a mirror, the matrix not symmetric), moved by (10, 0, 0); without the instance,
  // the cube itself moved so.
  const columns = [0, 2, 0, -2, 0, 0, 0, 0, -2, 10, 0, 0];
  const place = (p: number[]) => [-2 * p[1]! + 10, 2 * p[0]!, -2 * p[2]!];
  for (const instance of [false, true]) {
    const b = new BrepBuilder();
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1], [50, 50, 50], 1000),
      sense: true }] }) });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'solid', members: [{ ref: box(b, [1, 1, 1]), sense: true }] }) });
    const json = brepToJson(b.finish());
    json.items = instance ? [json.items[0]!, json.items[1]!, { kind: 'instance', ref: 1, transform: columns }]
      : [json.items[0]!, { ...json.items[1]!, transform: columns }];
    const d = brepFromJson(json);
    const r = await native.tessellate(request(new Uint8Array(d.buffer)));
    const what = instance ? 'an instance' : 'a transform';
    assert.deepEqual(r.diagnostics.filter((x) => x.severity !== 'info').map((x) => x.message), [], what);
    // The box's faces (1021..1026), and the cube's (21..26); with the instance the cube's two copies under fresh ids,
    // each a copy of one of 21..26.
    const cube = [21, 22, 23, 24, 25, 26], ids = r.faces.map((f) => f.entityId!);
    const source = new Map(Array.from({ length: rowCount(d, 'copy') }, (_, k) => [d.copy.id[k]!, d.copy.source[k]!]));
    assert.deepEqual(ids.filter((x) => x > 1000 && x <= 1026).sort((x, y) => x - y), cube.map((x) => x + 1000), what);
    const rest = ids.filter((x) => !(x > 1000 && x <= 1026));
    assert.equal(new Set(rest).size, instance ? 12 : 6, what);
    assert.deepEqual(rest.map((x) => source.get(x) ?? x).sort((x, y) => x - y), [...cube, ...(instance ? cube : [])]
      .sort((x, y) => x - y), what);
    // The placed copy's corners where the transform puts the cube's (the box 10..12 x 0..2 x 0..2), the other copy's
    // the cube's own.
    const pts = new Set<string>();
    for (let k = 0; k < r.positions.length; k += 3) {
      pts.add([0, 1, 2].map((c) => r.positions[k + c]!.toFixed(4)).join());
    }
    const corners = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x, y, z])));
    for (const c of corners) assert.ok(pts.has(place(c).map((x) => x.toFixed(4)).join()), `${what}: ${place(c)}`);
    if (instance) for (const c of corners) assert.ok(pts.has(c.map((x) => x.toFixed(4)).join()), `the cube: ${c}`);
    else assert.ok(!pts.has('0.0000,0.0000,0.0000'), 'the cube moved');
  }
});

test('the native route, parameters that only loose geometry shows: trimmed and offset curve items, trimmed surface '
  + 'items over extrusions, revolutions and offsets, curve-bounded faces, p-curves alone', { skip }, async () => {
  const { native } = await both();
  type V3 = [number, number, number];
  const near = (p: number[], q: number[], tol = 1e-6) => Math.hypot(...p.map((x, k) => x - q[k]!)) < tol;
  const run = async (b: BrepBuilder) => native.tessellate(request(new Uint8Array(b.finish().buffer)));
  const noWarnings = (r: TessellationResult, what: string) => assert.deepEqual(r.diagnostics
    .filter((d) => d.severity !== 'info').map((d) => d.message), [], what);
  // Curve items, each by its polyline's two ends.
  const ends = (r: TessellationResult, id: number) => {
    const c = r.curves!.find((x) => x.entityId === id)!, P = r.curvePositions!;
    const at = (k: number) => [0, 1, 2].map((j) => P[3 * k + j]!);
    return [at(c.start), at(c.start + c.count - 1)];
  };
  const curveCases: [string, (b: BrepBuilder) => number, V3, V3][] = [
    // A line of magnitude 2 trimmed 0.5..1.5: 1 to 3 along it.
    ['a trimmed line', (b) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line', point: [0, 0, 0],
      direction: [1, 0, 0], magnitude: 2 }), trim1: { parameter: 0.5 }, trim2: { parameter: 1.5 }, sense: true,
    preference: 'parameter' }), [1, 0, 0], [3, 0, 0]],
    // An ellipse whose first semi-axis is the minor one, trimmed 0..pi/2: (1, 0) to (0, 3).
    ['a trimmed ellipse', (b) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'ellipse', position: XY,
      semiAxis1: 1, semiAxis2: 3 }), trim1: { parameter: 0 }, trim2: { parameter: Math.PI / 2 }, sense: true,
    preference: 'parameter' }), [1, 0, 0], [0, 3, 0]],
    // A parabola a(t^2 x + 2t y), a = 2, trimmed 0..1: (0, 0) to (2, 4).
    ['a trimmed parabola', (b) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'parabola', position: XY,
      focalDist: 2 }), trim1: { parameter: 0 }, trim2: { parameter: 1 }, sense: true, preference: 'parameter' }),
    [0, 0, 0], [2, 4, 0]],
    // Trims by both, the parameters preferred: 0.1 to 0.9 along a unit line.
    ['a trim by its parameters', (b) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line',
      point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 }), trim1: { parameter: 0.1, point: [0.25, 0, 0] },
    trim2: { parameter: 0.9, point: [0.75, 0, 0] }, sense: true, preference: 'parameter' }), [0.1, 0, 0],
    [0.9, 0, 0]],
    // Trims by points that the parameters contradict, the points preferred: 0.25 to 0.75 along a unit line.
    ['a trim by its points', (b) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line', point: [0, 0, 0],
      direction: [1, 0, 0], magnitude: 1 }), trim1: { parameter: 0.1, point: [0.25, 0, 0] },
    trim2: { parameter: 0.9, point: [0.75, 0, 0] }, sense: true, preference: 'cartesian' }), [0.25, 0, 0],
    [0.75, 0, 0]],
    // A B-spline 0..1 trimmed -1..2: clamped to its ends.
    ['a trim beyond its curve', (b) => b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'bspline', degree: 1,
      knots: [0, 1], multiplicities: [2, 2], poles: [[0, 0, 0], [1, 1, 0]], closed: false, selfIntersect: false,
      form: 'unspecified' }), trim1: { parameter: -1 }, trim2: { parameter: 2 }, sense: true,
    preference: 'parameter' }), [0, 0, 0], [1, 1, 0]],
    // A line along x trimmed 0..1, offset 1 with reference direction z: T x V = x x z = -y.
    ['an offset curve', (b) => b.addCurve({ kind: 'offset', basis: b.addCurve({ kind: 'trimmed',
      basis: b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 1 }),
      trim1: { parameter: 0 }, trim2: { parameter: 1 }, sense: true, preference: 'parameter' }), distance: 1,
    selfIntersect: false, refDirection: [0, 0, 1] }), [0, -1, 0], [1, -1, 0]],
  ];
  for (const [what, make, p, q] of curveCases) {
    const b = new BrepBuilder();
    b.addItem({ kind: 'curve', ref: make(b), id: 7 });
    const r = await run(b);
    noWarnings(r, what);
    const [a, c] = ends(r, 7);
    assert.ok((near(a!, p) && near(c!, q)) || (near(a!, q) && near(c!, p)), `${what}: ${a} .. ${c}`);
  }
  // Surface items: trimmed surfaces over swept and offset ones, by their faces' areas and places.
  const surfaceCases: [string, (b: BrepBuilder) => number, number, (r: TessellationResult) => boolean][] = [
    // A line of magnitude 3 along x extruded up by a vector of magnitude 2, trimmed u, v 0..1: 3 x 2.
    ['a trimmed extrusion', (b) => b.addSurface({ kind: 'rectangularTrimmed', basis: b.addSurface({ kind: 'extrusion',
      curve: b.addCurve({ kind: 'line', point: [0, 0, 0], direction: [1, 0, 0], magnitude: 3 }), direction: [0, 0, 1],
      magnitude: 2 }), u1: 0, u2: 1, v1: 0, v2: 1, uSense: true, vSense: true }), 6, () => true],
    // The line x = 1 along z, magnitude 2, turned about z, trimmed u 0..pi/2, v 0..1: a quarter cylinder 2 high.
    ['a trimmed revolution', (b) => b.addSurface({ kind: 'rectangularTrimmed', basis: b.addSurface({
      kind: 'revolution', curve: b.addCurve({ kind: 'line', point: [1, 0, 0], direction: [0, 0, 1], magnitude: 2 }),
      axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1] }), u1: 0, u2: Math.PI / 2, v1: 0, v2: 1, uSense: true,
    vSense: true }), Math.PI, () => true],
    // The plane z = 0 offset 0.5, trimmed to the unit square: at z = 0.5.
    ['a trimmed offset plane', (b) => b.addSurface({ kind: 'rectangularTrimmed', basis: b.addSurface({ kind: 'offset',
      basis: b.addSurface({ kind: 'plane', position: XY }), distance: 0.5, selfIntersect: false }), u1: 0, u2: 1, v1: 0,
    v2: 1, uSense: true, vSense: true }), 1, (r) => Math.abs(r.positions[2]! - 0.5) < 1e-6],
  ];
  for (const [what, make, area, at] of surfaceCases) {
    const b = new BrepBuilder();
    b.addItem({ kind: 'surface', ref: make(b), id: 5 });
    const r = await run(b);
    noWarnings(r, what);
    const got = faces(r).get(5)?.area ?? 0;
    // (To 1 %: the mesh's own error on the revolution is about 0.2 %; a wrong map is off by a factor.)
    assert.ok(Math.abs(got - area) < 1e-2 * area, `${what}'s area: ${got}`);
    assert.ok(at(r), `${what}'s place`);
  }
  // Curve-bounded faces (edges without vertices). A B-spline plane 0..2 square with an implicit outer bound (its
  // own extent) and a hole of radius 0.5 at its middle; a unit square on a plane, its boundary's segments given out
  // of order (put in order as the translator does).
  {
    const b = new BrepBuilder();
    const s = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
      uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 2, 0]], [[2, 0, 0], [2, 2, 0]]],
      uClosed: false, vClosed: false, selfIntersect: false, form: 'plane_surf' });
    const hole = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...XY, origin: [1, 1, 0] },
      radius: 0.5 }), sameSense: true });
    const face = b.addFace({ surface: s, sameSense: true, id: 5, loops: [{ kind: 'edge', bound: 'inner', sense: true,
      coedges: [{ edge: hole, orientation: 'reversed' }] }] });
    b.addItem({ kind: 'face', ref: face, id: 5 });
    const r = await run(b);
    noWarnings(r, 'an implicit outer bound');
    const got = faces(r).get(5)!.area, want = 4 - Math.PI / 4;
    assert.ok(Math.abs(got - want) < 1e-2, `an implicit outer bound's area: ${got}`);
  }
  {
    const b = new BrepBuilder();
    const c: V3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const es = c.map((p, j) => { const q = c[(j + 1) % 4]!;
      return b.addEdge({ curve: b.addCurve({ kind: 'trimmed', basis: b.addCurve({ kind: 'line', point: p,
        direction: [q[0] - p[0], q[1] - p[1], 0], magnitude: 1 }), trim1: { parameter: 0 }, trim2: { parameter: 1 },
      sense: true, preference: 'parameter' }), sameSense: true, id: 61 + j }); });
    const face = b.addFace({ surface: b.addSurface({ kind: 'plane', position: XY }), sameSense: true, id: 5,
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [2, 0, 3, 1].map((j) => ({ edge: es[j]!,
        orientation: 'forward' as const })) }] });
    b.addItem({ kind: 'face', ref: face, id: 5 });
    const r = await run(b);
    const got = faces(r).get(5)!.area;
    assert.ok(Math.abs(got - 1) < 1e-6, `segments out of order: ${got}`);
    // Each segment's edge by its id, after the fixes that reorder and join them replace their edges (the ids follow
    // the replacements: kept by the edges as made, they'd be lost, or go to whatever edge comes next at an address).
    assert.deepEqual((r.edges ?? []).map((e) => e.entityId).sort(), [61, 62, 63, 64]);
  }
  // A curve-bounded face on a sphere of radius 2 bounded by the circle at z = 1 alone, against the STEP route (whose
  // healing adds no natural bounds there either: the cap, not the rest of the sphere with a hole).
  {
    const b = new BrepBuilder();
    const edge = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: { ...XY, origin: [0, 0, 1] },
      radius: Math.sqrt(3) }), sameSense: true });
    const face = b.addFace({ surface: b.addSurface({ kind: 'sphere', position: XY, radius: 2 }), sameSense: true,
      id: 5, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [{ edge, orientation: 'forward' }] }] });
    b.addItem({ kind: 'face', ref: face, id: 5 });
    const req = request(new Uint8Array(b.finish().buffer));
    const { step } = await both();
    const r1 = await step.tessellate(req), r2 = await native.tessellate(req);
    same(r1, r2, 'a lone boundary on a sphere', 1e-9, req.data);
    const got = faces(r2).get(5)!.area;
    assert.ok(Math.abs(got - 4 * Math.PI) < 0.02 * 4 * Math.PI || Math.abs(got - 12 * Math.PI) < 0.02 * 12 * Math.PI,
      `a lone boundary on a sphere: ${got}`);
  }
});
