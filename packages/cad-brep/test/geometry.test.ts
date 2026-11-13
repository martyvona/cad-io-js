import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, type BrepData, type Curve, rowCount, type Surface } from '../src/index.ts';
import { curveEvaluator, fullKnots, nearestParam, normalAt, surfaceEvaluator, type Vec } from '../src/geometry.ts';
import { cone, everyKind, seamCylinder } from './models.ts';

const dist = (a: Vec, b: Vec) => Math.hypot(...a.map((x, i) => x - b[i]!));
const near = (a: Vec, b: Vec, tol = 1e-12, what = '') =>
  assert.ok(dist(a, b) <= tol * Math.max(1, Math.hypot(...b)), `${what}: ${a} vs ${b}`);
let seed = 7;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);

/** One curve or surface in a buffer of its own (bases first). */
function one(curves: Curve[], surfaces: Surface[] = []): BrepData {
  const b = new BrepBuilder();
  for (const c of curves) b.addCurve(c);
  for (const s of surfaces) b.addSurface(s);
  return b.finish();
}
/** Parameters to test at: inside the range, or [-2, 2] where it's unbounded; off the knots and corners (which are at
 * simple fractions of the range in these fixtures). */
const params = (r: [number, number], n = 7) => {
  const a = Number.isFinite(r[0]) ? r[0] : -2, b = Number.isFinite(r[1]) ? r[1] : 2;
  return Array.from({ length: n }, (_, k) => a + (b - a) * (k + 0.3711) / n);
};

test('derivatives agree with finite differences, for every kind evaluated', () => {
  let curves = 0, surfaces = 0;
  for (const make of [everyKind, seamCylinder, cone]) {
    const d = make().finish();
    for (let i = 0; i < rowCount(d, 'curve'); i++) {
      const c = curveEvaluator(d, i);
      if (!c) continue;
      curves++;
      for (const t of params(c.range)) {
        const h = 1e-6 * Math.max(1, Math.abs(t));
        const fd = c.point(t + h).map((x, k) => (x - c.point(t - h)[k]!) / (2 * h));
        near(c.d1(t), fd, 1e-5, `curve ${i} at ${t}`);
      }
    }
    for (let i = 0; i < rowCount(d, 'surface'); i++) {
      const s = surfaceEvaluator(d, i);
      if (!s) continue;
      surfaces++;
      for (const u of params(s.u, 4)) for (const v of params(s.v, 4)) {
        const h = 1e-6;
        const [su, sv] = s.d1(u, v);
        near(su, s.point(u + h, v).map((x, k) => (x - s.point(u - h, v)[k]!) / (2 * h)), 1e-5, `surface ${i} u`);
        near(sv, s.point(u, v + h).map((x, k) => (x - s.point(u, v - h)[k]!) / (2 * h)), 1e-5, `surface ${i} v`);
      }
    }
  }
  // everyKind's 22 curves and 12 of its 14 surfaces (the two swept with a directrix aren't evaluated), and the rest.
  assert.ok(curves >= 22 && surfaces >= 12, `${curves} curves, ${surfaces} surfaces`);
});

const P3 = { origin: [1, 2, 3], axis: [0, 0, 1], xDir: [1, 0, 0] };

test('conics and elementary surfaces at known points', () => {
  const d = one([
    { kind: 'line', point: [1, 1, 1], direction: [0, 0.6, 0.8], magnitude: 5 },
    { kind: 'circle', position: P3, radius: 2 },
    { kind: 'ellipse', position: P3, semiAxis1: 3, semiAxis2: 1 },
    { kind: 'hyperbola', position: P3, semiAxis: 2, semiImagAxis: 1 },
    { kind: 'parabola', position: P3, focalDist: 0.5 },
    { kind: 'circle', position: { origin: [1, 1], xDir: [0, 1] }, radius: 2 },
  ], [
    { kind: 'cylinder', position: P3, radius: 2 },
    { kind: 'cone', position: P3, radius: 1, semiAngle: Math.PI / 4 },
    { kind: 'sphere', position: P3, radius: 2 },
    { kind: 'torus', position: P3, majorRadius: 5, minorRadius: 1 },
    { kind: 'plane', position: { origin: [0, 0, 0], axis: [1, 0, 0], xDir: [0, 1, 0] } },
  ]);
  const c = (i: number) => curveEvaluator(d, i)!, s = (i: number) => surfaceEvaluator(d, i)!;
  near(c(0).point(2), [1, 1 + 6, 1 + 8]);
  near(c(1).point(Math.PI / 2), [1, 4, 3]);
  near(c(2).point(Math.PI), [-2, 2, 3]);
  near(c(2).point(Math.PI / 2), [1, 3, 3]);
  near(c(3).point(0), [3, 2, 3]);
  near(c(3).point(1), [1 + 2 * Math.cosh(1), 2 + Math.sinh(1), 3]);
  near(c(4).point(1), [1.5, 3, 3]);
  // 2D: y is x turned +90 degrees, so x (0, 1) has y (-1, 0).
  near(c(5).point(Math.PI / 2), [-1, 1]);
  near(s(0).point(Math.PI / 2, 4), [1, 4, 7]);
  near(s(1).point(0, 1), [1 + 2, 2, 4]);
  near(s(2).point(0, Math.PI / 2), [1, 2, 5]);
  near(s(3).point(0, Math.PI), [1 + 4, 2, 3]);
  near(s(3).point(Math.PI / 2, Math.PI / 2), [1, 2 + 5, 4]);
  // A plane's (u, v) along its x and y; its normal its axis; a sphere's at a point, outward.
  near(s(4).point(2, 3), [0, 2, 3]);
  near(normalAt(s(4), 0, 0)!, [1, 0, 0]);
  near(normalAt(s(2), 0, 0)!, [1, 0, 0]);
  assert.deepEqual(c(1).range, [0, 2 * Math.PI]);
  assert.equal(c(1).period, 2 * Math.PI);
});

test('closed-form inverses give back the parameters', () => {
  const d = one([
    { kind: 'line', point: [1, 1, 1], direction: [0, 0.6, 0.8], magnitude: 5 },
    { kind: 'circle', position: P3, radius: 2 },
    { kind: 'ellipse', position: P3, semiAxis1: 3, semiAxis2: 1 },
    { kind: 'hyperbola', position: P3, semiAxis: 2, semiImagAxis: 1 },
    { kind: 'parabola', position: P3, focalDist: 0.5 },
  ], [
    { kind: 'plane', position: P3 },
    { kind: 'cylinder', position: P3, radius: 2 },
    { kind: 'cone', position: P3, radius: 1, semiAngle: 0.3 },
    { kind: 'sphere', position: P3, radius: 2 },
    { kind: 'torus', position: P3, majorRadius: 5, minorRadius: 1 },
    { kind: 'rectangularTrimmed', basis: 1, u1: 0, u2: 1, v1: 0, v2: 1, uSense: true, vSense: true },
  ]);
  for (let i = 0; i < 5; i++) {
    const c = curveEvaluator(d, i)!;
    for (let k = 0; k < 20; k++) {
      const t = i >= 1 && i <= 2 ? rand() * 2 * Math.PI : rand() * 4 - 2;
      assert.ok(Math.abs(c.param(c.point(t))! - t) < 1e-9, `curve ${i} at ${t}`);
    }
  }
  for (let i = 0; i < 6; i++) {
    const s = surfaceEvaluator(d, i)!;
    for (let k = 0; k < 20; k++) {
      const u = rand() * 2 * Math.PI, v = i === 3 ? rand() * 3 - 1.5 : i >= 4 && i < 5 ? rand() * 2 * Math.PI
        : rand() * 4 - 2;
      const [pu, pv] = s.params!(s.point(u, v))!;
      near([pu, pv], [i === 0 ? u : u, v], 1e-9, `surface ${i} at ${u}, ${v}`);
    }
  }
  // On the axis there's no u.
  assert.equal(surfaceEvaluator(d, 3)!.params!([1, 2, 5]), undefined);
});

/** The Bernstein form of a Bezier curve, independent of de Boor's algorithm. */
function bernstein(poles: Vec[], t: number): Vec {
  const n = poles.length - 1;
  const choose = (k: number) => { let c = 1; for (let i = 0; i < k; i++) c = c * (n - i) / (i + 1); return c; };
  return poles.reduce((acc, p, k) => acc.map((x, i) => x + choose(k) * t ** k * (1 - t) ** (n - k) * p[i]!),
    new Array<number>(poles[0]!.length).fill(0));
}

/** Boehm's knot insertion on a full knot vector: the same curve with one more knot and pole. */
function insert(U: number[], P: Vec[], p: number, t: number): [number[], Vec[]] {
  let k = p;
  while (U[k + 1]! <= t) k++;
  const Q: Vec[] = [];
  for (let i = 0; i <= P.length; i++) {
    if (i <= k - p) Q.push(P[i]!);
    else if (i > k) Q.push(P[i - 1]!);
    else {
      const a = (t - U[i]!) / (U[i + p]! - U[i]!);
      Q.push(P[i]!.map((x, j) => a * x + (1 - a) * P[i - 1]![j]!));
    }
  }
  return [[...U.slice(0, k + 1), t, ...U.slice(k + 1)], Q];
}

test('B-splines: Bernstein, knot insertion, a rational circle, a rational surface', () => {
  const poles = [[0, 0, 0], [1, 2, 0], [3, 2, 1], [4, 0, 2]];
  const bez = one([{ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4], poles, closed: false,
    selfIntersect: false, form: 'unspecified' }]);
  const be = curveEvaluator(bez, 0)!;
  for (const t of [0, 0.1, 0.37, 0.5, 0.9, 1]) near(be.point(t), bernstein(poles, t));
  assert.deepEqual(be.range, [0, 1]);

  // A degree-2 curve with an interior knot, and the same with another knot inserted: equal everywhere.
  const P = [[0, 0, 0], [1, 3, 0], [2, -1, 1], [4, 2, 0], [5, 0, 3]];
  const knots = [0, 0.4, 1], mults = [3, 2, 3];
  const [U2, P2] = insert(fullKnots(knots, mults), P, 2, 0.7);
  const fold = (U: number[]) => {
    const k: number[] = [], m: number[] = [];
    for (const x of U) { if (k.at(-1) === x) m[m.length - 1]!++; else { k.push(x); m.push(1); } }
    return { knots: k, multiplicities: m };
  };
  const two = one([
    { kind: 'bspline', degree: 2, knots, multiplicities: mults, poles: P, closed: false, selfIntersect: false,
      form: 'unspecified' },
    { kind: 'bspline', degree: 2, ...fold(U2), poles: P2, closed: false, selfIntersect: false, form: 'unspecified' },
  ]);
  const [a, b] = [curveEvaluator(two, 0)!, curveEvaluator(two, 1)!];
  for (let k = 0; k <= 50; k++) {
    near(a.point(k / 50), b.point(k / 50), 1e-12, `at ${k / 50}`);
    near(a.d1(k / 50), b.d1(k / 50), 1e-9, `d1 at ${k / 50}`);
  }

  // A quarter circle as a rational quadratic: every point at radius 1, tangent perpendicular to the radius.
  const w = Math.SQRT1_2;
  const circ = one([{ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
    poles: [[1, 0], [1, 1], [0, 1]], weights: [1, w, 1], closed: false, selfIntersect: false, form: 'circular_arc' }]);
  const q = curveEvaluator(circ, 0)!;
  for (let k = 0; k <= 20; k++) {
    const p = q.point(k / 20);
    assert.ok(Math.abs(Math.hypot(...p) - 1) < 1e-15, `radius at ${k / 20}`);
    assert.ok(Math.abs(p[0]! * q.d1(k / 20)[0]! + p[1]! * q.d1(k / 20)[1]!) < 1e-14);
  }
  // Nearest-point search finds a sample's parameter.
  for (const t of [0.13, 0.5, 0.81]) assert.ok(Math.abs(nearestParam(q, q.point(t), q.range) - t) < 1e-10);

  // A rational patch: the quarter circle swept along z, every point at radius 2 from the z axis.
  const ring = [[2, 0], [2, 2], [0, 2]];
  const patch = one([], [{ kind: 'bspline', uDegree: 2, vDegree: 1, uKnots: [0, 1], vKnots: [0, 3],
    uMultiplicities: [3, 3], vMultiplicities: [2, 2], poles: ring.map((p) => [[...p, 0], [...p, 3]]),
    weights: [[1, 1], [w, w], [1, 1]], uClosed: false, vClosed: false, selfIntersect: false,
    form: 'cylindrical_surf' }]);
  const ps = surfaceEvaluator(patch, 0)!;
  assert.deepEqual([ps.u, ps.v], [[0, 1], [0, 3]]);
  for (let k = 0; k <= 10; k++) {
    const p = ps.point(k / 10, 0.3 * k);
    assert.ok(Math.abs(Math.hypot(p[0]!, p[1]!) - 2) < 1e-14 && Math.abs(p[2]! - 0.3 * k) < 1e-14);
  }
});

test('polylines, composites, trims, offsets, sweeps', () => {
  const P = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const d = one([
    { kind: 'polyline', points: [[0, 0, 0], [1, 0, 0], [1, 2, 0]] },
    { kind: 'circle', position: P, radius: 1 },
    { kind: 'trimmed', basis: 1, trim1: { parameter: Math.PI / 2 }, trim2: { parameter: 0 }, sense: true,
      preference: 'parameter' },
    { kind: 'trimmed', basis: 1, trim1: { point: [0, 1, 0] }, trim2: { point: [1, 0, 0] }, sense: false,
      preference: 'cartesian' },
    { kind: 'composite', segments: [{ curve: 0, sameSense: true, transition: 'continuous' },
      { curve: 2, sameSense: false, transition: 'continuous' }], selfIntersect: false },
    { kind: 'offset', basis: 1, distance: 0.5, selfIntersect: false, refDirection: [0, 0, 1] },
    { kind: 'line', point: [3, 0, 0], direction: [0, 0, 1], magnitude: 1 },
  ], [
    { kind: 'extrusion', curve: 1, direction: [0, 0, 1], magnitude: 2 },
    { kind: 'revolution', curve: 6, axisOrigin: [0, 0, 0], axisDirection: [0, 0, 1] },
    { kind: 'cylinder', position: P, radius: 1 },
    { kind: 'offset', basis: 2, distance: 0.25, selfIntersect: false },
  ]);
  const c = (i: number) => curveEvaluator(d, i)!, s = (i: number) => surfaceEvaluator(d, i)!;
  near(c(0).point(1.5), [1, 1, 0]);
  assert.deepEqual(c(0).range, [0, 2]);
  // A trim with sense from pi/2 to 0 on a circle runs the long way round: pi/2 to 2 pi.
  assert.deepEqual(c(2).range, [Math.PI / 2, 2 * Math.PI]);
  // By points against the sense: from pi/2 down to 0.
  assert.deepEqual(c(3).range, [0, Math.PI / 2]);
  // The composite's second segment reversed: at t = 1 it starts where the trim ends (the circle at 2 pi).
  near(c(4).point(1), [1, 0, 0]);
  near(c(4).point(2), [0, 1, 0]);
  // The polyline's own range is [0, 2]: t = 0.25 is its parameter 0.5.
  near(c(4).point(0.25), [0.5, 0, 0]);
  assert.deepEqual(c(4).range, [0, 2]);
  // OCCT's offset: tangent x reference, on a counter-clockwise circle about z, points outward.
  near(c(5).point(0), [1.5, 0, 0]);
  near(s(0).point(Math.PI / 2, 1), [0, 1, 2]);
  near(s(1).point(Math.PI / 2, 4), [0, 3, 4]);
  // An offset surface along S_u x S_v (outward on a cylinder about z).
  near(s(3).point(0, 0), [1.25, 0, 0]);
});

test('nearest parameters on a B-spline surface, and none on an unbounded one', async () => {
  const { nearestParams } = await import('../src/geometry.ts');
  const d = one([], [{ kind: 'bspline', uDegree: 2, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [3, 3], vMultiplicities: [3, 3],
    poles: [[[0, 0, 0], [0, 1, 1], [0, 2, 0]], [[1, 0, 1], [1, 1, 3], [1, 2, 1]], [[2, 0, 0], [2, 1, 1], [2, 2, 0]]],
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' },
  { kind: 'cylinder', position: P3, radius: 1 }]);
  const s = surfaceEvaluator(d, 0)!;
  for (const [u, v] of [[0.2, 0.7], [0.5, 0.5], [0.93, 0.11], [0, 1]]) {
    const [pu, pv] = nearestParams(s, s.point(u!, v!))!;
    near([pu, pv], [u!, v!], 1e-9, `${u}, ${v}`);
  }
  assert.equal(nearestParams(surfaceEvaluator(d, 1)!, [1, 2, 3]), undefined);
});

/** A wavy bicubic B-spline surface of `n` x `m` knot spans (uniform knots, clamped), rational with `weights`. */
function wavy(n: number, m: number, weights?: (i: number, j: number) => number): Surface {
  const poles = Array.from({ length: n + 3 }, (_, i) => Array.from({ length: m + 3 },
    (_, j): Vec => [i, j, Math.sin(i * 1.3) * Math.cos(j * 0.7) + 0.3 * Math.sin(i * j)]));
  return { kind: 'bspline', uDegree: 3, vDegree: 3, uKnots: Array.from({ length: n + 1 }, (_, k) => k),
    vKnots: Array.from({ length: m + 1 }, (_, k) => k / 2), uMultiplicities: [4, ...new Array(n - 1).fill(1), 4],
    vMultiplicities: [4, ...new Array(m - 1).fill(1), 4], poles,
    ...(weights ? { weights: poles.map((r, i) => r.map((_, j) => weights(i, j))) } : {}),
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' };
}

/** The distance the grid over the whole ranges finds (an evaluator without patches): what patches must match. */
async function gridNearest(s: import('../src/geometry.ts').SurfaceEvaluator, p: Vec): Promise<number> {
  const { nearestParams } = await import('../src/geometry.ts');
  const [u, v] = nearestParams({ ...s, patches: undefined }, p)!;
  return dist(s.point(u, v), p);
}

test('nearest parameters by patches: as near as the grid over the whole ranges, tree or not; pruned, samples kept',
  async () => {
  const { nearestParams } = await import('../src/geometry.ts');
  const d = one([], [wavy(12, 10)]);
  const s = surfaceEvaluator(d, 0)!;
  assert.equal(s.patches!().length, 120);
  // Points on the surface: found again (its own point), linear search and tree alike.
  for (let k = 0; k < 20; k++) {
    const [u, v] = [rand() * 12, rand() * 5];
    const p = s.point(u, v);
    for (const treeMin of [Infinity, 0]) {
      const [pu, pv] = nearestParams(surfaceEvaluator(d, 0)!, p, 24, treeMin)!;
      near(s.point(pu, pv), p, 1e-9, `${u}, ${v} (tree past ${treeMin})`);
    }
  }
  // Points off it: as near as the grid over the whole ranges finds, or nearer, tree or not. (Not as near as a dense
  // search everywhere: off the surface, Gauss-Newton can stop at its first sample, as the grid's does:
  // shape-interrogation.md.)
  for (let k = 0; k < 12; k++) {
    const p = [rand() * 14 - 1, rand() * 12 - 1, rand() * 4 - 2];
    const grid = await gridNearest(s, p);
    for (const treeMin of [Infinity, 0]) {
      const [pu, pv] = nearestParams(surfaceEvaluator(d, 0)!, p, 24, treeMin)!;
      assert.ok(dist(s.point(pu, pv), p) <= grid + 1e-9, `${p}: ${dist(s.point(pu, pv), p)} vs ${grid}`);
    }
  }
  // Pruned: a point on the surface costs a few patches' samples, not the 120 patches' (81 each); kept: again, fewer.
  for (const treeMin of [Infinity, 0]) {
    const e = surfaceEvaluator(d, 0)!;
    let calls = 0;
    const counted = { ...e, point: (u: number, v: number) => { calls++; return e.point(u, v); } };
    const p = e.point(6.3, 2.1);
    nearestParams(counted, p, 24, treeMin);
    const first = calls;
    assert.ok(first < 15 * 81, `${first} evaluations (tree past ${treeMin})`);
    calls = 0;
    nearestParams(counted, p, 24, treeMin);
    assert.ok(calls < first / 2, `again: ${calls} against ${first}`);
    // At least one patch sampled in full (8 a span each way).
    assert.ok(first >= 81, `${first} evaluations`);
    // A point far beyond the surface's end in u: boxes at their distances, all but the near end's pruned.
    calls = 0;
    nearestParams({ ...surfaceEvaluator(d, 0)!, point: (u: number, v: number) => { calls++; return e.point(u, v); } },
      [30, 2.5, 0], 24, treeMin);
    assert.ok(calls < 30 * 81, `far beyond: ${calls} evaluations (tree past ${treeMin})`);
  }
  // A doubled interior knot: no empty span among the patches.
  const doubled = { ...wavy(4, 3), uKnots: [0, 1, 2, 3], uMultiplicities: [4, 2, 1, 4] } as Surface;
  (doubled as { poles: Vec[][] }).poles = (doubled as { poles: Vec[][] }).poles.slice(0, 7);
  const ps = surfaceEvaluator(one([], [doubled]), 0)!.patches!();
  assert.equal(ps.length, 3 * 3);
  assert.ok(ps.every((q) => q.u[1] > q.u[0] && q.v[1] > q.v[0]));
});

test('nearest parameters by patches: rational, trimmed; not for weights below zero nor an offset', async () => {
  const { nearestParams } = await import('../src/geometry.ts');
  const d = one([], [wavy(4, 4, (i, j) => 1 + 0.5 * Math.sin(i + j)),
    wavy(4, 4, (i, j) => (i === 2 && j === 2 ? -1 : 1)),
    { kind: 'offset', basis: 0, distance: 0.5, selfIntersect: false },
    { kind: 'rectangularTrimmed', basis: 0, u1: 1.5, u2: 3.2, v1: 0.6, v2: 1.4, uSense: true, vSense: true }]);
  const ev = (i: number) => surfaceEvaluator(d, i)!;
  const rational = ev(0), negative = ev(1), offset = ev(2), trimmed = ev(3);
  // Every rational patch inside its box (sampled densely).
  for (const q of rational.patches!()) {
    for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
      const x = rational.point(q.u[0] + (q.u[1] - q.u[0]) * i / 6, q.v[0] + (q.v[1] - q.v[0]) * j / 6);
      assert.ok(x.every((c, k) => c >= q.lo[k]! - 1e-12 && c <= q.hi[k]! + 1e-12), `${x} outside its box`);
    }
  }
  const p = rational.point(2.3, 1.1);
  near(rational.point(...nearestParams(rational, p)!), p, 1e-9, 'rational');
  assert.equal(negative.patches, undefined);
  assert.equal(offset.patches, undefined);
  // Trimmed: within its ranges, a point outside them gives a boundary foot.
  const t = nearestParams(trimmed, rational.point(2, 1))!;
  near(trimmed.point(...t), rational.point(2, 1), 1e-9, 'trimmed, inside');
  const out = nearestParams(trimmed, rational.point(0.5, 0.2))!;
  assert.ok(out[0] >= 1.5 && out[0] <= 3.2 && out[1] >= 0.6 && out[1] <= 1.4, `${out} outside the trim`);
});

test('edge parameters: stored ranges, periods by sense, whole turns, closed B-splines', async () => {
  const { edgeParams } = await import('../src/geometry.ts');
  const b = new BrepBuilder();
  const P = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const circle = b.addCurve({ kind: 'circle', position: P, radius: 1 });
  const at = (a: number) => b.addVertex({ point: [Math.cos(a), Math.sin(a), 0] });
  const v3 = at(3), v1 = at(1);
  const ring = [[1, 0, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, 0], [1, -1, 0], [1, 0, 0]];
  const closedSpline = b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1, 2, 3, 4], multiplicities: [3, 1, 1, 1, 3],
    poles: ring, closed: true, selfIntersect: false, form: 'unspecified' });
  const vs = b.addVertex({ point: [1, 0, 0] });
  const e = [
    b.addEdge({ curve: circle, start: v3, end: v1, sameSense: true }),
    b.addEdge({ curve: circle, start: v1, end: v3, sameSense: false }),
    b.addEdge({ curve: circle, start: v1, end: v1, sameSense: true }),
    b.addEdge({ curve: circle, start: v1, end: v1, sameSense: false }),
    b.addEdge({ curve: circle, start: v1, end: v3, sameSense: true, range: [7, 9] }),
    b.addEdge({ curve: closedSpline, start: vs, end: vs, sameSense: true }),
    b.addEdge({ curve: closedSpline, start: vs, end: vs, sameSense: false }),
  ];
  const d = b.finish();
  const c = curveEvaluator(d, circle)!, s = curveEvaluator(d, closedSpline)!;
  const r = (k: number, ev = c) => edgeParams(d, e[k]!, ev)!.map((x) => Math.round(x * 1e9) / 1e9);
  const two = Math.round(2 * Math.PI * 1e9) / 1e9;
  // From 3 with the sense to 1: past 2 pi, to 1 + 2 pi.
  assert.deepEqual(r(0), [3, Math.round((1 + 2 * Math.PI) * 1e9) / 1e9]);
  // From 1 against the sense to 3: down past 0, to 3 - 2 pi.
  assert.deepEqual(r(1), [1, Math.round((3 - 2 * Math.PI) * 1e9) / 1e9]);
  assert.deepEqual(r(2), [1, Math.round((1 + 2 * Math.PI) * 1e9) / 1e9]);
  assert.deepEqual(r(3), [1, Math.round((1 - 2 * Math.PI) * 1e9) / 1e9]);
  assert.deepEqual(r(4), [7, 9]);
  assert.deepEqual(r(5, s), [0, 4]);
  assert.deepEqual(r(6, s), [4, 0]);
  void two;
});

test('a rectangular trim restricts its basis\'s ranges', () => {
  const d = one([], [{ kind: 'cylinder', position: P3, radius: 1 },
    { kind: 'rectangularTrimmed', basis: 0, u1: 2, u2: 1, v1: -3, v2: 4, uSense: true, vSense: true }]);
  const s = surfaceEvaluator(d, 1)!;
  assert.deepEqual([s.u, s.v], [[1, 2], [-3, 4]]);
});

test('nearest-point search over a curve with many near approaches finds the nearest', () => {
  // A zigzag of 12 crests 10 high, a point just above the 9th: every crest is a local minimum of the distance, the
  // troughs far below, so the nearest is one minimum among many.
  const poles = Array.from({ length: 25 }, (_, k) => [k, k % 2 ? 10 : 0, 0]);
  const d = one([{ kind: 'polyline', points: poles }]);
  const c = curveEvaluator(d, 0)!;
  const t = nearestParam(c, [17, 11, 0], c.range, 50);
  assert.ok(Math.abs(t - 17) < 1e-9, `${t}`);
});

test('a vertex at a closed B-spline\'s junction takes the end the edge\'s sense needs', async () => {
  const { edgeParams } = await import('../src/geometry.ts');
  const b = new BrepBuilder();
  const ring = [[1, 0, 0], [1, 1, 0], [-1, 1, 0], [-1, -1, 0], [1, -1, 0], [1, 0, 0]];
  const c = b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1, 2, 3, 4], multiplicities: [3, 1, 1, 1, 3],
    poles: ring, closed: true, selfIntersect: false, form: 'unspecified' });
  const d0 = b.finish();
  const ev0 = curveEvaluator(d0, 0)!;
  const mid = b.addVertex({ point: ev0.point(2.5) }), junction = b.addVertex({ point: [1, 0, 0] });
  const e = [
    b.addEdge({ curve: c, start: mid, end: junction, sameSense: true }),
    b.addEdge({ curve: c, start: junction, end: mid, sameSense: true }),
    b.addEdge({ curve: c, start: mid, end: junction, sameSense: false }),
    b.addEdge({ curve: c, start: junction, end: mid, sameSense: false }),
  ];
  const d = b.finish(), ev = curveEvaluator(d, c)!;
  const r = (k: number) => edgeParams(d, e[k]!, ev)!.map((x) => Math.round(x * 1e6) / 1e6);
  assert.deepEqual([r(0), r(1), r(2), r(3)], [[2.5, 4], [0, 2.5], [2.5, 0], [4, 2.5]]);
  // The same where the search gives the junction the other end (4, not 0): corrected the same way.
  const other = { ...ev, param: (p: number[]) => Math.hypot(p[0]! - 1, p[1]!, p[2]!) < 1e-12 ? 4 : ev.param(p) };
  const r2 = (k: number) => edgeParams(d, e[k]!, other)!.map((x) => Math.round(x * 1e6) / 1e6);
  assert.deepEqual([r2(0), r2(1), r2(2), r2(3)], [[2.5, 4], [0, 2.5], [2.5, 0], [4, 2.5]]);
});

test('a spindle torus\'s inverse takes the branch its point is on', () => {
  const d = one([], [{ kind: 'torus', position: P3, majorRadius: 1, minorRadius: 3 }]);
  const s = surfaceEvaluator(d, 0)!;
  for (const [u, v] of [[0.3, 2.5], [1, 3], [4, 0.2], [2, 4]]) {
    const p = s.point(u!, v!), [pu, pv] = s.params!(p)!;
    near(s.point(pu, pv), p, 1e-12, `${u}, ${v}`);
  }
});

test('past a cone\'s apex the inverse comes from across the axis', () => {
  const d = one([], [{ kind: 'cone', position: P3, radius: 1, semiAngle: Math.PI / 4 }]);
  const s = surfaceEvaluator(d, 0)!;
  for (const [u, v] of [[0.3, -3], [2, -1.5], [5, 2]]) {
    const p = s.point(u!, v!), [pu, pv] = s.params!(p)!;
    near([pu, pv], [u!, v!], 1e-12, `${u}, ${v}`);
  }
});
