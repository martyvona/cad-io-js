import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, CURVE_KIND, PROVENANCE } from 'cad-brep';
import { init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { cylinderSide, line2, planeArc, planeDisk, rationalArc, sphereOverPole } from './models.ts';
import { sameParameterGap, uvAt } from './util.ts';

const module = await init();
const TWO_PI = 2 * Math.PI;

test('pcurveReplace: a circle\'s p-curve off by half a unit in v, replaced by the projection', async () => {
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0.5], [1, 0]), range: [0, TWO_PI] } }).finish();
  assert.ok(sameParameterGap(module, d, 0, [0, TWO_PI]) > 0.4);
  const r = await healPart(d, {}, module);
  const c = r.model.coedge.pcurve[0]!;
  assert.notEqual(c, d.coedge.pcurve[0]);
  assert.equal(r.model.curve.kind[c], CURVE_KIND.line, 'a coaxial circle\'s is a line');
  assert.ok(sameParameterGap(module, r.model, 0, [0, TWO_PI]) < 1e-9);
  assert.deepEqual([...r.model.coedge.range.subarray(0, 2)], [0, TWO_PI]);
  const replace = r.diagnostics.filter((x) => x.message.startsWith('pcurveReplace:'));
  assert.equal(replace.length, 1);
  assert.match(replace[0]!.message,
    /^pcurveReplace: 1 p-curves replaced .* 0 on planes dropped .*up to 0\.500 mm off.*coedge #21/);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.coedge.pcurveFrom[0], PROVENANCE.healed);
  assert.ok(a.coedge.deviation[0]! < 1e-9, 'the projection\'s error recorded');
});

test('pcurveReplace: a seam\'s two uses off in u, each replaced by its own side of the seam', async () => {
  const d = cylinderSide({ seamUp: { pcurve: line2([TWO_PI - 0.1, 0], [0, 1]), range: [0, 5] },
    seamDown: { pcurve: line2([0.1, 0], [0, 1]), range: [0, 5] } }).finish();
  const r = await healPart(d, {}, module);
  assert.ok(sameParameterGap(module, r.model, 1, [0, 5]) < 1e-9 && sameParameterGap(module, r.model, 3, [0, 5]) < 1e-9);
  assert.ok(Math.abs(uvAt(module, r.model, 1, 2.5)[0] - TWO_PI) < 1e-9, 'the use up at u = 2 pi');
  assert.ok(Math.abs(uvAt(module, r.model, 3, 2.5)[0]) < 1e-9, 'the use down at u = 0');
});

test('pcurveReplace: on a plane an off p-curve is dropped, its range with it', async () => {
  const d = planeArc(rationalArc([[0, 0], [1, 1.2], [2, 0]], [1, 0.5, 2]), [0, 1]).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.coedge.pcurve[0], -1);
  assert.ok(Number.isNaN(r.model.coedge.range[0]!) && Number.isNaN(r.model.coedge.range[1]!));
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveReplace:'))!.message,
    /0 p-curves replaced .* 1 on planes dropped/);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.coedge.pcurveFrom[0], PROVENANCE.none);
});

test('pcurveReplace: a curve off its plane, its p-curve right: the projection isn\'t nearer, the p-curve kept',
  async () => {
  const d = planeArc(undefined, undefined, 0.1).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.coedge.pcurve[0], d.coedge.pcurve[0]);
  const x = r.diagnostics.find((y) => y.message.startsWith('pcurveReplace:'))!;
  assert.equal(x.severity, 'warning');
  assert.match(x.message,
    /^pcurveReplace: 1 p-curves off their edges' curves kept \(the projection not nearer\): coedge #41/);
});

test('pcurveReplace: a p-curve kept off its edge\'s curve by at most max(1e-3 mm, the part\'s tolerance): an info, '
  + 'not a warning', async () => {
  // The arc lifted off its plane by 2e-3 (about 5.7e-4 measured; the part's tolerance 1e-6) and 0.01.
  for (const [off, severity] of [[2e-3, 'info'], [0.01, 'warning']] as const) {
    const r = await healPart(planeArc(undefined, undefined, off).finish(), {}, module);
    const x = r.diagnostics.filter((y) => y.message.startsWith('pcurveReplace:'));
    assert.deepEqual(x.map((y) => y.severity), [severity], `${off}: ${JSON.stringify(r.diagnostics)}`);
    assert.match(x[0]!.message, severity === 'info'
      ? new RegExp(String.raw`^pcurveReplace: 1 p-curves off their edges' curves by at most 0\.00100 mm kept `
        + String.raw`\(the projection not nearer\): coedge #41`)
      : /^pcurveReplace: 1 p-curves off their edges' curves kept \(the projection not nearer\)/);
  }
});

test('pcurveReplace: a circle\'s p-curve half a turn round (affine, not a kind reparam rewrites) is replaced',
  async () => {
  const d = planeDisk({ kind: 'circle', position: { origin: [0, 0], xDir: [-1, 0] }, radius: 1 }).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.coedge.pcurve[0], -1, 'on a plane: dropped');
  assert.ok(r.diagnostics.some((x) => x.message.startsWith('pcurveReparam: 1 p-curves parameterized as an affine')));
});

test('pcurveReplace off keeps an off p-curve', async () => {
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0.5], [1, 0]), range: [0, TWO_PI] } }).finish();
  const r = await healPart(d, { fixes: { pcurveReplace: false } }, module);
  assert.equal(r.model.coedge.pcurve[0], d.coedge.pcurve[0]);
});

test('pcurveReplace: a use whose range was in the old parameter gets the edge\'s', async () => {
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0.5], [1, 0], TWO_PI), range: [0, 1] } }).finish();
  const r = await healPart(d, {}, module);
  assert.notEqual(r.model.coedge.pcurve[0], d.coedge.pcurve[0]);
  assert.deepEqual([...r.model.coedge.range.subarray(0, 2)], [0, TWO_PI]);
  assert.ok(sameParameterGap(module, r.model, 0, [0, TWO_PI]) < 1e-9);
});

test('pcurveReplace: on a plane the curve off it by a little, its p-curve far off: dropped, the projection\'s error '
  + 'said', async () => {
  const d = planeArc(rationalArc([[0, 0], [1, 1.5], [2, 0]], [1, 0.5, 2]), [0, 1], 0.1).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.coedge.pcurve[0], -1);
  const m = r.diagnostics.find((x) => x.message.startsWith('pcurveReplace:'))!.message;
  const [, said] = /the projections up to (\S+) mm/.exec(m)!;
  assert.ok(Number(said) > 0.02 && Number(said) < 0.1, m);
});

test('pcurveReplace: a projection over a pole is three pieces, not one p-curve: the off p-curve kept, said',
  async () => {
  // u = 0.3, v = t / 2: in the sphere's domain, off the meridian (u = 0 then pi).
  const d = sphereOverPole(line2([0.3, 0], [0, 1], 0.5), [0, Math.PI]).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.model.coedge.pcurve[0], d.coedge.pcurve[0]);
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveReplace:'))!.message,
    /^pcurveReplace: 1 p-curves off their edges' curves kept \(the projection several pieces\): coedge #81/);
});
