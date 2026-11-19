import assert from 'node:assert/strict';
import test from 'node:test';
import { CURVE_KIND, type Curve, PROVENANCE, analysisFor } from 'cad-brep';
import { init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { bsplineCylinder, cylinderSide, line2, planeArc, rationalArc, type Use } from './models.ts';
import { sameParameterGap as gap } from './util.ts';

const module = await init();

const sameParameterGap = (d: Parameters<typeof gap>[1], c: number, range: [number, number]) =>
  gap(module, d, c, range);

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
  // The edge's range, absent in the source, written as the one the p-curve's parameter is in.
  const e = d.coedge.edge[2]!;
  assert.ok(Number.isNaN(d.edge.range[2 * e]!));
  assert.deepEqual([...r.model.edge.range.subarray(2 * e, 2 * e + 2)], [0, TWO_PI]);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(a.edge.rangeFrom[e], PROVENANCE.healed);
  assert.equal(a.edge.rangeFrom[d.coedge.edge[0]!], PROVENANCE.given, 'the bottom edge\'s range is the source\'s');
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
  assert.deepEqual(r.diagnostics.map((x) => x.message.replace(/:.*/, '')), ['pcurveReparam'], 'reparameterized, not '
    + 'replaced');
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

test('pcurveReparam: a map that rounds below the p-curve\'s first knot is taken onto it', async () => {
  // The seam's range [0.1, 5.1] onto knots [1e-15, 1.3]: at t = 0.1 the map gives 1e-15 - 8e-19, which the
  // evaluator refuses (a knot that small has no slack).
  const d = cylinderSide({ seamUp: { pcurve: { kind: 'bspline', degree: 1, knots: [1e-15, 1.3], multiplicities: [2, 2],
    poles: [[TWO_PI, 0], [TWO_PI, 5]], closed: false, selfIntersect: false, form: 'unspecified' } },
  seamDown: { pcurve: line2([0, -0.1], [0, 1]) } }, 1e-6, 0.1).finish();
  const r = await healPart(d, {}, module);
  assert.deepEqual(r.diagnostics.map((x) => x.message.replace(/:.*/, '')), ['pcurveReparam']);
  assert.ok(sameParameterGap(r.model, 1, [0.1, 5.1]) < 1e-9);
});

test('pcurveReparam: a p-curve a period up on a B-spline closed in fact (past its row\'s domain) is measured, wrapped '
  + 'by the face\'s period', async () => {
  // The seam's up use at u = 2 (the row's domain [0, 1], the face's period 1), v = 0.5 s over s in [0, 10].
  const d = bsplineCylinder(line2([2, 0], [0, 1], 0.5), [0, 10]).finish();
  const r = await healPart(d, { fixes: { pcurveMissing: false } }, module);
  assert.deepEqual(r.diagnostics.map((x) => x.message.replace(/:.*/, '')), ['pcurveReparam']);
  const c = r.model.coedge.pcurve[1]!;
  assert.deepEqual([...r.model.pool.curveReal.subarray(r.model.curve.real[c]!, r.model.curve.real[c]! + 5)],
    [2, 0, 0, 1, 1], 'u = 2, v = t');
});

test('pcurveReparam: a B-spline without a use range on a face the face API refuses is placed by its knots',
  async () => {
  // The bottom's line p-curve, a fraction of the turn with no use range, can't be placed: the face API refuses the
  // face (no pieces). The top's B-spline over [0, 1] still can, by its own domain.
  const d = cylinderSide({ bottom: { pcurve: line2([0, 0], [1, 0], TWO_PI) },
    top: { pcurve: bspline2([TWO_PI, 5], [0, 5], [0, 1]) } }).finish();
  const r = await healPart(d, { fixes: { pcurveReplace: false } }, module);
  assert.notEqual(r.model.coedge.pcurve[2], d.coedge.pcurve[2], 'the top reparameterized');
  assert.ok(sameParameterGap(r.model, 2, [0, TWO_PI]) < 1e-9);
});

test('reparameterize: a B-spline\'s end knots put exactly on the range\'s ends (bug32314_corrupted\'s numbers)',
  async () => {
    const { reparameterize } = await import('../src/fix/reparam.ts');
    const { CURVE_KIND: K } = await import('cad-brep');
    // Degree 1 over knots [0, 6.28318530718], s = a t + b onto the edge's range [6.2831853065147, 12.566370613694].
    const c = { kind: K.bspline, reals: [0, 6.28318530718, 0, 0, 6.28318530718, 0], ints: [1, 2, 2, 0, 0, 0, 0, 2, 2] };
    const a = 1.000000000000066, b = -6.283185306515132, range: [number, number] = [6.283185306514717,
      12.566370613694303];
    const loose = reparameterize(c, a, b)!, snapped = reparameterize(c, a, b, range)!;
    assert.notEqual(loose.reals[1], range[1], 'the map alone misses the end by rounding');
    assert.equal(snapped.reals[0], range[0]);
    assert.equal(snapped.reals[1], range[1]);
  });

test('pcurveReparam: the pass puts a reparameterized B-spline\'s knots on the edge\'s range exactly', async () => {
  // The seam's range [S, S + 5]; its up use's p-curve over knots [0, 1] maps the first knot to S + 8.9e-16 by itself.
  const S = 6.283185306514717;
  const d = cylinderSide({ seamUp: { pcurve: bspline2([TWO_PI, 0], [TWO_PI, 5], [0, 1]) },
    seamDown: { pcurve: line2([0, -S], [0, 1]) } }, 1e-6, S).finish();
  const r = await healPart(d, { fixes: { pcurveReplace: false } }, module);
  const c = r.model.coedge.pcurve[1]!, at = r.model.curve.real[c]!;
  assert.deepEqual([...r.model.pool.curveReal.subarray(at, at + 2)], [S, S + 5]);
});

for (const [name, use] of [
  ['a B-spline', { pcurve: bspline2([TWO_PI, 0], [TWO_PI, 5 - 1e-9], [0, 5 - 1e-9]) }],
  ['a trimmed line (no knots to snap)', { pcurve: { kind: 'trimmed', basis: 0, trim1: { parameter: 0 },
    trim2: { parameter: 5 - 1e-9 }, sense: true, preference: 'parameter' }, basis: line2([TWO_PI, 0], [0, 1]) }],
] as [string, Use][]) {
  test(`pcurveReparam: ${name} with the curve's parameter but short of its edge's range by 1e-9: the range put on it`,
    async () => {
      // The seam's range [0, 5]; its up use's p-curve the seam itself, its domain ending 1e-9 short of 5.
      const d = cylinderSide({ seamUp: use }).finish();
      const atEnd = async (m: typeof d) => {
        using g = new (await import('cad-geom')).Geometry(module, new Uint8Array(m.buffer));
        return g.evalCoedge(1, [g.edgeParams(m.coedge.edge[1]!).t1], 0).statuses[0];
      };
      assert.notEqual(await atEnd(d), 0, 'the source\'s p-curve can\'t be evaluated at its edge\'s range\'s end');
      const off = await healPart(d, { fixes: { pcurveReparam: false } }, module);
      assert.notEqual(await atEnd(off.model), 0, 'pcurveReparam off leaves it');
      const r = await healPart(d, {}, module);
      assert.equal(await atEnd(r.model), 0);
      const e = r.model.coedge.edge[1]!;
      assert.deepEqual([...r.model.edge.range.subarray(2 * e, 2 * e + 2)], [0, 5 - 1e-9]);
      assert.equal(r.model.coedge.pcurve[1], d.coedge.pcurve[1], 'the p-curve itself kept');
      assert.match(r.diagnostics.find((x) => x.message.includes('ranges put on'))!.message,
        /^pcurveReparam: 1 p-curves' edges' ranges put on their domains .*coedge #22/);
      assert.equal((await analysisFor(r.model, r.analysis!)).edge.rangeFrom[e], PROVENANCE.healed);
    });
}

test('pcurveReparam: an edge running against its curve (its range from 5 to 0) has its range put on in its order',
  async () => {
    // The seam's line down from z = 5: its edge from z = 0 to 5 runs t from 5 to 0. Its up use's p-curve (2 pi, 5 - t)
    // as a B-spline over knots [1e-9, 5], short of the range's end at 0.
    const short = 1e-9;
    const d = cylinderSide({ seamUp: { pcurve: bspline2([TWO_PI, 5 - short], [TWO_PI, 0], [short, 5]) },
      seamDown: { pcurve: { kind: 'line', point: [0, 5], direction: [0, -1], magnitude: 1 } } }, 1e-6, 0, undefined, 2,
    undefined, false, true).finish();
    const r = await healPart(d, {}, module);
    const e = r.model.coedge.edge[1]!;
    assert.deepEqual([...r.model.edge.range.subarray(2 * e, 2 * e + 2)], [5, short]);
  });
