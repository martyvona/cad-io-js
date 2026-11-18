import assert from 'node:assert/strict';
import test from 'node:test';
import { CURVE_KIND, type Curve, PROVENANCE, analysisFor } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { cylinderSide, line2, planeArc, rationalArc } from './models.ts';

const module = await init();

/** The largest distance, over the edge's range, from the coedge's p-curve at t (through the surface) to its curve at
 * t: the model's rule, measured independently of the pass (its own samples, cad-geom's evaluators). */
function sameParameterGap(model: ReturnType<ReturnType<typeof cylinderSide>['finish']>, c: number,
  range: [number, number]): number {
  using g = new Geometry(module, new Uint8Array(model.buffer));
  const e = model.coedge.edge[c]!, ci = model.edge.curve[e]!, surface = model.face.surface[0]!;
  const ts = Array.from({ length: 101 }, (_, i) => range[0] + (range[1] - range[0]) * i / 100);
  const p = g.evalCoedge(c, ts, 0).values, C = g.evalCurve(ci, ts, 0).values, uv: number[] = [];
  for (let i = 0; i < ts.length; i++) uv.push(p[3 * i]!, p[3 * i + 1]!);
  const S = g.evalSurface(surface, uv, 0).values;
  let w = 0;
  for (let i = 0; i < ts.length; i++)
    w = Math.max(w, Math.hypot(S[3 * i]! - C[3 * i]!, S[3 * i + 1]! - C[3 * i + 1]!, S[3 * i + 2]! - C[3 * i + 2]!));
  return w;
}

const bspline2 = (from: number[], to: number[], knots: [number, number]): Curve => ({ kind: 'bspline', degree: 1,
  knots, multiplicities: [2, 2], poles: [from, to], closed: false, selfIntersect: false, form: 'unspecified' });

const TWO_PI = 2 * Math.PI;

test('the right p-curves are left as they are; the analysis says whose each p-curve and tolerance is', async () => {
  const d = cylinderSide({}, 1e-6, 0, 1e-7).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.changed, false);
  assert.equal(r.model, d);
  assert.deepEqual(r.diagnostics, []);
  const a = await analysisFor(r.model, r.analysis!);
  assert.deepEqual([...a.coedge.pcurveFrom], [1, 1, 1, 1].map(() => PROVENANCE.given));
  assert.deepEqual([...a.vertex.toleranceFrom], [PROVENANCE.given, PROVENANCE.none]);
  assert.deepEqual([...a.vertex.givenTolerance], [1e-7, NaN]);
});

for (const [name, pcurve, range, want] of [
  // u = 2 pi s over s in [0, 1]: a = 1 / (2 pi), b = 0.
  ['a line by a fraction of the turn', line2([0, 0], [1, 0], TWO_PI), [0, 1], 'line'],
  // Running back from u = 2 pi: s = 1 - t / (2 pi), a < 0.
  ['a line run backwards', line2([TWO_PI, 0], [-1, 0], TWO_PI), [1, 0], 'line'],
  // Offset and scaled: s in [10, 20].
  ['a line offset and scaled', line2([-TWO_PI, 0], [1, 0], TWO_PI / 10), [10, 20], 'line'],
  ['a B-spline over [0, 1]', bspline2([0, 0], [TWO_PI, 0], [0, 1]), [0, 1], 'bspline'],
  ['a B-spline run backwards', bspline2([TWO_PI, 0], [0, 0], [0, 1]), [1, 0], 'bspline'],
] as [string, Curve, [number, number], 'line' | 'bspline'][]) {
  test(`pcurveReparam: ${name} gets the circle's parameter`, async () => {
    const d = cylinderSide({ bottom: { pcurve, range } }).finish();
    assert.ok(sameParameterGap(d, 0, [0, TWO_PI]) > 1, 'the fixture is parameterized otherwise');
    const r = await healPart(d, {}, module);
    assert.equal(r.changed, true);
    const c = r.model.coedge.pcurve[0]!;
    assert.notEqual(c, d.coedge.pcurve[0]);
    assert.equal(r.model.curve.kind[c], CURVE_KIND[want]);
    assert.ok(sameParameterGap(r.model, 0, [0, TWO_PI]) < 1e-9);
    assert.deepEqual([...r.model.coedge.range.subarray(0, 2)], [0, TWO_PI], 'the use\'s range in the new parameter');
    // The other coedges untouched.
    for (let k = 1; k < 4; k++) assert.equal(r.model.coedge.pcurve[k], d.coedge.pcurve[k]);
    assert.equal(r.diagnostics.length, 1);
    assert.match(r.diagnostics[0]!.message, /^pcurveReparam: 1 p-curves .* coedge #21 \(edge #11\)$/);
    const a = await analysisFor(r.model, r.analysis!);
    assert.equal(a.coedge.pcurveFrom[0], PROVENANCE.healed);
    assert.equal(a.coedge.pcurveFrom[1], PROVENANCE.given);
    assert.ok(a.coedge.deviation[0]! < 1e-9, 'the affine map\'s deviation recorded');
  });
}

test('pcurveReparam: without a use range, a B-spline by its knots, its range left absent', async () => {
  const d = cylinderSide({ top: { pcurve: bspline2([TWO_PI, 5], [0, 5], [0, 1]) } }).finish();
  const r = await healPart(d, {}, module);
  assert.equal(r.changed, true);
  assert.ok(Number.isNaN(r.model.coedge.range[4]!));
  assert.ok(sameParameterGap(r.model, 2, [0, TWO_PI]) < 1e-9);
});

test('pcurveReparam: without a use range a line has no ends to map, and is left', async () => {
  const d = cylinderSide({ top: { pcurve: line2([TWO_PI, 5], [-1, 0], TWO_PI) } }).finish();
  const r = await healPart(d, { fixes: { pcurveReplace: false } }, module);
  assert.equal(r.model.coedge.pcurve[2], d.coedge.pcurve[2]);
});

test('pcurveReparam off, or healing off, leaves the p-curve as the source gives it', async () => {
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0], [1, 0], TWO_PI), range: [0, 1] } }).finish();
  for (const opts of [{ fixes: { pcurveReparam: false } }, { heal: false }]) {
    const r = await healPart(d, opts, module);
    assert.equal(r.changed, false);
    assert.equal(r.model, d);
    if (opts.heal === false) assert.equal(r.analysis, undefined, 'no analysis with healing off');
  }
});

test('pcurveReparam: a seam line offset along the seam, on an edge whose range starts past 0', async () => {
  // The seam's curve runs t in [5, 10] up the side; its use's p-curve u = 2 pi, v = -10 + 0.5 s over s in [20, 30]
  // (s = 2 t + 10).
  const d = cylinderSide({ seamUp: { pcurve: line2([TWO_PI, -10], [0, 1], 0.5), range: [20, 30] },
    seamDown: { pcurve: line2([0, -5], [0, 1]) } }, 1e-6, 5).finish();
  assert.ok(sameParameterGap(d, 1, [5, 10]) > 1, 'the fixture is parameterized otherwise');
  const r = await healPart(d, {}, module);
  assert.ok(sameParameterGap(r.model, 1, [5, 10]) < 1e-9);
  assert.deepEqual([...r.model.coedge.range.subarray(2, 4)], [5, 10]);
  assert.equal(r.model.coedge.pcurve[3], d.coedge.pcurve[3], 'the right one left');
});

// A degree 2 B-spline in u along v = `v`, its poles at the Greville abscissae of knots [0, 0.2, 0.5, 1] with
// multiplicities [3, 1, 2, 3] (not symmetric), so u is exactly 2 pi s (or 2 pi (1 - s) backwards).
const greville = [0, 0.1, 0.35, 0.5, 0.75, 1];
const bspline2nu = (v: number, backwards: boolean): Curve => ({ kind: 'bspline', degree: 2, knots: [0, 0.2, 0.5, 1],
  multiplicities: [3, 1, 2, 3], poles: greville.map((x) => [TWO_PI * (backwards ? 1 - x : x), v]), closed: false,
  selfIntersect: false, form: 'unspecified' });

test('pcurveReparam: B-splines with uneven knots, forwards and backwards, two in one part', async () => {
  const d = cylinderSide({ bottom: { pcurve: bspline2nu(0, false) }, top: { pcurve: bspline2nu(5, true) } })
    .finish();
  assert.ok(sameParameterGap(d, 0, [0, TWO_PI]) > 1 && sameParameterGap(d, 2, [0, TWO_PI]) > 1);
  const r = await healPart(d, {}, module);
  assert.ok(sameParameterGap(r.model, 0, [0, TWO_PI]) < 1e-9, 'forwards');
  assert.ok(sameParameterGap(r.model, 2, [0, TWO_PI]) < 1e-9, 'backwards');
  assert.match(r.diagnostics[0]!.message, /^pcurveReparam: 2 p-curves/);
});

test('pcurveReparam: a p-curve whose image is off isn\'t reparameterized', async () => {
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0.5], [1, 0], TWO_PI), range: [0, 1] } }).finish();
  const r = await healPart(d, { fixes: { pcurveReplace: false } }, module);
  assert.equal(r.model.coedge.pcurve[0], d.coedge.pcurve[0]);
  assert.ok(!r.diagnostics.some((x) => x.message.startsWith('pcurveReparam:')));
});

test('pcurveReparam: on a plane, a rational p-curve run backwards (its weights reversed with its poles)', async () => {
  const right = planeArc().finish();
  assert.ok(sameParameterGap(right, 0, [0, 1]) < 1e-12, 'the right one is the same parameter');
  // p(s) = C(1 - s): poles and weights reversed.
  const d = planeArc(rationalArc([[2, 0], [1, 1], [0, 0]], [2, 0.5, 1]), [1, 0]).finish();
  assert.ok(sameParameterGap(d, 0, [0, 1]) > 0.1, 'the fixture is parameterized otherwise');
  const r = await healPart(d, {}, module);
  assert.equal(r.changed, true);
  assert.ok(sameParameterGap(r.model, 0, [0, 1]) < 1e-9);
});
