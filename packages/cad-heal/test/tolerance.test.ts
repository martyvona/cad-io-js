import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, PROVENANCE } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { GROWTH } from '../src/fix/tolerance.ts';
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
  assert.match(r.diagnostics.find((x) => x.message.startsWith('edgeTolerance:'))!.message,
    /^edgeTolerance: 1 edges' tolerances grown .*: edge #31 \(/);
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
  assert.ok(!r.diagnostics.some((x) => x.message.startsWith('edgeTolerance:') && x.message.includes('edge #11')));
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
