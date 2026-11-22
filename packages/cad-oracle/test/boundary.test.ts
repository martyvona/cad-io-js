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

test('a given p-curve off its curve: its deviation measured (as a projection\'s), the face refused past the bound',
  () => {
  // The seam's up use's p-curve shifted dv along the seam (v = t + dv): S(p(t)) is dv from C(t) all along the
  // seam's length 5 (its end past the surface's side evaluated on it, as consumers do).
  const right = measure(bsplineCylinder(line2([1, 0], [0, 1])).finish());
  for (const dv of [1e-4, 1e-3]) {
    const off = measure(bsplineCylinder(line2([1, dv], [0, 1])).finish());
    assert.ok(Math.abs(off.boundary - right.boundary - dv * 5) <= 0.01 * dv * 5,
      `dv ${dv}: ${off.boundary} - ${right.boundary} against ${dv * 5}`);
    assert.ok(!trusted(off, 1e-6), `dv ${dv}: refused`);
  }
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

test('closed forms: the boundary 0 (integrated along the edges\' curves)', async () => {
  const { cylinderSide } = await import('../../cad-heal/test/models.ts');
  const m = measure(cylinderSide({ bottom: {} }).finish());
  assert.equal(m.boundary, 0);
});

test('trusted(): the boundary\'s error unknown (NaN) refuses the face, whatever the quadrature\'s; projectedBoundary '
  + 'alone doesn\'t; other flags do', () => {
  const m = (boundary: number, flags: string[] = []) => ({ area: { value: 1, error: 1e-12, status: 'ok' as const },
    perimeter: { value: 4, error: 0, status: 'ok' as const }, method: 'freeForm' as const, flags: flags as never,
    offSurface: NaN, boundary, why: '' });
  assert.equal(trusted(m(0)), true);
  assert.equal(trusted(m(NaN)), false);
  assert.equal(trusted(m(0, ['projectedBoundary'])), true);
  for (const f of ['orientation', 'sphereSide', 'loose', 'winds', 'noLoops', 'offSurface', 'cells']) {
    assert.equal(trusted(m(0, [f, 'projectedBoundary'])), false, f);
  }
});
