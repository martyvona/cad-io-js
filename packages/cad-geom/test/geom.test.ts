// src/index.ts against the module it loads: the reference shapes' curve facts through the API (as native/test's
// curve_test.cpp checks them in C++), every curve and surface of cad-brep's test models against geometry.ts, and the
// layer's own mechanics (batches, statuses for rows that can't be made, the scratch's alternatives, dispose, init
// with a host's module). Skipped, with the reason, where the module isn't built (packages/cad-geom/build.sh module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { BrepBuilder, LOOP_KIND, openBrep, rowCount, SURFACE_KIND } from '../../cad-brep/src/index.ts';
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
      // geometry.ts's offset partials are central differences (a step of 1e-7), good to about 1e-9 of the
      // coordinates; cad-geom's are exact.
      const tol = SURFACE_KIND.offset === d.surface.kind[i] ? 1e-7 : 1e-9;
      for (let k = 0; k < 9; k++) {
        const u = uv[2 * k]!, v = uv[2 * k + 1]!, p = ev.point(u, v), [du, dv] = ev.d1(u, v);
        assert.ok(norm(r.values, p, 9 * k) <= 1e-12 * Math.max(1, len(p)), `${name} surface ${i} at ${u}, ${v}`);
        assert.ok(norm(r.values, du!, 9 * k + 3) <= tol * Math.max(1, len(du!)), `${name} surface ${i} S_u`);
        assert.ok(norm(r.values, dv!, 9 * k + 6) <= tol * Math.max(1, len(dv!)), `${name} surface ${i} S_v`);
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

/** A degree-1 B-spline curve (2D or 3D) through two points on [0, 1]. */
function segment(b: BrepBuilder, p: number[], q: number[]): number {
  return b.addCurve({ kind: 'bspline', degree: 1, knots: [0, 1], multiplicities: [2, 2], poles: [p, q], closed: false,
    selfIntersect: false, form: 'polyline_form' });
}

test('faces: a B-spline\'s collapsed side is a pole line; a surface closed in fact gets a period', { skip },
  async () => {
  const module = await init();
  {
    // A bilinear patch with its v = 0 side one point (poles[u][v]: poles[0][0] = poles[1][0]): a triangle whose loop
    // leaves out the degenerate side, jumping from (0, 0) to (1, 0) along it.
    const b = new BrepBuilder();
    const A = [0, 0, 0], B = [-1, 1, 0], C = [1, 1, 0];
    const surf = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
      uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[A, B], [A, C]], uClosed: false, vClosed: false,
      selfIntersect: false, form: 'unspecified' });
    const [va, vb, vc] = [A, B, C].map((p) => b.addVertex({ point: p }));
    const edge = (from: number, to: number, p: number[], q: number[]) =>
      b.addEdge({ curve: segment(b, p, q), start: from, end: to, sameSense: true });
    const coedges = [[edge(va!, vc!, A, C), [1, 0], [1, 1]], [edge(vc!, vb!, C, B), [1, 1], [0, 1]],
      [edge(vb!, va!, B, A), [0, 1], [0, 0]]].map(([e, p, q]) => ({ edge: e as number, orientation: 'forward' as const,
      pcurve: segment(b, p as number[], q as number[]) }));
    const f = b.addFace({ surface: surf, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges }] });
    b.addItem({ kind: 'face', ref: f });
    using g = new Geometry(module, new Uint8Array(b.finish().buffer));
    const info = g.faceInfo(0);
    assert.equal(info.status, 'ok');
    assert.deepEqual(info.poles, [{ isoU: false, at: 0 }]);
    const r = g.classifyOnFace(0, [0.5, 0.5, 0.5, 1.5, 0.5, 0]);
    assert.deepEqual([...r.statuses], [0, 0, 0]);
    assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'on']);
  }
  // (lines, gap, uncertainty, face tolerance, the period: closed in fact within the larger of the part's uncertainty
  // and the face's tolerance, else 1e-7.)
  for (const [lines, gap, uncertainty, tolerance, period] of [[false, 0, NaN, NaN, 4], [true, 0, NaN, NaN, 4],
    [false, 5e-4, 1e-3, NaN, 4], [false, 5e-4, NaN, 1e-3, 4], [false, 5e-8, NaN, NaN, 4],
    [false, 5e-4, NaN, NaN, 0]] as [boolean, number, number, number, number][]) {
    // A tube (degree 1 around a diamond in v on [0, 4], closed in fact, not periodic; u its height), its face the
    // side v in [3, 4] up to the seam. The sides' p-curves are on [0, 1] and their 3D lines on [0, sqrt 2], so their
    // ranges are their own, through the vertices at v = 4, which invert to v = 0: a period off. With `lines`, every
    // p-curve is an unbounded line scaled 16 x (t in [0, 1 / 16] per unit), whose box, sampled over the 3D lines'
    // parameters, reaches v = 25.6, periods off: the vertices' copies are chosen around the first vertex, then along
    // the edge. With a gap, its first section (v = 0) moved that far along y: open by that much.
    const b = new BrepBuilder(Number.isNaN(uncertainty) ? {} : { uncertainty });
    const diamond = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 0]];
    const surf = b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1, 2, 3, 4],
      uMultiplicities: [2, 2], vMultiplicities: [2, 1, 1, 1, 2],
      poles: [0, 1].map((z) => diamond.map(([x, y], k) => [x!, y! + (k === 0 ? gap : 0), z])), uClosed: false,
      vClosed: true, selfIntersect: false, form: 'unspecified' });
    const P = [[0, -1, 0], [0, -1, 1], [1, 0, 1], [1, 0, 0]];
    const vs = P.map((p) => b.addVertex({ point: p }));
    const uv = [[0, 3], [1, 3], [1, 4], [0, 4]];
    const coedges = [0, 1, 2, 3].map((k) => {
      const p = P[k]!, q = P[(k + 1) % 4]!, len = Math.hypot(q[0]! - p[0]!, q[1]! - p[1]!, q[2]! - p[2]!);
      const line = b.addCurve({ kind: 'line', point: p, direction: q.map((x, i) => (x - p[i]!) / len), magnitude: 1 });
      const edge = b.addEdge({ curve: line, start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true });
      const [a, c] = [uv[k]!, uv[(k + 1) % 4]!], l2 = Math.hypot(c[0]! - a[0]!, c[1]! - a[1]!);
      const direction = [(c[0]! - a[0]!) / l2, (c[1]! - a[1]!) / l2];
      const pcurve = lines ? b.addCurve({ kind: 'line', point: a, direction, magnitude: 16 }) : segment(b, a, c);
      return { edge, orientation: 'forward' as const, pcurve };
    });
    const f = b.addFace({ surface: surf, sameSense: true, ...(Number.isNaN(tolerance) ? {} : { tolerance }),
      loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges }] });
    b.addItem({ kind: 'face', ref: f });
    using g = new Geometry(module, new Uint8Array(b.finish().buffer));
    const info = g.faceInfo(0);
    assert.equal(info.status, 'ok', `gap ${gap}`);
    assert.equal(info.vPeriod, period, `gap ${gap}, uncertainty ${uncertainty}, face tolerance ${tolerance}`);
    if (gap) continue;
    assert.equal(info.ownRanges, lines ? 4 : 2);
    const r = g.classifyOnFace(0, [0.5, 3.5, 0.5, 2.5, 0.5, 0.5, 1.5, 3.5]);
    assert.deepEqual([...r.statuses], [0, 0, 0, 0]);
    assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'out', 'out']);
  }
});

test('faces: joints that meet within the 3D tolerance but not the (u, v) one are bridged, not gaps', { skip },
  async () => {
  // A cylinder of radius 100, its patch u in [0, 0.01], v in [0, 1]; the left side's p-curve 1e-6 high in v: its
  // joints meet within the part's 2e-6 in 3D, though 50 x the (u, v) tolerance (2e-6 / 100). Moved 1e-7 in u (1e-5
  // in 3D, along a line no reparameterization brings to the vertices) they don't: a gap. 1e-9 high, geom2d joins them
  // itself: no bridge, which would part the pieces either side so that they touch across it.
  const module = await init();
  for (const [du, dv] of [[0, 1e-6], [1e-7, 0], [0, 1e-9]]) {
  const b = new BrepBuilder({ uncertainty: 2e-6 });
  const R = 100, w = 0.01;
  const z = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const cyl = b.addSurface({ kind: 'cylinder', position: z, radius: R });
  const at = (u: number, v: number) => [R * Math.cos(u), R * Math.sin(u), v];
  const [v0, v1, v2, v3] = [at(0, 0), at(w, 0), at(w, 1), at(0, 1)].map((p) => b.addVertex({ point: p }));
  const line2 = (p: number[], d: number[]) => b.addCurve({ kind: 'line', point: p, direction: d, magnitude: 1 });
  const up = (p: number[]) => b.addCurve({ kind: 'line', point: p, direction: [0, 0, 1], magnitude: 1 });
  const circle = (h: number) => b.addCurve({ kind: 'circle', position: { ...z, origin: [0, 0, h] }, radius: R });
  const e0 = b.addEdge({ curve: circle(0), start: v0, end: v1, sameSense: true });
  const e1 = b.addEdge({ curve: up(at(w, 0)), start: v1, end: v2, sameSense: true });
  const e2 = b.addEdge({ curve: circle(1), start: v3, end: v2, sameSense: true });
  const e3 = b.addEdge({ curve: up(at(0, 0)), start: v0, end: v3, sameSense: true });
  const f = b.addFace({ surface: cyl, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true, coedges: [
    { edge: e0, orientation: 'forward', pcurve: line2([0, 0], [1, 0]) },
    { edge: e1, orientation: 'forward', pcurve: line2([w, 0], [0, 1]) },
    { edge: e2, orientation: 'reversed', pcurve: line2([0, 1], [1, 0]) },
    { edge: e3, orientation: 'reversed', pcurve: line2([du!, dv!], [0, 1]) }] }] });
  b.addItem({ kind: 'face', ref: f });
  using g = new Geometry(module, new Uint8Array(b.finish().buffer));
  const r = g.classifyOnFace(0, [w / 2, 0.5, 2 * w, 0.5, w / 2, 1.5]);
  assert.equal(r.status, 'ok');
  assert.deepEqual([...r.statuses].map((x) => STATUS[x]), Array(3).fill(du ? 'invalidModel' : 'ok'));
  assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'out']);
  assert.ok(r.tolerance[0]! < 1e-7);
  // (Bridged, the left side's overshoot doubles back over itself by 1e-6 in v: an overlap at the (u, v) tolerance.)
  const self = g.selfIntersectFace(0, 0);
  if (dv === 1e-9) assert.deepEqual([self.self, self.crossings, self.touches, self.overlaps], ['ok', 0, 0, 0]);
  }
});

test('faces: edges without 3D curves take their p-curves\' own ranges', { skip }, async () => {
  const module = await init();
  const plane = (b: BrepBuilder) => b.addSurface({ kind: 'plane',
    position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  {
    // A unit square whose edges have vertices but no 3D curves, its p-curves segments on [0, 1]. (An unbounded
    // p-curve there has nothing to sample its search box over: pcurveRangeOff.)
    const b = new BrepBuilder();
    const s = plane(b), P = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const vs = P.map((p) => b.addVertex({ point: [...p, 0] }));
    const coedges = [0, 1, 2, 3].map((k) => {
      const p = P[k]!, q = P[(k + 1) % 4]!;
      const edge = b.addEdge({ start: vs[k]!, end: vs[(k + 1) % 4]!, sameSense: true });
      return { edge, orientation: 'forward' as const, pcurve: segment(b, p, q) };
    });
    const f = b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges }] });
    b.addItem({ kind: 'face', ref: f });
    using g = new Geometry(module, new Uint8Array(b.finish().buffer));
    const info = g.faceInfo(0);
    assert.equal(info.status, 'ok');
    assert.equal(info.ownRanges, 4);
    const r = g.classifyOnFace(0, [0.5, 0.5, 1.5, 0.5]);
    assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out']);
  }
});

test('faces: p-curves ending a few ulps past a sphere\'s pole reach it', { skip }, async () => {
  // A unit sphere's octant: the equator from (1, 0, 0) to (0, 1, 0), meridians up to the pole and down, its p-curves
  // segments on [0, 1] (own ranges: the circles' parameters run to pi / 2), the meridians' ending at v = pi / 2 a
  // few ulps past it, outside the sphere's domain unless taken onto its end.
  const b = new BrepBuilder();
  const sphere = b.addSurface({ kind: 'sphere', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const [A, B, P] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((p) => b.addVertex({ point: p }));
  const circle = (axis: number[], xDir: number[]) => b.addCurve({ kind: 'circle',
    position: { origin: [0, 0, 0], axis, xDir }, radius: 1 });
  const h = Math.PI / 2, top = h + 1e-15;
  const e0 = b.addEdge({ curve: circle([0, 0, 1], [1, 0, 0]), start: A, end: B, sameSense: true });
  const e1 = b.addEdge({ curve: circle([1, 0, 0], [0, 1, 0]), start: B, end: P, sameSense: true });
  const e2 = b.addEdge({ curve: circle([0, -1, 0], [1, 0, 0]), start: A, end: P, sameSense: true });
  const f = b.addFace({ surface: sphere, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e0, orientation: 'forward', pcurve: segment(b, [0, 0], [h, 0]) },
      { edge: e1, orientation: 'forward', pcurve: segment(b, [h, 0], [h, top]) },
      { edge: e2, orientation: 'reversed', pcurve: segment(b, [0, 0], [0, top]) }] }] });
  b.addItem({ kind: 'face', ref: f });
  using g = new Geometry(await init(), new Uint8Array(b.finish().buffer));
  const info = g.faceInfo(0);
  assert.equal(info.status, 'ok');
  assert.equal(info.ownRanges, 3);
  const r = g.classifyOnFace(0, [h / 2, h / 2, Math.PI, h / 2, h / 2, -0.3]);
  assert.deepEqual([...r.statuses], [0, 0, 0]);
  assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'out']);
});

/** A copy of the model with every coedge's p-curve and its range removed, as a STEP file without p-curves gives. */
function stripped(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  const d = openBrep(copy);
  d.coedge.pcurve.fill(-1);
  d.coedge.range.fill(NaN);
  return copy;
}

test('projection: the catalogue\'s classify2 and nest2 cases with every p-curve removed, the face API projecting '
  + 'them', { skip }, async () => {
  const module = await init();
  let classified = 0, nested = 0, projected = 0;
  for (const file of fs.readdirSync(refDir).filter(f => /^case-.*\.json$/.test(f)).sort()) {
    const j = JSON.parse(fs.readFileSync(path.join(refDir, file), 'utf8'));
    const bytes = stripped(new Uint8Array(fs.readFileSync(path.join(refDir, file.replace('.json', '.cbr')))));
    using g = new Geometry(module, bytes);
    const d = openBrep(bytes);
    for (const c of j.cases) {
      if (c.query !== 'classify2' && c.query !== 'nest2') continue;
      const info = g.faceInfo(c.input.face);
      assert.equal(info.status, 'ok', c.id);
      assert.ok(info.projected > 0, c.id);
      projected += info.projected;
      if (c.query === 'classify2') {
        const r = g.classifyOnFace(c.input.face, c.input.p, c.input.tol);
        assert.equal(r.status, 'ok', c.id);
        assert.equal(['in', 'out', 'on'][r.sides[0]!], c.expected.side, c.id);
        classified++;
      } else {
        const r = g.nestFace(c.input.face, d.face.loopCount[c.input.face]!, c.input.tol);
        assert.equal(r.status, 'ok', c.id);
        assert.deepEqual([...r.parents], c.expected.parents, c.id);
        nested++;
      }
    }
    // Off, the face API says so instead.
    g.setProjectMissingPcurves(false);
    for (let f = 0; f < rowCount(d, 'face'); f++) assert.equal(g.faceInfo(f).status, 'noPcurve');
  }
  assert.equal(classified + nested, 35);
  assert.ok(projected > 35);
});

test('projection: every reference shape\'s faces with their p-curves removed against the model\'s, at every variant',
  { skip }, async () => {
  const module = await init();
  let faces = 0, compared = 0, seams = 0, points = 0;
  for (const file of fs.readdirSync(refDir).filter((f) => f.endsWith('.cbr') && !f.startsWith('case-')).sort()) {
    const bytes = new Uint8Array(fs.readFileSync(path.join(refDir, file)));
    using g0 = new Geometry(module, bytes);
    using g = new Geometry(module, stripped(bytes));
    const d = openBrep(bytes);
    for (let f = 0; f < rowCount(d, 'face'); f++) {
      const at = `${file} face ${f}`, info0 = g0.faceInfo(f);
      // (A p-curve parameterized otherwise than its curve can't be compared at the same parameters.)
      if (info0.status !== 'ok' || info0.ownRanges || !info0.loops) continue;
      const info = g.faceInfo(f);
      assert.equal(info.status, 'ok', at);
      faces++;
      const uses = new Map<number, number>(), { coedge, travel } = g0.facePieces(f);
      for (const c of coedge) uses.set(d.coedge.edge[c]!, (uses.get(d.coedge.edge[c]!) ?? 0) + 1);
      assert.equal(info.projected, new Set(coedge).size, at);
      // Each use's p-curve: on the model's within the tolerance in 3D, a whole number of periods from it in (u, v);
      // a seam's on the same copy (the side its use takes).
      const uv: number[] = [];
      for (let k = 0; k < coedge.length; k++) {
        const c = coedge[k]!, ts = [0.1, 0.3, 0.5, 0.7, 0.9].map((x) => travel[2 * k]! + x * (travel[2 * k + 1]!
          - travel[2 * k]!));
        const a = g0.evalCoedge(c, ts, 0), b = g.evalCoedge(c, ts, 0);
        assert.equal(b.status, 'ok', at);
        const pa: number[] = [], pb: number[] = [];
        for (let i = 0; i < ts.length; i++) {
          assert.equal(b.statuses[i], 0, at);
          pa.push(a.values[3 * i]!, a.values[3 * i + 1]!), pb.push(b.values[3 * i]!, b.values[3 * i + 1]!);
        }
        const sa = g0.evalSurface(d.face.surface[f]!, pa, 0).values;
        const sb = g0.evalSurface(d.face.surface[f]!, pb, 0).values;
        const seam = uses.get(d.coedge.edge[c]!)! > 1;
        for (let i = 0; i < ts.length; i++) {
          assert.ok(norm(sa, [sb[3 * i]!, sb[3 * i + 1]!, sb[3 * i + 2]!], 3 * i) <= 10 * info.tolerance,
            `${at} coedge ${c} at ${ts[i]}`);
          for (const [x, period] of [[0, info.uPeriod], [1, info.vPeriod]] as const) {
            const du = pb[2 * i + x]! - pa[2 * i + x]!, n = period > 0 ? Math.round(du / period) : 0;
            assert.ok(Math.abs(du - n * period) <= 1e-6 * Math.max(1, Math.abs(pa[2 * i + x]!)),
              `${at} coedge ${c} at ${ts[i]}: ${'uv'[x]} ${pb[2 * i + x]} against ${pa[2 * i + x]}`);
            if (seam) assert.ok(n === 0, `${at} seam coedge ${c}: ${'uv'[x]} ${n} periods off`);
          }
        }
        if (seam) seams++;
        compared++;
        uv.push(...pa);
      }
      // Points on a grid over the loops' (u, v) box: classified as the model's p-curves classify them (a coarser
      // grid on the variants: classifying on a periodic face takes milliseconds a point).
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (let i = 0; i < uv.length; i += 2) {
        u0 = Math.min(u0, uv[i]!), u1 = Math.max(u1, uv[i]!);
        v0 = Math.min(v0, uv[i + 1]!), v1 = Math.max(v1, uv[i + 1]!);
      }
      const grid: number[] = [], n = file.endsWith('-s1.cbr') ? 6 : 3;
      for (let i = 0; i < n; i++)
        for (let j = 0; j < n; j++) grid.push(u0 + (u1 - u0) * (i + 0.5) / n, v0 + (v1 - v0) * (j + 0.5) / n);
      const r0 = g0.classifyOnFace(f, grid), r = g.classifyOnFace(f, grid);
      assert.equal(r.status, 'ok', at);
      assert.deepEqual([...r.sides], [...r0.sides], at);
      points += grid.length / 2;
      const loops = d.face.loopCount[f]!;
      assert.deepEqual([...g.nestFace(f, loops).parents], [...g0.nestFace(f, loops).parents], at);
      // Each use's travel from its first piece's start to its last's end (a projection's pieces may be cut where the
      // model's aren't); and each loop's self-intersections (a seam's two uses on one copy would overlap).
      const ends = (p: { coedge: Int32Array; travel: Float64Array }) => {
        const m = new Map<number, [number, number]>();
        p.coedge.forEach((c, k) => m.set(c, [m.get(c)?.[0] ?? p.travel[2 * k]!, p.travel[2 * k + 1]!]));
        return m;
      };
      const e0 = ends({ coedge, travel }), e = ends(g.facePieces(f));
      for (const [c, [a, b]] of e0) {
        const [x, y] = e.get(c)!;
        assert.ok(Math.abs(x - a) <= 1e-9 * (1 + Math.abs(a)) && Math.abs(y - b) <= 1e-9 * (1 + Math.abs(b)),
          `${at} coedge ${c}: travel ${x} to ${y} against ${a} to ${b}`);
      }
      for (let k = 0; k < loops; k++) {
        if (d.loop.kind[d.face.firstLoop[f]! + k] !== LOOP_KIND.edge) continue;
        const a = g0.selfIntersectFace(f, k), b = g.selfIntersectFace(f, k);
        assert.deepEqual([b.status, b.crossings, b.touches, b.overlaps], [a.status, a.crossings, a.touches, a.overlaps],
          `${at} loop ${k}`);
      }
    }
  }
  assert.deepEqual([faces, compared, seams], [140, 350, 56]);
  assert.equal(points, 1800);
});

test('projection: project and projectCoedge through the API (samples, ends, a seam\'s twin, failures, the opt-out)',
  { skip }, async () => {
  const module = await init();
  const b = new BrepBuilder();
  const axes = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const cylinder = b.addSurface({ kind: 'cylinder', position: axes, radius: 1 });
  const circle = b.addCurve({ kind: 'circle', position: { ...axes, origin: [0, 0, 0.5] }, radius: 1 });
  const seam = b.addCurve({ kind: 'line', point: [1, 0, 0], direction: [0, 0, 1], magnitude: 1 });
  const wide = b.addCurve({ kind: 'circle', position: axes, radius: 1.5 });
  // A clockwise circle on a plane at (1, 2, 0) whose x is y: kind 0, the plane's map. A plane section of the cylinder,
  // tilted 0.5 rad: an ellipse, traced.
  const moved = b.addSurface({ kind: 'plane', position: { origin: [1, 2, 0], axis: [0, 0, 1], xDir: [0, 1, 0] } });
  const clockwise = b.addCurve({ kind: 'circle', position: { ...axes, axis: [0, 0, -1] }, radius: 1 });
  const tilt = 0.5, ellipse = b.addCurve({ kind: 'ellipse', position: { origin: [0, 0, 0],
    axis: [0, -Math.sin(tilt), Math.cos(tilt)], xDir: [0, Math.cos(tilt), Math.sin(tilt)] },
  semiAxis1: 1 / Math.cos(tilt), semiAxis2: 1 });
  // Unit disks on z = 0 bounded by a closed circle without a p-curve: one on the plane, one 0.001 above it.
  const plane = b.addSurface({ kind: 'plane', position: axes });
  for (const z of [0, 1e-3]) {
    const v = b.addVertex({ point: [1, 0, z] });
    const c = b.addCurve({ kind: 'circle', position: { ...axes, origin: [0, 0, z] }, radius: 1 });
    const e = b.addEdge({ curve: c, start: v, end: v, sameSense: true });
    const f = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: 'forward' }] }] });
    b.addItem({ kind: 'face', ref: f });
  }
  using g = new Geometry(module, new Uint8Array(b.finish().buffer));
  const close = (a: ArrayLike<number>, want: number[], at: string) =>
    want.forEach((w, i) => assert.ok(Math.abs(a[i]! - w) <= 1e-12 * (1 + Math.abs(w)), `${at} [${i}]: ${a[i]}`));

  // A coaxial circle: an iso-line u = t, v = 0.5, from the start given (two turns on).
  const p = g.project(circle, cylinder, 0, 2 * Math.PI, 1e-7, { samples: [0, 1, Math.PI, 7] });
  assert.ok('pieces' in p);
  assert.deepEqual([p.status, p.method, p.certainty, p.seamU, p.seamV], ['ok', 'isoLine', 'unique', false, false]);
  assert.ok(p.error <= 1e-7 && p.offSurface <= 1e-12);
  close(p.uv, [0, 0.5, 1, 0.5, Math.PI, 0.5], 'circle');
  assert.ok(Number.isNaN(p.uv[6]!) && Number.isNaN(p.uv[7]!));  // 7 is past the range
  assert.equal(p.pieces.length, 1);
  assert.equal(p.pieces[0]!.kind, 1);  // a line (CURVE_KIND)
  const q = g.project(circle, cylinder, 0, 2 * Math.PI, 1e-7, { start: [4 * Math.PI, 0.5], samples: [1] });
  assert.ok('pieces' in q);
  close(q.uv, [4 * Math.PI + 1, 0.5], 'circle from two turns on');

  // The seam's generatrix: u = 0 and its twin u = 2 pi.
  const s = g.project(seam, cylinder, -1, 2, 1e-7, { samples: [0.5] });
  assert.ok('pieces' in s);
  assert.deepEqual([s.status, s.seamU, s.seamV, s.seamTwin.length], ['ok', true, false, 1]);
  close(s.uv, [0, 0.5], 'seam'), close(s.twinUv, [2 * Math.PI, 0.5], 'seam twin');

  // Off the surface: invalidModel, the feet's p-curve still given, offSurface the distance.
  const w = g.project(wide, cylinder, 0, 1, 1e-7);
  assert.ok('pieces' in w);
  assert.equal(w.status, 'invalidModel');
  assert.ok(Math.abs(w.offSurface - 0.5) <= 1e-9, `${w.offSurface}`);
  assert.deepEqual(g.project(circle, 99, 0, 1, 1e-7), { status: 'invalidModel' });
  const k = g.project(clockwise, moved, 0, 1, 1e-7, { samples: [1] });
  assert.ok('pieces' in k && k.method === 'planeAffine' && k.pieces[0]!.kind === 0);
  close(k.pieces[0]!.affine, [0, 1, 0, -1, 0, 0, 1, 2, 0], 'affine');
  close(k.uv, [-Math.sin(1) - 2, 1 - Math.cos(1)], 'clockwise');
  // Fitted at a loose tolerance: the error the fit's, offSurface the curve's (on the cylinder).
  const t = g.project(ellipse, cylinder, 0, 2 * Math.PI, 1e-3);
  assert.ok('pieces' in t && t.status === 'ok' && t.method === 'traced');
  assert.ok(t.offSurface <= 1e-12 && t.error > 1e-9 && t.error <= 1e-3, `${t.offSurface} ${t.error}`);

  // The disks' coedges: the one on the plane projected (a planeAffine circle), classified; the other off the plane.
  const c0 = g.projectCoedge(0, NaN, [0, Math.PI / 2]);
  assert.ok('pieces' in c0);
  assert.deepEqual([c0.status, c0.method, c0.range[0], c0.range[1]], ['ok', 'planeAffine', 0, 2 * Math.PI]);
  close(c0.uv, [1, 0, 0, 1], 'disk');
  const info = g.faceInfo(0);
  assert.deepEqual([info.status, info.projected], ['ok', 1]);
  const r = g.classifyOnFace(0, [0, 0, 2, 0, 0.6, 0.6]);
  assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'in']);
  const e = g.evalCoedge(0, [Math.PI, 7], 1);
  assert.equal(e.status, 'ok');
  close(e.values, [-1, 0, 0, 0, -1, 0], 'disk at pi');
  assert.deepEqual([...e.statuses], [0, STATUS.indexOf('outOfDomain')]);
  assert.equal(g.faceInfo(1).status, 'pcurveProjectionFailed');
  const c1 = g.projectCoedge(1);
  assert.ok('pieces' in c1 && c1.status === 'invalidModel' && Math.abs(c1.offSurface - 1e-3) <= 1e-12);
  // At a tolerance the gap is within, it's made.
  const c2 = g.projectCoedge(1, 2e-3);
  assert.ok('pieces' in c2 && c2.status === 'ok');
  g.setProjectMissingPcurves(false);
  assert.equal(g.faceInfo(0).status, 'noPcurve');
  assert.equal(g.evalCoedge(0, [0]).status, 'noPcurve');
  g.setProjectMissingPcurves(true);
  assert.equal(g.faceInfo(0).status, 'ok');
});

test('projection: a use against its curve through a sphere\'s pole (pieces in the use\'s order)', { skip },
  async () => {
  // The upper hemisphere's y > 0 half: the equator from (1, 0, 0) to (-1, 0, 0), then back over the pole along a
  // meridian whose curve runs the other way (the use reversed), projected in two pieces and a pole jump.
  const b = new BrepBuilder();
  const at = (axis: number[]) => ({ origin: [0, 0, 0], axis, xDir: [1, 0, 0] });
  const sphere = b.addSurface({ kind: 'sphere', position: at([0, 0, 1]), radius: 1 });
  const [A, B] = [[1, 0, 0], [-1, 0, 0]].map((p) => b.addVertex({ point: p }));
  const e0 = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: at([0, 0, 1]), radius: 1 }), start: A, end: B,
    sameSense: true });
  const e1 = b.addEdge({ curve: b.addCurve({ kind: 'circle', position: at([0, -1, 0]), radius: 1 }), start: A, end: B,
    sameSense: true });
  const coedges = [{ edge: e0, orientation: 'forward' as const }, { edge: e1, orientation: 'reversed' as const }];
  b.addItem({ kind: 'face', ref: b.addFace({ surface: sphere, sameSense: true, loops: [{ kind: 'edge',
    bound: 'outer', sense: true, coedges }] }) });
  using g = new Geometry(await init(), new Uint8Array(b.finish().buffer));
  assert.deepEqual(g.faceInfo(0).projected, 2);
  const h = Math.PI / 2, p = g.facePieces(0);
  assert.deepEqual([...p.coedge], [0, 1, 1]);
  assert.deepEqual([...p.travel], [0, Math.PI, Math.PI, h, h, 0]);
  const r = g.classifyOnFace(0, [h, 0.5, 3 * h, 0.5, h, -0.5, 0.1, 1.5]);
  assert.deepEqual([...r.sides].map((x) => ['in', 'out', 'on'][x]), ['in', 'out', 'out', 'in']);
  const self = g.selfIntersectFace(0, 0);
  assert.deepEqual([self.status, self.crossings, self.touches, self.overlaps], ['ok', 0, 0, 0]);
});
