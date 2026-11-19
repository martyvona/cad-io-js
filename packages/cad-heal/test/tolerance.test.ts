import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, BrepBuilder, PROVENANCE } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { curveOffSurface, GROWTH } from '../src/fix/tolerance.ts';
import { cylinderSide, line2, planeArc, rationalArc } from './models.ts';

const module = await init();

/** The arc's largest height off its plane, at 2001 points (planeArc's curve is row 0 after the plane, its z the
 * distance). */
function arcHeight(d: ReturnType<ReturnType<typeof planeArc>['finish']>): number {
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const ts = Array.from({ length: 2001 }, (_, i) => i / 2000);
  const v = g.evalCurve(d.edge.curve[0]!, ts, 0).values;
  let h = 0;
  for (let i = 0; i < ts.length; i++) h = Math.max(h, Math.abs(v[3 * i + 2]!));
  return h;
}

test('edgeTolerance: a curve off its plane, its p-curve kept: the edge\'s tolerance grown to cover it', async () => {
  const d = planeArc(undefined, undefined, 0.1).finish();
  const h = arcHeight(d);
  assert.ok(h > 0.02, 'the fixture is off its plane');
  const r = await healPart(d, {}, module);
  const t = r.model.edge.tolerance[0]!;
  assert.ok(t >= GROWTH * h * 0.99 && t <= GROWTH * h * 1.01, `${t} for a height of ${h}`);
  assert.ok(Number.isNaN(r.model.edge.tolerance[1]!), 'the line on the plane untouched');
  assert.match(r.diagnostics.find((x) => x.message.startsWith('tolerances grown:'))!.message,
    /^tolerances grown: 1 edge \(edgeTolerance 1 edge\), .* \(edge #31: 1\.00e-6 mm to /);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.edge.toleranceFrom[0], PROVENANCE.healed);
  assert.ok(Number.isNaN(a.edge.givenTolerance[0]!), 'the source gave none');
  assert.equal(a.edge.toleranceFrom[1], PROVENANCE.none);
});

for (const missing of [false, true]) {
  test(`edgeTolerance: a circle off its cylinder by 0.05, its p-curve missing, pcurveMissing ${missing ? 'on' : 'off'}`,
    async () => {
      const d = cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2.05).finish();
      const r = await healPart(d, { fixes: { pcurveMissing: missing } }, module);
      const t = r.model.edge.tolerance[0]!;
      assert.ok(Math.abs(t - GROWTH * 0.05) < 1e-6, `${t}`);
      assert.equal(r.model.coedge.pcurve[0]! >= 0, missing);
    });
}

test('edgeTolerance: a source\'s tolerance that covers it is kept, never shrunk', async () => {
  const d = cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2.05, 0.2).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.edge.tolerance[0], 0.2);
  assert.ok(!r.diagnostics.some((x) => x.message.startsWith('tolerances grown:') && x.message.includes('edge #11')));
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.edge.toleranceFrom[0], PROVENANCE.given);
  assert.equal(a.edge.givenTolerance[0], 0.2);
});

test('edgeTolerance: a source\'s tolerance too small is grown, the source\'s still said', async () => {
  const d = cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2.05, 0.01).finish();
  const r = await healPart(d, {}, module);
  assert.ok(Math.abs(r.model.edge.tolerance[0]! - GROWTH * 0.05) < 1e-6);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.edge.toleranceFrom[0], PROVENANCE.healed);
  assert.equal(a.edge.givenTolerance[0], 0.01);
});

test('edgeTolerance off, or no disagreement: no tolerance changed', async () => {
  for (const [d, opts] of [[cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2.05).finish(),
    { fixes: { edgeTolerance: false } }], [cylinderSide().finish(), {}]] as const) {
    const r = await healPart(d, opts, module);
    assert.ok(Number.isNaN(r.model.edge.tolerance[0]!));
  }
});

test('edgeTolerance: the largest need over an edge\'s uses, the larger first (the side, then a disk on it)',
  async () => {
  const d = cylinderSide({ bottom: {} }, 1e-6, 0, undefined, 2.05, undefined, true).finish();
  const r = await healPart(d, {}, module);
  assert.ok(Math.abs(r.model.edge.tolerance[0]! - GROWTH * 0.05) < 1e-6);
});

test('edgeTolerance: a kept p-curve\'s need with replacement off', async () => {
  const d = planeArc(undefined, undefined, 0.1).finish(), h = arcHeight(d);
  const r = await healPart(d, { fixes: { pcurveReplace: false } }, module);
  assert.ok(Math.abs(r.model.edge.tolerance[0]! - GROWTH * h) < 0.01 * h);
});

test('edgeTolerance: a dropped p-curve\'s need, the projection\'s error', async () => {
  const d = planeArc(rationalArc([[0, 0], [1, 1.5], [2, 0]], [1, 0.5, 2]), [0, 1], 0.1).finish(), h = arcHeight(d);
  const r = await healPart(d, {}, module);
  assert.equal(r.model.coedge.pcurve[0], -1);
  assert.ok(Math.abs(r.model.edge.tolerance[0]! - GROWTH * h) < 0.01 * h);
});

test('edgeTolerance: a replaced p-curve\'s need, the projection\'s error', async () => {
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0.5], [1, 0]), range: [0, 2 * Math.PI] } }, 1e-6, 0, undefined,
    2.05).finish();
  const r = await healPart(d, {}, module);
  assert.notEqual(r.model.coedge.pcurve[0], d.coedge.pcurve[0], 'replaced');
  assert.ok(Math.abs(r.model.edge.tolerance[0]! - GROWTH * 0.05) < 1e-6);
});

test('edgeTolerance: a bare coedge\'s need, the curve\'s largest distance from the surface (not its ends\')',
  async () => {
    const d = planeArc(null, undefined, 0.1).finish(), h = arcHeight(d);
    const r = await healPart(d, {}, module);
    assert.ok(Math.abs(r.model.edge.tolerance[0]! - GROWTH * h) < 0.01 * h);
  });

/** A flat bounded patch z = 0 over [0, 128] x [0, 128] (a bilinear B-spline: curveOffSurface's grid on it, held to
 * 257 points a side, is 0.5 apart) and a line on it along x at y = 0.25, between the grid's rows 0 and 1. */
function patchAndLine() {
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 128], vKnots: [0, 128], uMultiplicities: [2, 2],
    vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 128, 0]], [[128, 0, 0], [128, 128, 0]]], uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  b.addCurve({ kind: 'line', point: [0, 0.25, 0], direction: [1, 0, 0], magnitude: 1 });
  return b.finish();
}

for (const [tol, inverts] of [[0.36, true], [1, false]] as const) {
  test(`curveOffSurface: at tol ${tol} the grid bound ${inverts ? 'can\'t vouch for the spans between samples, so it '
    + 'inverts' : 'covers every span, so it doesn\'t invert'}`, () => {
    // Each sample is within about 0.354 of a grid point, each span adds its length (4 / 32) times the speed (1) over
    // 2: the samples alone would pass at 0.36, the spans don't.
    const d = patchAndLine();
    using g = new Geometry(module, new Uint8Array(d.buffer));
    let calls = 0;
    const invert = g.invertSurface.bind(g);
    g.invertSurface = (...a: Parameters<typeof g.invertSurface>) => (calls++, invert(...a));
    const x = curveOffSurface(g, 0, [0, 4], 0, tol, new Map());
    assert.equal(calls > 0, inverts);
    if (inverts) assert.ok(x < 1e-9, `the line is on the patch: ${x}`);
    else assert.ok(x > 0.354 && x <= 1, `the bound returned: ${x}`);
  });
}

test('curveOffSurface: a span\'s bound takes both its samples\' (here the last sample\'s is the largest)', () => {
  // The line from x = 0 to 3.75 along y = 0.25: its last sample is 0.3536 from the grid, every other at most 0.348,
  // and each span adds 3.75 / 32 / 2 = 0.0586. The last span's bound, 0.412, is past 0.41; the spans' left samples
  // alone would give at most 0.407.
  const d = patchAndLine();
  using g = new Geometry(module, new Uint8Array(d.buffer));
  let calls = 0;
  const invert = g.invertSurface.bind(g);
  g.invertSurface = (...a: Parameters<typeof g.invertSurface>) => (calls++, invert(...a));
  curveOffSurface(g, 0, [0, 3.75], 0, 0.41, new Map());
  assert.ok(calls > 0);
});

test('curveOffSurface: a strip narrower than the tolerance but long gets a grid fine enough to vouch for it', () => {
  // A flat strip 100 long and 0.5 wide at tol 1: the first 9 x 9 grid is 12.5 apart along it; refined to about half
  // the tolerance, a line along its middle is vouched for without inverting.
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1], uMultiplicities: [2, 2],
    vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 0.5, 0]], [[100, 0, 0], [100, 0.5, 0]]], uClosed: false,
    vClosed: false, selfIntersect: false, form: 'unspecified' });
  b.addCurve({ kind: 'line', point: [0, 0.25, 0], direction: [1, 0, 0], magnitude: 1 });
  const d = b.finish();
  using g = new Geometry(module, new Uint8Array(d.buffer));
  let calls = 0;
  const invert = g.invertSurface.bind(g);
  g.invertSurface = (...a: Parameters<typeof g.invertSurface>) => (calls++, invert(...a));
  const x = curveOffSurface(g, 0, [0, 100], 0, 1, new Map());
  assert.equal(calls, 0);
  assert.ok(x <= 1);
});

test('curveOffSurface: a curve just below the surface finds its grid points in the next cell down, without inverting',
  () => {
    // The line 0.01 under the patch: its samples' cells (tol 1 wide) are one below the grid points' at z = 0.
    const b = new BrepBuilder({ uncertainty: 1e-6 });
    b.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1], uMultiplicities: [2, 2],
      vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, 4, 0]], [[4, 0, 0], [4, 4, 0]]], uClosed: false,
      vClosed: false, selfIntersect: false, form: 'unspecified' });
    b.addCurve({ kind: 'line', point: [0, 1, -0.01], direction: [1, 0, 0], magnitude: 1 });
    const d = b.finish();
    using g = new Geometry(module, new Uint8Array(d.buffer));
    let calls = 0;
    const invert = g.invertSurface.bind(g);
    g.invertSurface = (...a: Parameters<typeof g.invertSurface>) => (calls++, invert(...a));
    assert.ok(curveOffSurface(g, 0, [0, 4], 0, 1, new Map()) <= 1);
    assert.equal(calls, 0);
  });
