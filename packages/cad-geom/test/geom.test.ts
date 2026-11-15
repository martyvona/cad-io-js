// src/index.ts against the module it loads: the reference shapes' curve facts through the API (as native/test's
// curve_test.cpp checks them in C++), every curve and surface of cad-brep's test models against geometry.ts, and the
// layer's own mechanics (batches, statuses for rows that can't be made, the scratch's alternatives, dispose, init
// with a host's module). Skipped, with the reason, where the module isn't built (packages/cad-geom/build.sh module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, openBrep, rowCount } from '../../cad-brep/src/index.ts';
import { curveEvaluator, surfaceEvaluator } from '../../cad-brep/src/geometry.ts';
import { MODELS } from '../../cad-brep/test/models.ts';
import { CERTAINTY, Geometry, init, STATUS } from '../src/index.ts';

const dist = path.join(import.meta.dirname, '../dist');
const built = fs.existsSync(path.join(dist, 'cad_geom.wasm')) && fs.existsSync(path.join(dist, 'cad_geom.mjs'));
const skip = built ? false : 'cad-geom\'s module not built (run packages/cad-geom/build.sh module)';
const refDir = path.join(import.meta.dirname, '../../cad-brep/test/reference/fixtures');

const norm = (a: ArrayLike<number>, b: ArrayLike<number>, at = 0) =>
  Math.hypot(a[at]! - b[0]!, a[at + 1]! - b[1]!, a[at + 2]! - (b[2] ?? 0));
const len = (a: ArrayLike<number>) => Math.hypot(a[0]!, a[1]!, a[2] ?? 0);
const vec3 = (v: number[]) => [v[0]!, v[1]!, v[2] ?? 0];

interface Fact {
  kind: string; curve: number; t: number; t0: number; t1: number; p: number[]; d1: number[]; d2: number[];
  length: number; distance: number; certainty: string; alternatives: number[]; onSeam: boolean; ptol: number;
  tol: number; abs: number;
}

test('reference shapes: every curve fact through the API, at every variant', { skip }, async () => {
  const module = await init();
  let n = 0;
  for (const file of fs.readdirSync(refDir).filter((f) => f.endsWith('.json')).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(refDir, file), 'utf8')) as { facts: Fact[] };
    const g = new Geometry(module, fs.readFileSync(path.join(refDir, file.replace(/\.json$/, '.cbr'))));
    try {
      for (const f of j.facts) {
        const within = (got: number, want: number) => Math.abs(got - want) <= Math.max(f.tol * Math.abs(want), f.abs);
        if (f.kind === 'curvePoint') {
          const r = g.evalCurve(f.curve, [f.t], 2);
          assert.equal(r.status, 'ok', `${file} curve ${f.curve}`);
          assert.equal(r.statuses[0], 0);
          for (const [k, v] of [f.p, f.d1, f.d2].entries()) {
            assert.ok(norm(r.values, vec3(v), 3 * k) <= Math.max(f.tol * len(v), f.abs),
              `${file} curve ${f.curve} at ${f.t}: ${['p', 'd1', 'd2'][k]}`);
          }
        } else if (f.kind === 'curveLength') {
          const r = g.arcLength(f.curve, [f.t0, f.t1], 1e-13);
          assert.equal(STATUS[r.statuses[0]!], 'ok', `${file} curve ${f.curve}`);
          assert.ok(within(r.value[0]!, f.length), `${file} curve ${f.curve}: ${r.value[0]} want ${f.length}`);
        } else if (f.kind === 'curveInverse') {
          const info = g.curveInfo(f.curve);
          const r = g.invertCurve(f.curve, vec3(f.p), info.lo, info.hi, f.abs);
          assert.equal(STATUS[r.statuses[0]!], 'ok');
          assert.ok(Math.abs(r.params[0]! - f.t) <= f.ptol, `${file} curve ${f.curve}: t ${r.params[0]} want ${f.t}`);
          assert.ok(within(r.distance[0]!, f.distance));
          assert.equal(CERTAINTY[r.certainty[0]!], f.certainty);
          assert.equal(r.alternativeCount[0], f.alternatives.length);
          f.alternatives.forEach((a, i) => assert.ok(Math.abs(r.alternatives[i]! - a) <= f.ptol));
          assert.equal(r.flags[0] === 1, f.onSeam);
        } else continue;
        n++;
      }
    } finally {
      g.dispose();
    }
  }
  assert.ok(n > 500, `${n} facts`);
});

test('test models: every curve and surface the module makes agrees with geometry.ts', { skip }, async () => {
  const module = await init();
  let curves = 0, surfaces = 0;
  for (const [name, make] of Object.entries(MODELS)) {
    const buffer = new Uint8Array(make().finish().buffer), d = openBrep(buffer.slice());
    using g = new Geometry(module, buffer);
    assert.equal(g.curves, rowCount(d, 'curve'));
    assert.equal(g.surfaces, rowCount(d, 'surface'));
    for (let i = 0; i < g.curves; i++) {
      const info = g.curveInfo(i), ev = curveEvaluator(d, i);
      if (info.status !== 'ok' || !ev) continue;
      const lo = Number.isFinite(info.lo) ? info.lo : -2, hi = Number.isFinite(info.hi) ? info.hi : 2;
      assert.deepEqual([info.lo, info.hi], [ev.range[0], ev.range[1]], `${name} curve ${i}`);
      const ts = Array.from({ length: 9 }, (_, k) => lo + (hi - lo) * (k + 0.5) / 9);
      const r = g.evalCurve(i, ts, 1), breaks = g.curveBreaks(i, lo, hi).breaks;
      ts.forEach((t, k) => {
        const p = ev.point(t), d1 = ev.d1(t), scale = Math.max(1, len(p));
        assert.ok(norm(r.values, vec3(p), 6 * k) <= 1e-12 * scale, `${name} curve ${i} at ${t}`);
        // geometry.ts's offset derivative is a central difference, so across a break (an offset's tangent turns
        // with its basis's curvature, which jumps at a knot) it averages the two sides: not compared there.
        if (breaks.some((b) => Math.abs(b - t) < 1e-6)) return;
        assert.ok(norm(r.values, vec3(d1), 6 * k + 3) <= 1e-6 * Math.max(1, len(d1)), `${name} curve ${i}' at ${t}`);
      });
      curves++;
    }
    for (let i = 0; i < g.surfaces; i++) {
      const info = g.surfaceInfo(i), ev = surfaceEvaluator(d, i);
      if (info.status !== 'ok' || !ev) continue;
      const fin = (r: [number, number]) => [Number.isFinite(r[0]) ? r[0] : -2, Number.isFinite(r[1]) ? r[1] : 2];
      const [u0, u1] = fin(info.u), [v0, v1] = fin(info.v), uv: number[] = [];
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
        uv.push(u0! + (u1! - u0!) * (a + 0.5) / 3, v0! + (v1! - v0!) * (b + 0.5) / 3);
      }
      const r = g.evalSurface(i, uv, 1);
      for (let k = 0; k < 9; k++) {
        const u = uv[2 * k]!, v = uv[2 * k + 1]!, p = ev.point(u, v), [du, dv] = ev.d1(u, v);
        assert.ok(norm(r.values, p, 9 * k) <= 1e-12 * Math.max(1, len(p)), `${name} surface ${i} at ${u}, ${v}`);
        assert.ok(norm(r.values, du!, 9 * k + 3) <= 1e-9 * Math.max(1, len(du!)));
        assert.ok(norm(r.values, dv!, 9 * k + 6) <= 1e-9 * Math.max(1, len(dv!)));
      }
      surfaces++;
    }
  }
  assert.ok(curves > 50 && surfaces > 10, `${curves} curves, ${surfaces} surfaces`);
});

test('batches: shapes, statuses per item and per row, alternatives from the scratch', { skip }, async () => {
  const module = await init();
  const ref = (f: string) => fs.readFileSync(path.join(refDir, f));
  using g = new Geometry(module, ref('curves-s1.cbr'));
  // Row 5 is the circle (radius 2): its domain, a batch of evaluations, one out of a polyline's domain.
  const c = g.curveInfo(5);
  assert.deepEqual([c.status, c.dim, c.lo, c.period], ['ok', 3, 0, 2 * Math.PI]);
  const e = g.evalCurve(5, [0, 1, 2, 3], 2);
  assert.equal(e.values.length, 4 * 9);
  assert.equal(e.statuses.length, 4);
  const pl = g.evalCurve(4, [-1, 1], 0);
  assert.deepEqual(Array.from(pl.statuses, (s) => STATUS[s]), ['outOfDomain', 'ok']);
  // A row that doesn't exist: its status, empty arrays, nothing thrown.
  const bad = g.evalCurve(g.curves + 3, [0, 1], 1);
  assert.equal(bad.status, 'invalidModel');
  assert.equal(bad.values.length, 0);
  assert.equal(g.curveInfo(-1).status, 'invalidModel');
  assert.equal(g.curveBreaks(g.curves, 0, 1).status, 'invalidModel');
  // Bounds hold the evaluations; derivative bounds the speed.
  const b = g.curveBound(5, [0, 1, 2, 4]);
  assert.equal(b.boxes.length, 12);
  const s = g.curveDerivBound(5, [0, 1], 1);
  assert.ok(s.bounds[0]! >= 2 && s.bounds[0]! < 2 + 1e-9);
  // The parabola's ambiguous foot in the catalogue: its alternative through the scratch.
  using p = new Geometry(module, ref('case-parabolic-s1.cbr'));
  const inv = p.invertCurve(0, [3, 0, 0, 1.5, 0, 0], -3, 3, 1e-9);
  assert.deepEqual(Array.from(inv.certainty, (k) => CERTAINTY[k]), ['ambiguous', 'unique']);
  assert.deepEqual(Array.from(inv.alternativeCount), [1, 0]);
  assert.equal(inv.alternatives.length, 1);
  assert.ok(Math.abs(inv.params[0]! + 1) < 1e-9 && Math.abs(inv.alternatives[0]! - 1) < 1e-9);
  // Lengths and their inverse round trip.
  const L = g.arcLength(5, [0, 1, 1, 3], 1e-12);
  assert.deepEqual(Array.from(L.value, (v) => Math.round(v * 1e9) / 1e9), [2, 4]);
  const t = g.paramAtLength(5, [0, 1], [2, 4], 1e-12);
  assert.ok(Math.abs(t.value[0]! - 1) < 1e-10 && Math.abs(t.value[1]! - 3) < 1e-10);
  // The cusp's singular parameter; breaks.
  using sg = new Geometry(module, ref('case-singular-s1.cbr'));
  const z = sg.curveSingular(6, 0, 1);
  assert.equal(z.params.length, 1);
  assert.ok(Math.abs(z.params[0]! - 0.5) < 1e-9);
  assert.deepEqual(Array.from(g.curveBreaks(4, 0, 3).breaks), [0, 1, 2, 3]);
  // Surfaces: the sphere's poles, an inversion, a normal.
  using sp = new Geometry(module, ref('sphere-s1.cbr'));
  const sing = sp.surfaceSingularities(0);
  if (sing.status === 'ok') assert.ok(sing.singularities.every((x) => x.kind === 'pole'));
  const si = sp.surfaceInfo(0);
  if (si.status === 'ok') {
    const n = sp.surfaceNormal(0, [0.3, 0.2]);
    assert.ok(Math.abs(len(n.values) - 1) < 1e-12);
    const q = sp.evalSurface(0, [0.3, 0.2], 0).values;
    const r = sp.invertSurface(0, q, [si.u[0], si.u[1], si.v[0], si.v[1]], 1e-9);
    assert.equal(STATUS[r.statuses[0]!], 'ok');
    assert.ok(r.distance[0]! < 1e-9);
  }
});

test('a buffer that isn\'t a model throws; use after dispose throws; a host\'s glue and wasm', { skip }, async () => {
  const module = await init();
  assert.throws(() => new Geometry(module, new Uint8Array(64)), /not a B-rep buffer/);
  const g = new Geometry(module, new Uint8Array(MODELS.cube().finish().buffer));
  g.dispose();
  assert.throws(() => g.curveInfo(0), /after dispose/);
  g.dispose();  // twice is harmless
  // The host's own copy of the module: bytes and the glue's URL.
  const own = await init({ glue: new URL('../dist/cad_geom.mjs', import.meta.url),
    wasm: fs.readFileSync(path.join(dist, 'cad_geom.wasm')) });
  assert.notEqual(own, module);
  using h = new Geometry(own, new Uint8Array(MODELS.cube().finish().buffer));
  assert.equal(h.curveInfo(0).status, 'ok');
  assert.equal(await init(), module);  // the default is shared
});

test('faces: the catalogue\'s classify2 and nest2 cases through the API (loops, periods, poles, tolerances made '
  + 'from the model)', { skip }, async () => {
  const module = await init();
  let classified = 0, nested = 0, waiting = 0;
  // The reference makeSurface makes planes, cylinders, spheres and B-splines (1, 2, 4, 6): a face on another kind
  // (a cone, a torus) is unsupported until the surfaces lane's merge, and waits.
  let d!: ReturnType<typeof openBrep>;
  const unsupported = (_file: string, face: number, status: string) =>
    status === 'unsupported' && ![1, 2, 4, 6].includes(d.surface.kind[d.face.surface[face]!]!) ? (waiting++, true)
      : false;
  for (const file of fs.readdirSync(refDir).filter(f => /^case-.*\.json$/.test(f)).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(refDir, file), 'utf8'));
    const g = new Geometry(module, new Uint8Array(fs.readFileSync(path.join(refDir, file.replace('.json', '.cbr')))));
    try {
      d = openBrep(new Uint8Array(fs.readFileSync(path.join(refDir, file.replace('.json', '.cbr')))));
      for (const c of j.cases) {
        if (c.query === 'classify2') {
          const r = g.classifyOnFace(c.input.face, c.input.p, c.input.tol);
          if (unsupported(file, c.input.face, r.status)) continue;
          assert.equal(r.status, 'ok', c.id);
          assert.equal(['in', 'out', 'on'][r.sides[0]!], c.expected.side, c.id);
          classified++;
        } else if (c.query === 'nest2') {
          const loops = d.face.loopCount[c.input.face]!;
          const r = g.nestFace(c.input.face, loops, c.input.tol);
          if (unsupported(file, c.input.face, r.status)) continue;
          assert.equal(r.status, 'ok', c.id);
          assert.deepEqual([...r.parents], c.expected.parents, c.id);
          nested++;
        }
      }
      // The face's info: the cone's apex as its pole line, a cylinder's period.
      if (file === 'case-singular-s1.json') {
        const info = g.faceInfo(0);
        if (info.status === 'unsupported') continue;  // the cone, until the surfaces lane's merge
        assert.equal(info.status, 'ok');
        assert.equal(info.poles.length, 1);
        assert.ok(Math.abs(info.poles[0]!.at + 1) < 1e-12 && !info.poles[0]!.isoU);
        assert.ok(Math.abs(info.uPeriod - 2 * Math.PI) < 1e-15);
      }
      if (file === 'case-tangent-s1.json') {
        const self = g.selfIntersectFace(1, 0);
        assert.equal(self.status, 'ok');
        assert.equal(self.touches, 1);
        assert.equal(self.crossings, 0);
      }
    } finally {
      g.dispose();
    }
  }
  assert.equal(classified + nested + waiting, 35);
  assert.ok(waiting <= 8);  // the torus's 5, the cone's 3
});

/** The ways ownRangeDisk's face is made. */
interface DiskVariant {
  /** The p-curves run against the angle. */
  backwards?: boolean;
  /** One closed edge from angle 3, not two arcs. */
  closedEdge?: boolean;
  /** The first vertex at angle 0, where the p-curves' ends meet, not 0.5. */
  atClosure?: boolean;
  /** The face against its surface's sense, its coedges reversed (the same disk). */
  flipped?: boolean;
  /** The 3D curve the B-spline circle and the p-curves 2D circles, on a plane facing -z (so running clockwise). */
  periodic?: boolean;
  /** The part's uncertainty (mm): 0.05 puts the circle's parameters on the p-curves within 100 x of the vertices. */
  uncertainty?: number;
  /** The p-curves moved 0.5 in u, off the edges: neither parameterization reaches the vertices. */
  moved?: boolean;
}

/**
 * A disk of radius 2 on the plane z = 0, bounded by two arcs of one circle (vertices at angles 0.5 and 3), their
 * p-curves rational B-spline circles parameterized their own way (t in [0, 4], from angle 0, the angle's way or the
 * other): neither the circle's parameters nor its range reach the vertices on them, and the second arc's use crosses
 * the p-curve's ends.
 */
function ownRangeDisk(o: DiskVariant): Uint8Array {
  const b = new BrepBuilder(o.uncertainty ? { uncertainty: o.uncertainty } : {});
  const w = Math.SQRT1_2, r = 2;
  const square = [[r, 0], [r, r], [0, r], [-r, r], [-r, 0], [-r, -r], [0, -r], [r, -r], [r, 0]];
  const poles = (o.backwards ? square.map(([x, y]) => [x!, -y!]) : square)
    .map(([x, y]) => [x! + (o.moved ? 0.5 : 0), y!]);
  const spline = (dim: number) => b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1, 2, 3, 4],
    multiplicities: [3, 2, 2, 2, 3], poles: poles.map((q) => dim === 3 ? [...q, 0] : q),
    weights: [1, w, 1, w, 1, w, 1, w, 1], closed: true, selfIntersect: false, form: 'circular_arc' });
  const pc = o.periodic ? b.addCurve({ kind: 'circle', position: { origin: [0, 0], xDir: [1, 0] }, radius: r })
    : spline(2);
  const curve = o.periodic ? spline(3) : b.addCurve({ kind: 'circle',
    position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] }, radius: r });
  const plane = b.addSurface({ kind: 'plane',
    position: { origin: [0, 0, 0], axis: [0, 0, o.periodic ? -1 : 1], xDir: [1, 0, 0] } });
  const a0 = o.atClosure ? 0 : 0.5;
  const v0 = b.addVertex({ point: [r * Math.cos(a0), r * Math.sin(a0), 0] });
  const v1 = b.addVertex({ point: [r * Math.cos(3), r * Math.sin(3), 0] });
  const e0 = b.addEdge({ curve, start: v0, end: v1, sameSense: true });
  const e1 = b.addEdge({ curve, start: v1, end: o.closedEdge ? v1 : v0, sameSense: true });
  let coedges = [{ edge: e0, orientation: 'forward' as 'forward' | 'reversed', pcurve: pc },
    { edge: e1, orientation: 'forward' as 'forward' | 'reversed', pcurve: pc }];
  if (o.closedEdge) coedges = coedges.slice(1);
  // The loop runs counterclockwise about +z: about the face's normal where it's +z, else the face's loops reversed.
  const flipped = o.flipped !== o.periodic;
  if (o.flipped) coedges = coedges.reverse().map((c) => ({ ...c, orientation: 'reversed' as const }));
  const f = b.addFace({ surface: plane, sameSense: !flipped, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges }] });
  b.addItem({ kind: 'face', ref: f });
  return new Uint8Array(b.finish().buffer);
}

test('faces: p-curves parameterized otherwise than their curves get their own ranges, a use across a closed '
  + 'p-curve\'s ends two pieces', { skip }, async () => {
  const module = await init();
  const variants: DiskVariant[] = [{}, { backwards: true }, { closedEdge: true }, { backwards: true, closedEdge: true },
    { atClosure: true }, { backwards: true, atClosure: true }, { flipped: true }, { backwards: true, flipped: true },
    { flipped: true, closedEdge: true }, { periodic: true }, { periodic: true, flipped: true }, { uncertainty: 0.05 },
    { moved: true }];
  for (const o of variants) {
    const name = JSON.stringify(o), buffer = ownRangeDisk(o), d = openBrep(buffer.slice());
    using g = new Geometry(module, buffer);
    const info = g.faceInfo(0);
    if (o.moved) {
      assert.equal(info.status, 'pcurveRangeOff', name);
      continue;
    }
    assert.equal(info.status, 'ok', name);
    assert.equal(info.ownRanges, o.closedEdge ? 1 : 2, name);
    const pieces = g.facePieces(0);
    // Pieces in travel order: the first arc (coedge e0's) from angle 0.5 to 3, the second on through angle 0 (where
    // the p-curve's ends meet: two pieces), the face's loop reversed where it's flipped.
    const wraps = !o.periodic && !o.atClosure;
    let expected = o.closedEdge ? [0, 0] : wraps ? [0, 1, 1] : [0, 1];
    if (o.flipped && !o.closedEdge) expected = wraps ? [0, 0, 1] : [0, 1];
    if (o.flipped !== o.periodic) expected = expected.reverse();
    assert.deepEqual([...pieces.coedge], expected, name);
    const angleAt = (t: number) => {
      const p = g.evalCurve(d.coedge.pcurve[0]!, [t], 0).values;
      const a = Math.atan2(o.periodic ? -p[1]! : p[1]!, p[0]!);
      return a < -1e-9 ? a + 2 * Math.PI : a;
    };
    // Each piece's ends at the angles they should be at, the face's sense its surface's: 0.5 or 0, 3, 2 pi or 0.
    const ends = [...pieces.travel].map(angleAt);
    const a0 = o.atClosure ? 0 : 0.5;
    const near = (x: number, want: number[]) => want.some((y) => Math.abs(x - y) < 1e-9 || Math.abs(x - y - 2 * Math.PI)
      < 1e-9 || Math.abs(x - y + 2 * Math.PI) < 1e-9);
    for (const x of ends) assert.ok(near(x, [a0, 3, 0]), `${name}: ${ends}`);
    if (!o.flipped && !o.periodic && !o.closedEdge) {
      assert.ok(near(ends[0]!, [a0]) && near(ends[1]!, [3]) && near(ends[2]!, [3]), `${name}: ${ends}`);
    }
    if (wraps && !o.closedEdge && !o.flipped) assert.deepEqual([pieces.travel[3], pieces.travel[4]].sort(), [0, 4]);
    const points = [[0, 0], [0, 1.9], [0, -1.9], [1.9, 0], [-1.9, 0], [0, 2.1], [0, -2.1], [2.1, 0], [-2.1, 0], [2, 0],
      [2 * Math.cos(4.5), 2 * Math.sin(4.5)]];
    const r = g.classifyOnFace(0, points.flat());
    assert.equal(r.status, 'ok', name);
    assert.deepEqual([...r.sides].map(s => ['in', 'out', 'on'][s]),
      ['in', 'in', 'in', 'in', 'in', 'out', 'out', 'out', 'out', 'on', 'on'], name);
  }
});

test('faces: p-curves periods from the surface\'s domain (u from -pi/4 - 4 pi to -4 pi on a cylinder) get their '
  + 'own ranges', { skip }, async () => {
  // A cylinder's patch, u in [-pi/4, 0] (its p-curves two periods below), v in [0, 1], its p-curves degree-1
  // B-splines on [0, 1] in (u, v): the arcs' circle parameters (near 7 pi / 4 to 2 pi) miss them, and the vertices'
  // (u, v) on the cylinder are periods off.
  const b = new BrepBuilder();
  const r = 2, a = -Math.PI / 4, off = -4 * Math.PI;
  const z = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const cyl = b.addSurface({ kind: 'cylinder', position: z, radius: r });
  const pline = (p: number[], q: number[]) => b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1],
    multiplicities: [2, 2], poles: [[p[0]! + off, p[1]!], [q[0]! + off, q[1]!]], closed: false, selfIntersect: false,
    form: 'polyline_form' });
  const at = (u: number, v: number) => [r * Math.cos(u), r * Math.sin(u), v];
  const [va, vb, vc, vd] = [at(a, 0), at(0, 0), at(0, 1), at(a, 1)].map((p) => b.addVertex({ point: p }));
  const bottom = b.addCurve({ kind: 'circle', position: z, radius: r });
  const top = b.addCurve({ kind: 'circle', position: { ...z, origin: [0, 0, 1] }, radius: r });
  const up = (p: number[]) => b.addCurve({ kind: 'line', point: p, direction: [0, 0, 1], magnitude: 1 });
  const e0 = b.addEdge({ curve: bottom, start: va, end: vb, sameSense: true });
  const e1 = b.addEdge({ curve: up(at(0, 0)), start: vb, end: vc, sameSense: true });
  const e2 = b.addEdge({ curve: top, start: vd, end: vc, sameSense: true });
  const e3 = b.addEdge({ curve: up(at(a, 0)), start: va, end: vd, sameSense: true });
  const f = b.addFace({ surface: cyl, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: e0, orientation: 'forward', pcurve: pline([a, 0], [0, 0]) },
    { edge: e1, orientation: 'forward', pcurve: pline([0, 0], [0, 1]) },
    { edge: e2, orientation: 'reversed', pcurve: pline([a, 1], [0, 1]) },
    { edge: e3, orientation: 'reversed', pcurve: pline([a, 0], [a, 1]) }] }] });
  b.addItem({ kind: 'face', ref: f });
  using g = new Geometry(await init(), new Uint8Array(b.finish().buffer));
  const info = g.faceInfo(0);
  assert.equal(info.status, 'ok');
  assert.equal(info.ownRanges, 2);
  const tau = 2 * Math.PI;
  const r0 = g.classifyOnFace(0, [-0.4, 0.5, -0.4 + tau, 0.5, 0.4, 0.5, -1, 0.5, -0.4, 1.5, -0.4, -0.5, 0, 0.5]);
  assert.equal(r0.status, 'ok');
  assert.deepEqual([...r0.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'in', 'out', 'out', 'out', 'out', 'on']);
});

test('faces: line p-curves scaled otherwise than their 3D lines get their own ranges', { skip }, async () => {
  // A unit square on z = 0, its edges 3D lines on t in [0, 1], its p-curves lines on t in [0, 100] (magnitude 0.01,
  // as brep_wv1/2 write them the other way round): unbounded p-curves, sampled over the curve's parameters.
  const b = new BrepBuilder();
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const vs = corners.map(([x, y]) => b.addVertex({ point: [x!, y!, 0] }));
  const coedges = corners.map(([x, y], k) => {
    const [nx, ny] = corners[(k + 1) % 4]!, dir = [nx! - x!, ny! - y!];
    const line = b.addCurve({ kind: 'line', point: [x!, y!, 0], direction: [...dir, 0], magnitude: 1 });
    const pcurve = b.addCurve({ kind: 'line', point: [x!, y!], direction: dir, magnitude: 0.01 });
    const edge = b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true });
    return { edge, orientation: 'forward' as const, pcurve };
  });
  const f = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges }] });
  b.addItem({ kind: 'face', ref: f });
  using g = new Geometry(await init(), new Uint8Array(b.finish().buffer));
  const info = g.faceInfo(0);
  assert.equal(info.status, 'ok');
  assert.equal(info.ownRanges, 4);
  const t = [...g.facePieces(0).travel];
  for (let k = 0; k < 4; k++) assert.ok(Math.abs(t[2 * k]!) < 1e-9 && Math.abs(t[2 * k + 1]! - 100) < 1e-7, `${t}`);
  const r = g.classifyOnFace(0, [0.5, 0.5, 1.5, 0.5, 0.5, -0.5, 1, 0.5]);
  assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'out', 'on']);
});
