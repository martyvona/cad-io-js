import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, PROVENANCE } from 'cad-brep';
import { init } from 'cad-geom';
import { fixesOn, healPart, HEAL_FIXES } from '../src/index.ts';
import { bsplineCylinder, cylinderSide, line2, planeArc, sphereOverPole } from './models.ts';
import { sameParameterGap } from './util.ts';

const module = await init();
/** pcurveMissing asked for (it's off by default). */
const ON = { fixes: { pcurveMissing: true } };
const TWO_PI = 2 * Math.PI;

test('pcurveMissing: a cylinder\'s missing p-curves made, in the circle\'s and the seam\'s parameters', async () => {
  const d = cylinderSide({ bottom: {}, top: {}, seamUp: {} }).finish();
  for (const c of [0, 1, 2]) assert.equal(d.coedge.pcurve[c], -1);
  const r = await healPart(d, ON, module);
  for (const [c, range] of [[0, [0, TWO_PI]], [1, [0, 5]], [2, [0, TWO_PI]]] as [number, [number, number]][]) {
    assert.ok(r.model.coedge.pcurve[c]! >= 0, `coedge ${c} has one`);
    assert.ok(sameParameterGap(module, r.model, c, range) < 1e-9, `coedge ${c} the same parameter`);
  }
  assert.equal(r.model.coedge.pcurve[3], d.coedge.pcurve[3], 'the given one left');
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveMissing:'))!.message,
    /^pcurveMissing: 3 p-curves made .*coedge #21 \(edge #11\), coedge #22 \(edge #13\), coedge #23 \(edge #12\)$/);
  const a = await analysisFor(r.model, r.analysis!);
  assert.deepEqual([...a.coedge.pcurveFrom], [PROVENANCE.healed, PROVENANCE.healed, PROVENANCE.healed,
    PROVENANCE.given]);
  // The top edge's range (absent in the source) written; the seam's and the bottom's given or written.
  assert.deepEqual([...r.model.edge.range.subarray(2, 4)], [0, TWO_PI]);
});

test('pcurveMissing: the seam\'s up use gets the u = 2 pi side', async () => {
  const d = cylinderSide({ seamUp: {} }).finish();
  const r = await healPart(d, ON, module);
  using g = new (await import('cad-geom')).Geometry(module, new Uint8Array(r.model.buffer));
  assert.ok(Math.abs(g.evalCoedge(1, [2.5], 0).values[0]! - TWO_PI) < 1e-9);
});

test('pcurveMissing: nothing on a plane', async () => {
  const d = planeArc().finish();
  const r = await healPart(d, ON, module);
  assert.equal(r.model.coedge.pcurve[1], -1);
  assert.ok(!r.diagnostics.some((x) => x.message.startsWith('pcurveMissing')));
});

test('pcurveMissing: a projection over a pole (three pieces) leaves the coedge without one, said', async () => {
  const d = sphereOverPole().finish();
  const r = await healPart(d, ON, module);
  assert.equal(r.model.coedge.pcurve[0], -1);
  assert.match(r.diagnostics.find((x) => x.message.includes('left without'))!.message,
    /^pcurveMissing: 1 coedges left without a p-curve \(the projection several pieces\): coedge #81/);
  assert.ok(r.model.coedge.pcurve[1]! >= 0, 'the equator\'s made');
});

test('pcurveMissing: on a B-spline closed in fact, the circles\' p-curves made', async () => {
  const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  const r = await healPart(d, ON, module);
  for (const c of [0, 2]) assert.ok(sameParameterGap(module, r.model, c, [0, TWO_PI]) < 1e-6, `coedge ${c}`);
});

test('pcurveMissing off (its default), or healing off: no p-curve made', async () => {
  const d = cylinderSide({ bottom: {} }).finish();
  for (const opts of [{}, { fixes: { pcurveMissing: false } }, { heal: false }, { heal: false, ...ON }]) {
    const r = await healPart(d, opts, module);
    assert.equal(r.model.coedge.pcurve[0], -1);
  }
});

test('fixesOn: pcurveMissing, off by default, is on only when asked', () => {
  assert.ok(!fixesOn().includes('pcurveMissing'));
  assert.deepEqual(fixesOn(ON), [...HEAL_FIXES]);
});
