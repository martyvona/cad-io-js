// cad-oracle's free-form method (native/src/free.h) on built faces with areas and vector areas in closed form, for
// what the reference shapes leave out: exact rational B-spline spheres, tori and cylinders bounded by loops (caps
// and zones whose loops wind a pole's row, lunes whose loops run along both pole rows, a sector along one, torus
// patches and bands across both seams, the inner direction swapped where only v is periodic), a planar patch with a
// projected hole and one whose loop runs against it, a patch folding at a row inside a span (the inner rule
// adaptive), and offsets folding off the face but on its strips, so the face is taken in bands (against a tensor
// Gauss-Legendre rule over the face's rectangles by cad-geom's evaluation), one swapped with rows that cross no loop.
// Edges are p-curves only (lines in (u, v)), but the hole's.
// Skipped where the module isn't built (build.sh module).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { type BrepData, BrepBuilder, type Coedge, type Loop } from 'cad-brep';
import { circleAngle, multiplicities, unitCircle, unitHalfCircle } from '../../cad-brep/test/reference/bezier.ts';
import { Geometry, init as initGeom } from '../../cad-geom/src/index.ts';
import { type Estimate, type FaceMeasure, init, Oracle, trusted } from '../src/index.ts';

const pkg = path.join(import.meta.dirname, '..');
const built = fs.existsSync(path.join(pkg, 'dist/cad_oracle.wasm'));
const skip = built ? false : 'cad-oracle\'s module not built (run packages/cad-oracle/build.sh module)';

type V = [number, number, number];
type P2 = [number, number];
const PI = Math.PI, TAU = 2 * PI;

interface Patch {
  uDegree: number; vDegree: number; uKnots: number[]; vKnots: number[]; poles: V[][]; weights?: number[][];
  /** Default: Bezier pieces (degree + 1 at the ends, degree inside). */
  uMults?: number[]; vMults?: number[];
}
function bspline(b: BrepBuilder, p: Patch, uClosed: boolean, vClosed: boolean): number {
  const mult = (degree: number, knots: number[]) => multiplicities({ degree, knots, poles: [], weights: [] });
  return b.addSurface({ kind: 'bspline', uDegree: p.uDegree, vDegree: p.vDegree, uKnots: p.uKnots, vKnots: p.vKnots,
    uMultiplicities: p.uMults ?? mult(p.uDegree, p.uKnots), vMultiplicities: p.vMults ?? mult(p.vDegree, p.vKnots),
    poles: p.poles,
    ...p.weights ? { weights: p.weights } : {}, uClosed, vClosed, selfIntersect: false, form: 'unspecified' });
}

/** The exact rational sphere of radius R: u the circle's parameter (angle circleAngle(u)), v the half circle's. */
function sphere(R: number): Patch {
  const c = unitCircle(), hc = unitHalfCircle();
  return { uDegree: 2, vDegree: 2, uKnots: c.knots, vKnots: hc.knots,
    poles: c.poles.map((p) => hc.poles.map((q) => [R * q[0]! * p[0]!, R * q[0]! * p[1]!, R * q[1]!] as V)),
    weights: c.weights.map((w) => hc.weights.map((x) => w * x)) };
}
/** circleAngle for any t (periodic), unwrapped. */
const angle = (t: number) => circleAngle(t - Math.floor(t)) + TAU * Math.floor(t);
const latitude = (v: number) => circleAngle(v, 2) - PI / 2;
const spherePoint = (R: number, u: number, v: number): V => {
  const a = angle(u), l = latitude(v);
  return [R * Math.cos(l) * Math.cos(a), R * Math.cos(l) * Math.sin(a), R * Math.sin(l)];
};

/** The exact rational torus, major radius R, minor r, both parameters circles. */
function torus(R: number, r: number): Patch {
  const c = unitCircle();
  return { uDegree: 2, vDegree: 2, uKnots: c.knots, vKnots: c.knots,
    poles: c.poles.map((p) => c.poles.map((q) => [(R + r * q[0]!) * p[0]!, (R + r * q[0]!) * p[1]!, r * q[1]!] as V)),
    weights: c.weights.map((w) => c.weights.map((x) => w * x)) };
}
const torusPoint = (R: number, r: number, u: number, v: number): V => {
  const a = angle(u), l = angle(v);
  return [(R + r * Math.cos(l)) * Math.cos(a), (R + r * Math.cos(l)) * Math.sin(a), r * Math.sin(l)];
};

/** The cylinder of radius r, height h about z as a rational B-spline: its circle along v, its height along u. */
function swappedCylinder(r: number, h: number): Patch {
  const c = unitCircle();
  return { uDegree: 1, vDegree: 2, uKnots: [0, 1], vKnots: c.knots,
    poles: [0, h].map((z) => c.poles.map((p) => [r * p[0]!, r * p[1]!, z] as V)),
    weights: [0, 1].map(() => c.weights.slice()) };
}

/** A straight p-curve from a to b in (u, v), t in [0, 1]. */
function pline(b: BrepBuilder, a: P2, c: P2): number {
  const d: P2 = [c[0] - a[0], c[1] - a[1]], L = Math.hypot(d[0], d[1]);
  return b.addCurve({ kind: 'line', point: a, direction: [d[0] / L, d[1] / L], magnitude: L });
}

/**
 * A loop of straight p-curves through the (u, v) corners, closed (the last back to the first; one corner: a closed
 * edge to the same corner a period on, `to`), its vertices at at(u, v).
 */
function loop(b: BrepBuilder, at: (u: number, v: number) => V, corners: P2[], to?: P2): Loop {
  const vs = corners.map((c) => b.addVertex({ point: at(c[0], c[1]) }));
  const coedges: Coedge[] = corners.map((c, i) => {
    const next = to && corners.length === 1 ? to : corners[(i + 1) % corners.length]!;
    const e = b.addEdge({ start: vs[i]!, end: vs[(i + 1) % corners.length]!, sameSense: true });
    return { edge: e, orientation: 'forward', pcurve: pline(b, c, next), range: [0, 1] };
  });
  return { kind: 'edge', bound: 'outer', coedges };
}

async function measure(d: BrepData, face = 0): Promise<FaceMeasure> {
  using o = new Oracle(await init(), d.buffer);
  return o.face(face);
}
/** The face's vector area, int n dA (faceMoments' degree 0). */
async function vectorArea(d: BrepData, face = 0): Promise<Estimate[]> {
  using o = new Oracle(await init(), d.buffer);
  return o.faceMoments(face, { center: [0, 0, 0], degree: 0 })[0]!.n;
}

/** Converged, within `rel` of the area expected, and its flags `flags`. */
function near(m: FaceMeasure, expected: number, what: string, flags: string[] = [], rel = 1e-9) {
  assert.deepEqual(m.flags, flags, `${what}: ${JSON.stringify(m)}`);
  assert.equal(m.method, 'freeForm', what);
  assert.ok(m.area.status === 'ok' && m.area.error <= rel * expected, `${what}: not converged: ${JSON.stringify(m)}`);
  assert.ok(Math.abs(m.area.value - expected) <= rel * expected, `${what}: ${m.area.value} vs ${expected}`);
}
function nearVector(got: Estimate[], expected: V, scale: number, what: string) {
  for (let j = 0; j < 3; j++) {
    assert.equal(got[j]!.status, 'ok', `${what}[${j}]: ${JSON.stringify(got[j])}`);
    assert.ok(Math.abs(got[j]!.value - expected[j]!) <= 1e-9 * scale && got[j]!.error <= 1e-7 * scale,
      `${what}[${j}]: ${got[j]!.value} vs ${expected[j]} (+/- ${got[j]!.error})`);
  }
}

/** k-point Gauss-Legendre nodes and weights on [-1, 1] (Newton on the Legendre polynomial). */
function gaussLegendre(k: number): { x: number[]; w: number[] } {
  const x: number[] = [], w: number[] = [];
  for (let i = 0; i < k; i++) {
    let z = Math.cos(PI * (i + 0.75) / (k + 0.5)), dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let j = 2; j <= k; j++) [p0, p1] = [p1, ((2 * j - 1) * z * p1 - (j - 1) * p0) / j];
      dp = k * (z * p1 - p0) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-16) break;
    }
    x.push(z), w.push(2 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}

/** A B-spline sphere's face between latitude parameters v1 < v2 (`zone`), or north of v1, or south of v2. */
function sphereBand(R: number, v1: number, v2: number, which: 'zone' | 'north' | 'south'): BrepData {
  const b = new BrepBuilder();
  const s = bspline(b, sphere(R), true, false), at = (u: number, v: number) => spherePoint(R, u, v);
  const loops: Loop[] = [];
  // The face on the loop's left: north of v1 the loop runs +u, south of v2 -u.
  if (which !== 'south') loops.push(loop(b, at, [[0, v1]], [1, v1]));
  if (which !== 'north') loops.push(loop(b, at, [[1, v2]], [0, v2]));
  b.addFace({ surface: s, sameSense: true, loops });
  return b.finish();
}

test('B-spline sphere caps and zones: loops winding u, b0 at the pole on the face\'s side', { skip }, async () => {
  const R = 2, z = (v: number) => R * Math.sin(latitude(v)), cap = (v: number) => TAU * R * (R - z(v));
  for (const [v1, v2] of [[0.2, 0.7], [0.55, 0.9], [0.05, 0.3]]) {
    const zone = TAU * R * (z(v2!) - z(v1!)), north = cap(v1!), whole = 4 * PI * R * R;
    near(await measure(sphereBand(R, v1!, v2!, 'zone')), zone, `zone ${v1}..${v2}`, zone > whole / 2 ? ['sphereSide']
      : []);
    near(await measure(sphereBand(R, v1!, v2!, 'north')), north, `north of ${v1}`,
      north > whole / 2 ? ['sphereSide'] : []);
    const south = TAU * R * (R + z(v2!));
    near(await measure(sphereBand(R, v1!, v2!, 'south')), south, `south of ${v2}`,
      south > whole / 2 ? ['sphereSide'] : []);
    // Its vector area: the disc it projects to, along z (up north of v1, down south of v2).
    const rho = (v: number) => R * Math.cos(latitude(v));
    nearVector(await vectorArea(sphereBand(R, v1!, v2!, 'north')), [0, 0, PI * rho(v1!) ** 2], R * R, `north ${v1}`);
    nearVector(await vectorArea(sphereBand(R, v1!, v2!, 'south')), [0, 0, -PI * rho(v2!) ** 2], R * R, `south ${v2}`);
  }
});

test('B-spline sphere lunes: loops along both pole rows, the far one\'s joint ambiguous by a turn', { skip },
  async () => {
    const R = 1.5;
    for (const [u0, u1] of [[0, 0.3], [0.1, 0.85], [0.6, 1.2]]) {
      const b = new BrepBuilder();
      const s = bspline(b, sphere(R), true, false);
      const S = b.addVertex({ point: [0, 0, -R] }), N = b.addVertex({ point: [0, 0, R] });
      const e1 = b.addEdge({ start: S, end: N, sameSense: true });
      const e0 = b.addEdge({ start: S, end: N, sameSense: true });
      b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
        { edge: e1, orientation: 'forward', pcurve: pline(b, [u1!, 0], [u1!, 1]), range: [0, 1] },
        { edge: e0, orientation: 'reversed', pcurve: pline(b, [u0!, 0], [u0!, 1]), range: [0, 1] }] }] });
      const area = 2 * R * R * (angle(u1!) - angle(u0!));
      near(await measure(b.finish()), area, `lune ${u0}..${u1}`, area > 2 * PI * R * R ? ['sphereSide'] : []);
    }
  });

test('a B-spline sphere sector up to its north pole: a gap along that row only, b0 there', { skip }, async () => {
  const R = 2;
  // The last past half a turn: the pole row's joint, run the shorter way, is then the wrong way round, which H zero
  // at that row makes harmless.
  for (const [u0, u1, v1] of [[0.1, 0.35, 0.6], [0.7, 1.15, 0.2], [0.05, 0.8, 0.4]] as [number, number, number][]) {
    const b = new BrepBuilder();
    const s = bspline(b, sphere(R), true, false), at = (u: number, v: number) => spherePoint(R, u, v);
    // Along the latitude +u, up the meridian at u1 to the pole, down the one at u0: the pole row closes it.
    const A = b.addVertex({ point: at(u0, v1) }), B = b.addVertex({ point: at(u1, v1) });
    const N = b.addVertex({ point: [0, 0, R] });
    const e0 = b.addEdge({ start: A, end: B, sameSense: true }), e1 = b.addEdge({ start: B, end: N, sameSense: true });
    const e2 = b.addEdge({ start: N, end: A, sameSense: true });
    b.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
      { edge: e0, orientation: 'forward', pcurve: pline(b, [u0, v1], [u1, v1]), range: [0, 1] },
      { edge: e1, orientation: 'forward', pcurve: pline(b, [u1, v1], [u1, 1]), range: [0, 1] },
      { edge: e2, orientation: 'forward', pcurve: pline(b, [u0, 1], [u0, v1]), range: [0, 1] }] }] });
    near(await measure(b.finish()), R * R * (angle(u1) - angle(u0)) * (1 - Math.sin(latitude(v1))),
      `sector ${u0}..${u1} north of ${v1}`);
  }
});

/** A B-spline torus face bounded by `loops` of (u, v) corners (each as loop()'s), or the whole torus less them. */
function torusFace(R: number, r: number, loops: { corners: P2[]; to?: P2 }[]): BrepData {
  const b = new BrepBuilder();
  const s = bspline(b, torus(R, r), true, true), at = (u: number, v: number) => torusPoint(R, r, u, v);
  b.addFace({ surface: s, sameSense: true, loops: loops.map((l) => loop(b, at, l.corners, l.to)) });
  return b.finish();
}
/** The torus's area over angles [a0, a1] x [l0, l1], and its vector area's z. */
const torusArea = (R: number, r: number, a0: number, a1: number, l0: number, l1: number) =>
  r * (a1 - a0) * (R * (l1 - l0) + r * (Math.sin(l1) - Math.sin(l0)));
const torusNz = (R: number, r: number, a0: number, a1: number, l0: number, l1: number) =>
  r * (a1 - a0) * (R * (Math.cos(l0) - Math.cos(l1)) + r * (Math.sin(l1) ** 2 - Math.sin(l0) ** 2) / 2);

test('B-spline torus patches across both seams, the whole torus less one, bands winding u', { skip }, async () => {
  const R = 3, r = 1, whole = 4 * PI * PI * R * r;
  for (const [u0, u1, v0, v1] of [[0.875, 1.125, 0.875, 1.125], [0.1, 0.4, 0.3, 0.9], [0.6, 1.3, -0.2, 0.15]]) {
    const corners: P2[] = [[u0!, v0!], [u1!, v0!], [u1!, v1!], [u0!, v1!]];
    const a = torusArea(R, r, angle(u0!), angle(u1!), angle(v0!), angle(v1!));
    const what = `patch ${u0}..${u1} x ${v0}..${v1}`;
    near(await measure(torusFace(R, r, [{ corners }])), a, what, a > whole / 2 ? ['sphereSide'] : []);
    nearVector(await vectorArea(torusFace(R, r, [{ corners }])).then((n) => [n[2]!, n[2]!, n[2]!]),
      [0, 0, 0].map(() => torusNz(R, r, angle(u0!), angle(u1!), angle(v0!), angle(v1!))) as V, R * r, what);
    // The whole torus less the patch: its loop the other way round.
    near(await measure(torusFace(R, r, [{ corners: corners.slice().reverse() }])), whole - a, `less ${what}`,
      whole - a > whole / 2 ? ['sphereSide'] : []);
  }
  // A band between latitudes v0 < v1: loops winding u, +u at v0 and -u at v1.
  const [v0, v1] = [0.3, 0.55];
  const band = torusArea(R, r, 0, TAU, angle(v0), angle(v1));
  near(await measure(torusFace(R, r, [{ corners: [[0, v0]], to: [1, v0] }, { corners: [[1, v1]], to: [0, v1] }])),
    band, 'band in v', band > whole / 2 ? ['sphereSide'] : []);
});

test('B-spline torus bands winding v: every row of v crossed, the cut\'s stretch inside added', { skip },
  async () => {
    const R = 3, r = 1, whole = 4 * PI * PI * R * r;
    for (const [u0, u1] of [[0.1, 0.35], [0.8, 1.05], [0.2, 0.9]]) {
      // The face on the loops' left: -v at u0, +v at u1.
      const d = torusFace(R, r, [{ corners: [[u1!, 0]], to: [u1!, 1] }, { corners: [[u0!, 1]], to: [u0!, 0] }]);
      const a = torusArea(R, r, angle(u0!), angle(u1!), 0, TAU);
      near(await measure(d), a, `band ${u0}..${u1}`, a > whole / 2 ? ['sphereSide'] : []);
      // int n dA over a band of whole minor circles: pi r^2 times the chord's turn, in x and y.
      const t0 = angle(u0!), t1 = angle(u1!);
      nearVector(await vectorArea(d), [PI * r * r * (Math.sin(t1) - Math.sin(t0)),
        -PI * r * r * (Math.cos(t1) - Math.cos(t0)), 0], R * r, `band ${u0}..${u1}`);
    }
  });

test('a B-spline cylinder periodic in v only: the inner integral along u', { skip }, async () => {
  const r = 2, h = 5;
  for (const [u0, u1] of [[0, 1], [0.2, 0.7]]) {
    const b = new BrepBuilder();
    const s = bspline(b, swappedCylinder(r, h), false, true);
    const at = (u: number, v: number): V => [r * Math.cos(angle(v)), r * Math.sin(angle(v)), h * u];
    // The face on the loops' left: -v at u0, +v at u1.
    b.addFace({ surface: s, sameSense: true, loops: [loop(b, at, [[u1!, 0]], [u1!, 1]), loop(b, at, [[u0!, 1]],
      [u0!, 0])] });
    near(await measure(b.finish()), TAU * r * h * (u1! - u0!), `band ${u0}..${u1}`);
  }
});

/**
 * The square [0, 4]^2 at z = 0 as a biquadratic B-spline whose middle pole is off centre (so (u, v) maps unevenly),
 * less the disc of radius rho about (2, 2), its edge a 3D circle with no p-curve (projected); at z = `dz` as an
 * offset of it by dz.
 */
function planarHole(rho: number, dz = 0): BrepData {
  const b = new BrepBuilder();
  const poles: V[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => [2 * i, 2 * j, 0] as V));
  poles[1]![1] = [1.3, 2.6, 0];
  const base = bspline(b, { uDegree: 2, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1], poles }, false, false);
  const s = dz ? b.addSurface({ kind: 'offset', basis: base, distance: dz, selfIntersect: false }) : base;
  // The square's corners: the poles' (an edge of the patch is straight, its middle pole midway).
  const at = (u: number, v: number): V => [4 * u, 4 * v, dz];
  const outer = loop(b, at, [[0, 0], [1, 0], [1, 1], [0, 1]]);
  const c = b.addCurve({ kind: 'circle', radius: rho, position: { origin: [2, 2, dz], axis: [0, 0, 1],
    xDir: [1, 0, 0] } });
  const p = b.addVertex({ point: [2 + rho, 2, dz] });
  const e = b.addEdge({ curve: c, start: p, end: p, sameSense: true, range: [0, TAU] });
  b.addFace({ surface: s, sameSense: true, loops: [outer, { kind: 'edge', bound: 'inner', coedges: [
    { edge: e, orientation: 'reversed' }] }] });
  return b.finish();
}

test('a planar B-spline patch with a projected hole, and its offset (a plane again)', { skip }, async () => {
  for (const dz of [0, 0.5, -0.25]) {
    near(await measure(planarHole(0.8, dz)), 16 - PI * 0.64, `dz ${dz}`, ['projectedBoundary'], 1e-6);
  }
});

test('a B-spline face whose loop runs against it: flagged, its area the absolute value', { skip }, async () => {
  const b = new BrepBuilder();
  const poles: V[][] = [0, 1, 2].map((i) => [0, 1, 2].map((j) => [2 * i, 2 * j, 0] as V));
  poles[1]![1] = [1.3, 2.6, 0];
  const s = bspline(b, { uDegree: 2, vDegree: 2, uKnots: [0, 1], vKnots: [0, 1], poles }, false, false);
  b.addFace({ surface: s, sameSense: true, loops: [loop(b, (u, v) => [4 * u, 4 * v, 0], [[0, 0], [0, 1], [1, 1],
    [1, 0]])] });
  near(await measure(b.finish()), 16, 'the square clockwise', ['orientation']);
});

/** The hole about the bump, in (u, v): [U0, U1] x [H0, H1] (the fold of its offset by -0.6 lies within it). */
const U0 = 0.875, U1 = 3.125, H0 = 1.875, H1 = 3.75;

/**
 * A bicubic sheet over [0, 3]^2 (z = 0 but a sharp bump about (1.5, 2)) offset by -d, d past the bump's radius of
 * curvature, so the offset folds there; the face is the square less a hole about the bump (U0 .. H1), so the fold
 * is off the face but on its strips from v = 0 to the hole's top.
 */
function bumpOffset(d: number): { data: BrepData; rects: [number, number, number, number][] } {
  const n = 7, knots = [0, 1, 2, 3, 4], mults = [4, 1, 1, 1, 4], poles: V[][] = [];
  // Uniform cubic knots over [0, 4] mapped to [0, 3]: poles at the Greville points.
  for (let i = 0; i < n; i++) {
    const row: V[] = [];
    for (let j = 0; j < n; j++) row.push([3 * i / (n - 1), 3 * j / (n - 1), i === 3 && j === 4 ? 2.5 : 0]);
    poles.push(row);
  }
  const b = new BrepBuilder();
  const base = bspline(b, { uDegree: 3, vDegree: 3, uKnots: knots, vKnots: knots, poles, uMults: mults,
    vMults: mults }, false, false);
  const s = b.addSurface({ kind: 'offset', basis: base, distance: -d, selfIntersect: false });
  void s;
  return { data: b.finish(), rects: [[0, 4, 0, H0], [0, 4, H1, 4], [0, U0, H0, H1], [U1, 4, H0, H1]] };
}

test('an offset folding off the face but on its strips: taken in bands, flagged cells', { skip }, async () => {
  const d = 0.6, geom = await initGeom();
  const { data: base, rects } = bumpOffset(d);
  // The surface's points for the vertices, and the reference: Gauss-Legendre over each rectangle (per knot span, 24
  // x 24 points), |S_u x S_v| by cad-geom.
  const g = new Geometry(geom, new Uint8Array(base.buffer));
  const offsetRow = 1;
  const at = (u: number, v: number): V => {
    const e = g.evalSurface(offsetRow, [u, v], 0);
    return [e.values[0]!, e.values[1]!, e.values[2]!];
  };
  const G = gaussLegendre(24);
  const spans = (lo: number, hi: number) => {
    const cuts = [lo, ...[1, 2, 3].filter((k) => k > lo && k < hi), hi];
    return cuts.slice(1).map((c, i) => [cuts[i]!, c] as const);
  };
  let expected = 0;
  for (const [u0, u1, v0, v1] of rects) {
    for (const [a0, a1] of spans(u0, u1)) for (const [b0, b1] of spans(v0, v1)) {
      const uv: number[] = [], wts: number[] = [];
      for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
        uv.push((a0 + a1) / 2 + G.x[i]! * (a1 - a0) / 2, (b0 + b1) / 2 + G.x[j]! * (b1 - b0) / 2);
        wts.push(G.w[i]! * G.w[j]! * (a1 - a0) * (b1 - b0) / 4);
      }
      const e = g.evalSurface(offsetRow, uv, 1);
      for (let k = 0; k < wts.length; k++) {
        const o = 9 * k, su = e.values.slice(o + 3, o + 6), sv = e.values.slice(o + 6, o + 9);
        expected += wts[k]! * Math.hypot(su[1]! * sv[2]! - su[2]! * sv[1]!, su[2]! * sv[0]! - su[0]! * sv[2]!,
          su[0]! * sv[1]! - su[1]! * sv[0]!);
      }
    }
  }
  // The face: the square less the hole, both loops p-curves only.
  const b = new BrepBuilder();
  const n = 7, knots = [0, 1, 2, 3, 4], mults = [4, 1, 1, 1, 4], poles: V[][] = [];
  for (let i = 0; i < n; i++) {
    const row: V[] = [];
    for (let j = 0; j < n; j++) row.push([3 * i / (n - 1), 3 * j / (n - 1), i === 3 && j === 4 ? 2.5 : 0]);
    poles.push(row);
  }
  const bs = bspline(b, { uDegree: 3, vDegree: 3, uKnots: knots, vKnots: knots, poles, uMults: mults, vMults: mults },
    false, false);
  const s = b.addSurface({ kind: 'offset', basis: bs, distance: -d, selfIntersect: false });
  const hole: P2[] = [[U0, H0], [U0, H1], [U1, H1], [U1, H0]];
  b.addFace({ surface: s, sameSense: true, loops: [loop(b, at, [[0, 0], [4, 0], [4, 4], [0, 4]]),
    { ...loop(b, at, hole), bound: 'inner' }] });
  g.dispose();
  const m = await measure(b.finish());
  near(m, expected, 'the bump\'s offset', ['cells'], 1e-8);
});

test('a patch folding at a row inside a span: |n| kinks to 0 there, the inner rule adaptive', { skip }, async () => {
  // S(u, v) = (u, g(v), h(v)), g = (v - c)^3, h = eps (v - c)^2 / 2 (cubic Bezier in v, linear in u): |n| = |S_v| =
  // |v - c| sqrt(9 (v - c)^2 + eps^2), whose integral over v is ((9 x^2 + eps^2)^1.5 - eps^3) / 27 from c each way.
  for (const [c, eps] of [[0.37, 0.05], [0.61, 0.01]] as [number, number][]) {
    // Polynomial coefficients to Bezier poles on [0, 1].
    const bez = (a: number[]) => [a[0]!, a[0]! + a[1]! / 3, a[0]! + 2 * a[1]! / 3 + a[2]! / 3,
      a[0]! + a[1]! + a[2]! + a[3]!];
    const g = bez([-(c ** 3), 3 * c * c, -3 * c, 1]), h = bez([eps * c * c / 2, -eps * c, eps / 2, 0]);
    const b = new BrepBuilder();
    const s = bspline(b, { uDegree: 1, vDegree: 3, uKnots: [0, 1], vKnots: [0, 1],
      poles: [0, 1].map((u) => g.map((y, j) => [u, y, h[j]!] as V)) }, false, false);
    const at = (u: number, v: number): V => [u, (v - c) ** 3, eps * (v - c) ** 2 / 2];
    b.addFace({ surface: s, sameSense: true, loops: [loop(b, at, [[0, 0], [1, 0], [1, 1], [0, 1]])] });
    const side = (x: number) => ((9 * x * x + eps * eps) ** 1.5 - eps ** 3) / 27;
    near(await measure(b.finish()), side(c) + side(1 - c), `fold at ${c}, eps ${eps}`);
  }
});

test('an offset of a surface periodic in v only, folding off the face: bands along u, rows wrapping', { skip },
  async () => {
    // A rational cylinder r 2 (v the circle, u its height, cubic over [0, 4]) with a pole pushed out to radius 4, its
    // offset by 1.2 along S_u x S_v (inwards) folds over the bump (u 1.6 .. 2.4, v 0.13 .. 0.37); the face is the
    // band u in [0.5, 3.5] less a hole about the bump, so rows of u below and above the hole cross no loop.
    const c = unitCircle(), b = new BrepBuilder(), d = 1.2;
    const poles = [0, 1, 2, 3, 4, 5, 6].map((i) => c.poles.map((p, j) => {
      const r = i === 3 && j === 2 ? 4 : 2;
      return [r * p[0]!, r * p[1]!, 5 * i / 6] as V;
    }));
    const base = bspline(b, { uDegree: 3, vDegree: 2, uKnots: [0, 1, 2, 3, 4], vKnots: c.knots, poles,
      weights: poles.map(() => c.weights.slice()), uMults: [4, 1, 1, 1, 4] }, false, true);
    const s = b.addSurface({ kind: 'offset', basis: base, distance: d, selfIntersect: false });
    const geom = await initGeom();
    const pre = new BrepBuilder();
    const pb = bspline(pre, { uDegree: 3, vDegree: 2, uKnots: [0, 1, 2, 3, 4], vKnots: c.knots, poles,
      weights: poles.map(() => c.weights.slice()), uMults: [4, 1, 1, 1, 4] }, false, true);
    pre.addSurface({ kind: 'offset', basis: pb, distance: d, selfIntersect: false });
    const g = new Geometry(geom, new Uint8Array(pre.finish().buffer));
    const at = (u: number, v: number): V => {
      const e = g.evalSurface(1, [u, v], 0);
      return [e.values[0]!, e.values[1]!, e.values[2]!];
    };
    const [u0, u1, hu0, hu1, hv0, hv1] = [0.5, 3.5, 1.4, 2.6, 0.08, 0.42];
    // The face on the loops' left: -v at u0, +v at u1, the hole clockwise.
    b.addFace({ surface: s, sameSense: true, loops: [loop(b, at, [[u1, 0]], [u1, 1]), loop(b, at, [[u0, 1]], [u0, 0]),
      { ...loop(b, at, [[hu0, hv0], [hu0, hv1], [hu1, hv1], [hu1, hv0]]), bound: 'inner' }] });
    const data = b.finish();
    // The reference: 24 x 24 Gauss-Legendre per knot span of each rectangle of the face.
    const G = gaussLegendre(24);
    const cut = (lo: number, hi: number, knots: number[]) => {
      const k = [lo, ...knots.filter((x) => x > lo && x < hi), hi];
      return k.slice(1).map((x, i) => [k[i]!, x] as const);
    };
    let expected = 0;
    for (const [a0, a1, b0, b1] of [[u0, u1, 0, hv0], [u0, u1, hv1, 1], [u0, hu0, hv0, hv1], [hu1, u1, hv0, hv1]]) {
      for (const [x0, x1] of cut(a0!, a1!, [1, 2, 3])) for (const [y0, y1] of cut(b0!, b1!, [0.25, 0.5, 0.75])) {
        const uv: number[] = [], w: number[] = [];
        for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
          uv.push((x0 + x1) / 2 + G.x[i]! * (x1 - x0) / 2, (y0 + y1) / 2 + G.x[j]! * (y1 - y0) / 2);
          w.push(G.w[i]! * G.w[j]! * (x1 - x0) * (y1 - y0) / 4);
        }
        const e = g.evalSurface(1, uv, 1);
        for (let k = 0; k < w.length; k++) {
          const o = 9 * k, su = e.values.slice(o + 3, o + 6), sv = e.values.slice(o + 6, o + 9);
          expected += w[k]! * Math.hypot(su[1]! * sv[2]! - su[2]! * sv[1]!, su[2]! * sv[0]! - su[0]! * sv[2]!,
            su[0]! * sv[1]! - su[1]! * sv[0]!);
        }
      }
    }
    g.dispose();
    near(await measure(data), expected, 'the cylinder\'s bump\'s offset', ['cells'], 1e-8);
  });

/**
 * The unit square as a bilinear B-spline on z = 0, its bottom side a quadratic B-spline from (0, 0, 0) to (1, 0, 0)
 * whose middle pole is at 2 h (the curve h off the surface), no p-curves, its edges' tolerance `tol`.
 */
function liftedSquare(h: number, tol: number, swept = false): BrepData {
  const b = new BrepBuilder();
  const surface = swept ? b.addSurface({ kind: 'extrusion', curve: b.addCurve({ kind: 'line', point: [0, 0, 0],
    direction: [1, 0, 0], magnitude: 1 }), direction: [0, 1, 0], magnitude: 1 })
    : b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
      uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 1, 0]], [[1, 0, 0], [1, 1, 0]]],
      uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const [A, B, C, D] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]].map((p) =>
    b.addVertex({ point: p as [number, number, number] }));
  const bulge = b.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
    poles: [[0, 0, 0], [0.5, 0, 2 * h], [1, 0, 0]], closed: false, selfIntersect: false, form: 'unspecified' });
  const line = (p: number[], q: number[]) => b.addCurve({ kind: 'line', point: p as [number, number, number],
    direction: [q[0]! - p[0]!, q[1]! - p[1]!, 0], magnitude: 1 });
  const edges = [b.addEdge({ curve: bulge, start: A!, end: B!, sameSense: true, tolerance: tol }),
    b.addEdge({ curve: line([1, 0, 0], [1, 1, 0]), start: B!, end: C!, sameSense: true, tolerance: tol }),
    b.addEdge({ curve: line([1, 1, 0], [0, 1, 0]), start: C!, end: D!, sameSense: true, tolerance: tol }),
    b.addEdge({ curve: line([0, 1, 0], [0, 0, 0]), start: D!, end: A!, sameSense: true, tolerance: tol })];
  b.addFace({ surface, sameSense: true, loops: [{ kind: 'edge', bound: 'outer',
    coedges: edges.map((edge) => ({ edge, orientation: 'forward' as const })) }] });
  return b.finish();
}

test('an edge placed off its surface (the mesher\'s rule): flagged edgesPlaced, its distance in the area\'s error',
  { skip }, async () => {
    // 1e-4 off at a tolerance of 1e-5: placed (within 100 x), the area's error about that times the side's length,
    // so trusted at 1e-3 but not at 1e-6; 5e-3 off at 1e-4: placed, untrusted at 1e-3 too; past 100 x, not built.
    // On a B-spline (the free-form engine) and the same square as an extrusion (the swept one).
    const module = await init();
    for (const [h, tol, at3, at6, swept] of [[1e-4, 1e-5, true, false, false], [5e-3, 1e-4, false, false, false],
      [1e-4, 1e-5, true, false, true]] as const) {
      using o = new Oracle(module, liftedSquare(h, tol, swept).buffer);
      const m = o.face(0);
      assert.ok(m.flags.includes('edgesPlaced') && m.flags.includes('projectedBoundary'),
        `${h}${swept ? ' swept' : ''}: ${m.flags}`);
      assert.equal(m.area.status, 'ok');
      assert.ok(Math.abs(m.area.value - 1) <= 2 * h, `${h}: ${m.area.value}`);
      assert.ok(m.boundary >= 0.5 * h && m.boundary <= 4 * h, `${h}: boundary ${m.boundary}`);
      assert.equal(trusted(m, 1e-3), at3, `${h}: ${JSON.stringify(m)}`);
      assert.equal(trusted(m, 1e-6), at6, `${h}`);
    }
    using o = new Oracle(module, liftedSquare(1e-2, 1e-5).buffer);
    const m = o.face(0);
    assert.notEqual(m.area.status, 'ok');
    assert.ok(!m.flags.includes('edgesPlaced'));
  });
