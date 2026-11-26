// FaceMeasure.boundary and trusted(): every use's p-curve (given, healed or projected) counted, its deviation times its
// edge's length, against the area; projectedBoundary said but not refused.
import assert from 'node:assert/strict';
import test from 'node:test';
import { openAnalysis } from 'cad-brep';
import { healPart } from 'cad-heal';
import { init as initGeom } from 'cad-geom';
import { init, Oracle, trusted } from '../src/index.ts';
import { bsplineCylinder, line2 } from '../../cad-heal/test/models.ts';

const module = await init(), geom = await initGeom();
// A B-spline cylinder of radius 2 and height 5 (area 20 pi): its seam's p-curves given (u = 1 and u = 0), its circles
// bare (projected by the face API).
const FACE = 0, AREA = 20 * Math.PI;
const measure = (d: { buffer: ArrayBuffer }, analysis?: ArrayBuffer) => {
  using o = new Oracle(module, d.buffer, analysis ? { analysis } : {});
  return o.face(FACE);
};

test('projected circles: flagged projectedBoundary, the bound the projections\' errors times the lengths, trusted '
  + 'within it', () => {
  const m = measure(bsplineCylinder(line2([1, 0], [0, 1])).finish());
  assert.ok(Math.abs(m.area.value - AREA) < 1e-6 * AREA, `${m.area.value}`);
  assert.deepEqual(m.flags, ['projectedBoundary']);
  // Each circle within the edge's tolerance (1e-6, the part's) times its length 4 pi: at most about 2.5e-5.
  assert.ok(m.boundary > 0 && m.boundary <= 2 * 1e-6 * 4 * Math.PI * 1.01, `${m.boundary}`);
  assert.ok(m.area.error >= m.boundary && m.area.error - m.boundary < 1e-9, 'the bound in the error reported');
  assert.equal(trusted(m, 1e-6), m.area.error <= 1e-6 * m.area.value);
  assert.ok(trusted(m, 1e-6), 'within 1e-6 of 20 pi');
  assert.ok(!trusted(m, 1e-9), 'not within 1e-9');
});

// The cylinder's point at (u, 0) near the seam (its last quarter, u in [0.75, 1]: poles (0, -2), (2, -2), (2, 0),
// weights 1, 1/sqrt 2, 1): its distance from the seam's line x = 2, y = 0.
const offSeam = (u: number) => {
  const s = (u - 0.75) / 0.25, w = [1, Math.SQRT1_2, 1], B = [(1 - s) ** 2, 2 * s * (1 - s), s * s];
  const P = [[0, -2], [2, -2], [2, 0]], W = B.reduce((a, x, i) => a + x * w[i]!, 0);
  const [x, y] = [0, 1].map((k) => B.reduce((a, b, i) => a + b * w[i]! * P[i]![k]!, 0) / W);
  return Math.hypot(x! - 2, y!);
};

test('a given p-curve off its curve: its distance from the curve measured, the face refused past the bound', () => {
  // The seam's up use's p-curve moved across the seam to u = 1 - du: S(p(s)) offSeam(1 - du) from the seam's line (all
  // along it, or at its middle), the bound that times its length 5 (the edges' tolerance 0.01 so the face API takes
  // the use's ends at the vertices).
  // Also in the p-curve's own parameter (v = 5 s on [0, 1]), measured against the curve's nearest points; and bent
  // there, its ends on the seam and its middle at u (degree 1 through (1, 0), (u, 2.5), (1, 5)).
  const at = (u: number, how: 'same' | 'scaled' | 'bent') => {
    const b = bsplineCylinder(how === 'same' ? line2([u, 0], [0, 1]) : how === 'scaled' ? line2([u, 0], [0, 5])
      : { kind: 'bspline', degree: 1, knots: [0, 0.5, 1], multiplicities: [2, 1, 2], poles: [[1, 0], [u, 2.5], [1, 5]],
        closed: false, selfIntersect: false, form: 'unspecified' }, how === 'same' ? undefined : [0, 1]).finish();
    b.edge.tolerance.fill(0.01);
    return measure(b);
  };
  for (const how of ['same', 'scaled', 'bent'] as const) {
    const right = at(1, how);
    for (const du of [1e-5, 1e-4]) {
      const off = at(1 - du, how), d = offSeam(1 - du);
      assert.ok(Math.abs(off.boundary - right.boundary - d * 5) <= 0.02 * d * 5,
        `${how}, du ${du}: ${off.boundary} - ${right.boundary} against ${d * 5}`);
      assert.ok(!trusted(off, 1e-6), `${how}, du ${du}: refused`);
    }
  }
});

test('a given p-curve in its own parameter: measured against the curve, not at the edge\'s parameter', () => {
  const right = measure(bsplineCylinder(line2([1, 0], [0, 1])).finish());
  // The seam's p-curve shifted along the seam (v = s + dv): the same segment of the line, its ends found at the
  // vertices, so nothing off.
  for (const dv of [1e-4, 1e-3]) {
    const along = measure(bsplineCylinder(line2([1, dv], [0, 1])).finish());
    assert.ok(Math.abs(along.boundary - right.boundary) <= 1e-9, `dv ${dv}: ${along.boundary} ${right.boundary}`);
    assert.ok(trusted(along, 1e-6), `dv ${dv}: trusted`);
  }
  // On [0, 1] under the seam's [0, 5] (v = 5 s, the use's range [0, 1]): at the edge's parameter t it would be v = 5 t,
  // off the surface past t = 1; measured by its own parameter, on the seam.
  const scaled = measure(bsplineCylinder(line2([1, 0], [0, 5]), [0, 1]).finish());
  assert.ok(Math.abs(scaled.boundary - right.boundary) <= 1e-9, `${scaled.boundary} ${right.boundary}`);
  assert.ok(trusted(scaled, 1e-6));
  // The bottom circle's use given u = s, v = 0 on [0, 1] under the circle's [0, 2 pi]: the surface's u is rational, not
  // the angle, so S(p(s)) differs from C(2 pi s) along the arc by up to about 0.1, but every point is on the circle.
  const arc = measure(bsplineCylinder(line2([1, 0], [0, 1]), undefined, 2,
    { pcurve: line2([0, 0], [1, 0]), range: [0, 1] }).finish());
  assert.ok(Math.abs(arc.area.value - AREA) < 1e-6 * AREA, `${arc.area.value}`);
  assert.ok(arc.boundary <= right.boundary + 1e-6, `${arc.boundary} ${right.boundary}`);
  assert.ok(trusted(arc, 1e-6), `${arc.boundary}`);
});

test('a given p-curve short of its edge, or doubling back along it: refused', () => {
  // The use's range [0, 4] of v = s under the seam's 5: its end 1 from the edge's, counted (or the face refused).
  const short = measure(bsplineCylinder(line2([1, 0], [0, 1]), [0, 4]).finish());
  assert.ok(!trusted(short, 1e-3), `${short.boundary} ${short.why}`);
  // v = (5 - g) s on [0, 1] (the edges' tolerance 0.01, so the face API takes it): every point on the seam, its end g
  // short of the edge's, which the bound counts.
  const loose = (b: ReturnType<typeof bsplineCylinder>) => {
    const d = b.finish();
    d.edge.tolerance.fill(0.01);
    return measure(d);
  };
  const g = 0.005, right = loose(bsplineCylinder(line2([1, 0], [0, 5]), [0, 1]));
  const gm = loose(bsplineCylinder(line2([1, 0], [0, 5 - g]), [0, 1]));
  assert.ok(Math.abs(gm.boundary - right.boundary - g * 5) <= 0.02 * g * 5, `${gm.boundary} ${right.boundary}`);
  // v up to 4, back to 1, then up to 5, every point on the seam: the feet go back along the curve, so the curve the use
  // follows isn't known (the area happens to be right; refused all the same).
  const back = measure(bsplineCylinder({ kind: 'bspline', degree: 1, knots: [0, 1, 2, 3], multiplicities: [2, 1, 1, 2],
    poles: [[1, 0], [1, 4], [1, 1], [1, 5]], closed: false, selfIntersect: false, form: 'unspecified' }, [0, 3])
    .finish());
  assert.ok(Number.isNaN(back.boundary) && !trusted(back, 1e-3), `${back.boundary}`);
});

test('healed p-curves: the analysis\'s deviations taken instead of measured; without it, measured', async () => {
  const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  d.edge.tolerance.fill(0.01);
  const h = await healPart(d, { fixes: { pcurveMissingOnFreeForm: true }, pcurveFitTolerance: 1e-4 }, geom);
  const a = h.analysis!;
  const with_ = measure(h.model, a.buffer), without = measure(h.model);
  assert.deepEqual(with_.flags, [], 'p-curves stored: nothing projected');
  // The healed circles' deviations recorded (within the fit, 1e-4) times their lengths: about the same either way.
  assert.ok(Math.abs(with_.boundary - without.boundary) <= 2 * 1e-4 * 4 * Math.PI,
    `${with_.boundary} ${without.boundary}`);
  // The analysis's deviation planted large: taken as it is, so the face refused.
  const planted = openAnalysis(new Uint8Array(a.buffer.slice(0)));
  for (const c of [0, 2]) planted.coedge.deviation[c] = 0.5;
  const big = measure(h.model, planted.buffer);
  assert.ok(big.boundary >= 2 * 0.5 * 4 * Math.PI && !trusted(big, 1e-6), `${big.boundary}`);
  // An analysis of other rows (none of its coedges') is ignored: measured.
  assert.equal(measure(h.model, openAnalysis(new Uint8Array(a.buffer.slice(0))).buffer).boundary, with_.boundary);
});

test('closed forms: no p-curve (integrated along the edges\' curves), each curve\'s distance from the surface and the '
  + 'vertex gaps counted', async () => {
  const { cylinderSide } = await import('../../cad-heal/test/models.ts');
  const m = measure(cylinderSide({ bottom: {} }).finish());
  assert.ok(m.boundary >= 0 && m.boundary < 1e-12, `on the surface, rounding's: ${m.boundary}`);
  // The bottom circle of radius 2 + d, d off the cylinder all round (its vertex on it, so the seam's line misses that
  // vertex by d): d times the circle's length, plus the seam's gap d times its length 5 for each of its two uses;
  // trusted at 1e-6 while that's within 1e-6 of the area (20 pi), not past it. The disk under it, the same circle on
  // its plane: nothing (the distance is the coedge's from its own face's surface).
  for (const d of [1e-6, 1e-4, 1e-2]) {
    const b = cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2 + d, undefined, true).finish();
    using o = new Oracle(module, b.buffer);
    const side = o.face(0), disk = o.face(1), want = d * 2 * Math.PI * (2 + d) + 2 * d * 5;
    assert.equal(side.method, 'closedForm');
    assert.ok(Math.abs(side.boundary - want) <= 0.01 * want, `d ${d}: ${side.boundary} against ${want}`);
    assert.ok(side.area.error >= side.boundary, `d ${d}: the bound in the error`);
    assert.equal(trusted(side, 1e-6), d < 1e-5, `d ${d}: at 1e-6 (${side.boundary / side.area.value})`);
    assert.ok(disk.area.status === 'ok' && disk.boundary < 1e-12, `d ${d}: the disk's ${disk.boundary}`);
  }
});

test('closed forms on a cone: an edge off it taken to its nearest points, not to the cone at its height', async () => {
  // A band of the cone of radius 2 at z = 0 and semi-angle b (70 degrees: shallow) up to z = H, its top circle moved d
  // off the cone along the cone's normal (radius r + d cos b at height H - d sin b): its nearest points are the
  // cone's circle at H, so the area is the band's, pi (2 + r) H / cos b (the same height's would be short by about
  // d tan b times the circle's length). The seam's line runs from the bottom vertex to the top one, its feet on u = 0.
  const { BrepBuilder } = await import('cad-brep');
  const b = 70 * Math.PI / 180, H = 1, r = 2 + H * Math.tan(b);
  for (const d of [0, 1e-3, 1e-2]) {
    const B = new BrepBuilder({ uncertainty: 1e-6 });
    const axis = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
    const zt = H - d * Math.sin(b), rt = r + d * Math.cos(b);
    const bottom = B.addCurve({ kind: 'circle', position: axis, radius: 2 });
    const top = B.addCurve({ kind: 'circle', position: { ...axis, origin: [0, 0, zt] }, radius: rt });
    const len = Math.hypot(rt - 2, zt);
    const seam = B.addCurve({ kind: 'line', point: [2, 0, 0], direction: [(rt - 2) / len, 0, zt / len], magnitude: 1 });
    const v0 = B.addVertex({ point: [2, 0, 0] }), v1 = B.addVertex({ point: [rt, 0, zt] });
    const eb = B.addEdge({ curve: bottom, start: v0, end: v0, sameSense: true, range: [0, 2 * Math.PI] });
    const et = B.addEdge({ curve: top, start: v1, end: v1, sameSense: true, range: [0, 2 * Math.PI] });
    const es = B.addEdge({ curve: seam, start: v0, end: v1, sameSense: true, range: [0, len] });
    const cone = B.addSurface({ kind: 'cone', radius: 2, semiAngle: b, position: axis });
    const face = B.addFace({ surface: cone, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: eb, orientation: 'forward' }, { edge: es, orientation: 'forward' },
        { edge: et, orientation: 'reversed' }, { edge: es, orientation: 'reversed' }] }] });
    const shell = B.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    B.addItem({ kind: 'body', ref: B.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const m = measure(B.finish()), want = Math.PI * (2 + r) * H / Math.cos(b);
    assert.equal(m.method, 'closedForm');
    assert.ok(Math.abs(m.area.value - want) <= 1e-9 * want, `d ${d}: ${m.area.value} against ${want}`);
    assert.ok(Math.abs(m.boundary - d * 2 * Math.PI * rt) <= 0.01 * d * 2 * Math.PI * rt + 1e-12 + 2 * d * len,
      `d ${d}: ${m.boundary}`);
  }
});

test('closed forms on a sphere: an edge cut at the axis into runs takes the largest distance of any of them', async () => {
  // A circle through both poles of the sphere of radius 2, of radius 2 + d about (d, 0, 0), starting at the top: its
  // distance from the sphere about d (1 + sin t), 2d at t = pi / 2 (the first run's, to the axis near t = pi), about d
  // in the last runs; the bound about 2d times its length.
  const { BrepBuilder } = await import('cad-brep');
  for (const d of [1e-4, 1e-3]) {
    const b = new BrepBuilder({ uncertainty: 1e-6 });
    const R = 2 + d;
    const circle = b.addCurve({ kind: 'circle', position: { origin: [d, 0, 0], axis: [0, 1, 0], xDir: [0, 0, 1] },
      radius: R });
    const v = b.addVertex({ point: [d, 0, R] });
    const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true, range: [0, 2 * Math.PI] });
    const sphere = b.addSurface({ kind: 'sphere', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
      radius: 2 });
    const face = b.addFace({ surface: sphere, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
      coedges: [{ edge: e, orientation: 'forward' }] }] });
    const shell = b.addShell({ kind: 'open', faces: [{ face, sense: true }] });
    b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: shell, sense: true }] }) });
    const m = measure(b.finish()), want = 2 * d * 2 * Math.PI * R;
    assert.equal(m.area.status, 'ok', m.why);
    assert.ok(Math.abs(m.boundary - want) <= 0.02 * want, `d ${d}: ${m.boundary} against ${want}`);
  }
});

test('trusted(): the boundary\'s error unknown (NaN) refuses the face, whatever the quadrature\'s; projectedBoundary '
  + 'and winds (a computed area: its seam\'s term taken) don\'t; other flags do', () => {
  const m = (boundary: number, flags: string[] = []) => ({ area: { value: 1, error: 1e-12, status: 'ok' as const },
    perimeter: { value: 4, error: 0, status: 'ok' as const }, method: 'freeForm' as const, flags: flags as never,
    offSurface: NaN, boundary, why: '' });
  assert.equal(trusted(m(0)), true);
  assert.equal(trusted(m(NaN)), false);
  assert.equal(trusted(m(0, ['projectedBoundary'])), true);
  assert.equal(trusted(m(0, ['winds', 'projectedBoundary'])), true);
  for (const f of ['orientation', 'sphereSide', 'loose', 'noLoops', 'offSurface', 'cells']) {
    assert.equal(trusted(m(0, [f, 'projectedBoundary'])), false, f);
  }
});
