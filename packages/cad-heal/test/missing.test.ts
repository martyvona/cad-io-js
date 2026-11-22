import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, PROVENANCE } from 'cad-brep';
import { init } from 'cad-geom';
import { FIXES_OFF_BY_DEFAULT, fixesNamed, fixesOn, healPart, HEAL_FIXES } from '../src/index.ts';
import { bsplineCylinder, cylinderSide, line2, planeArc, sphereOverPole } from './models.ts';
import { sameParameterGap } from './util.ts';

const module = await init();
/** pcurveMissingOnElementary and pcurveMissingOnFreeForm asked for (each off by default). */
const ON = { fixes: { pcurveMissingOnElementary: true } }, FREE = { fixes: { pcurveMissingOnFreeForm: true } };
const TWO_PI = 2 * Math.PI;

test('pcurveMissingOnElementary: a cylinder\'s missing p-curves made, in the circle\'s and the seam\'s parameters',
  async () => {
  const d = cylinderSide({ bottom: {}, top: {}, seamUp: {} }).finish();
  for (const c of [0, 1, 2]) assert.equal(d.coedge.pcurve[c], -1);
  const r = await healPart(d, ON, module);
  for (const [c, range] of [[0, [0, TWO_PI]], [1, [0, 5]], [2, [0, TWO_PI]]] as [number, [number, number]][]) {
    assert.ok(r.model.coedge.pcurve[c]! >= 0, `coedge ${c} has one`);
    assert.ok(sameParameterGap(module, r.model, c, range) < 1e-9, `coedge ${c} the same parameter`);
  }
  assert.equal(r.model.coedge.pcurve[3], d.coedge.pcurve[3], 'the given one left');
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveMissingOnElementary:'))!.message,
    new RegExp('^pcurveMissingOnElementary: 3 p-curves made .*coedge #21 \\(edge #11\\), coedge #22 \\(edge #13\\), '
      + 'coedge #23 \\(edge #12\\)$'));
  const a = await analysisFor(r.model, r.analysis!);
  assert.deepEqual([...a.coedge.pcurveFrom], [PROVENANCE.healed, PROVENANCE.healed, PROVENANCE.healed,
    PROVENANCE.given]);
  // The top edge's range (absent in the source) written; the seam's and the bottom's given or written.
  assert.deepEqual([...r.model.edge.range.subarray(2, 4)], [0, TWO_PI]);
});

test('pcurveMissingOnElementary: the seam\'s up use gets the u = 2 pi side', async () => {
  const d = cylinderSide({ seamUp: {} }).finish();
  const r = await healPart(d, ON, module);
  using g = new (await import('cad-geom')).Geometry(module, new Uint8Array(r.model.buffer));
  assert.ok(Math.abs(g.evalCoedge(1, [2.5], 0).values[0]! - TWO_PI) < 1e-9);
});

test('pcurveMissingOnElementary and pcurveMissingOnFreeForm: nothing on a plane', async () => {
  const d = planeArc().finish();
  const r = await healPart(d, { fixes: { ...ON.fixes, ...FREE.fixes } }, module);
  assert.equal(r.model.coedge.pcurve[1], -1);
  assert.ok(!r.diagnostics.some((x) => x.message.startsWith('pcurveMissing')));
});

test('pcurveMissingOnElementary and pcurveMissingOnFreeForm independent: each leaves the other\'s surfaces bare',
  async () => {
  const cylinder = cylinderSide({ bottom: {} }).finish(), bspline = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  assert.equal((await healPart(cylinder, FREE, module)).model.coedge.pcurve[0], -1, 'a cylinder, free-form on');
  assert.equal((await healPart(bspline, ON, module)).model.coedge.pcurve[0], -1, 'a B-spline, elementary on');
  assert.ok((await healPart(cylinder, ON, module)).model.coedge.pcurve[0]! >= 0, 'a cylinder, elementary on');
  assert.ok((await healPart(bspline, FREE, module)).model.coedge.pcurve[0]! >= 0, 'a B-spline, free-form on');
});

test('fixesNamed: pcurveMissing an alias of elementary and free-form; each fix itself; an unknown name none', () => {
  assert.deepEqual(fixesNamed('pcurveMissing'), ['pcurveMissingOnElementary', 'pcurveMissingOnFreeForm']);
  for (const f of HEAL_FIXES) assert.deepEqual(fixesNamed(f), [f]);
  assert.deepEqual(fixesNamed('nope'), []);
  assert.throws(() => fixesOn({ fixes: { pcurveMissing: true } as never }), /no fix named pcurveMissing/);
});

test('pcurveMissingOnElementary: a projection over a pole (three pieces) leaves the coedge without one, said',
  async () => {
  const d = sphereOverPole().finish();
  const r = await healPart(d, ON, module);
  assert.equal(r.model.coedge.pcurve[0], -1);
  assert.match(r.diagnostics.find((x) => x.message.includes('left without'))!.message,
    /^pcurveMissingOnElementary: 1 coedges left without a p-curve \(the projection several pieces\): coedge #81/);
  assert.ok(r.model.coedge.pcurve[1]! >= 0, 'the equator\'s made');
});

test('pcurveMissingOnFreeForm: on a B-spline closed in fact, the circles\' p-curves made', async () => {
  const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  const r = await healPart(d, FREE, module);
  for (const c of [0, 2]) assert.ok(sameParameterGap(module, r.model, c, [0, TWO_PI]) < 1e-6, `coedge ${c}`);
});

test('pcurveMissingOnElementary off (its default), or healing off: no p-curve made', async () => {
  const d = cylinderSide({ bottom: {} }).finish();
  for (const opts of [{}, { fixes: { pcurveMissingOnElementary: false } }, { heal: false }, { heal: false, ...ON }]) {
    const r = await healPart(d, opts, module);
    assert.equal(r.model.coedge.pcurve[0], -1);
  }
});

test('fixesOn: the three pcurveMissing fixes off by default, each on only when asked', () => {
  const missing = ['pcurveMissingOnPlane', 'pcurveMissingOnElementary', 'pcurveMissingOnFreeForm'] as const;
  assert.deepEqual([...FIXES_OFF_BY_DEFAULT], [...missing]);
  for (const f of missing) {
    assert.ok(!fixesOn().includes(f), f);
    assert.deepEqual(fixesOn({ fixes: { [f]: true } }),
      HEAL_FIXES.filter((x) => x === f || !missing.includes(x as never)));
  }
});

test('pcurveMissingOnFreeForm: every bare use on a B-spline given one, even where the edge needs nothing (healing '
  + 'alone leaves '
  + 'it bare), fitted within the fit tolerance where that\'s tighter than the edge\'s tolerance', async () => {
  const dev = async (pcurveFitTolerance: number, on: boolean) => {
    const d = bsplineCylinder(line2([1, 0], [0, 1])).finish();
    d.edge.tolerance.fill(0.01);
    const r = await healPart(d, { fixes: { pcurveMissingOnFreeForm: on }, pcurveFitTolerance }, module);
    const dev = r.analysis?.coedge.deviation;
    return { pcurves: [0, 2].map((c) => r.model.coedge.pcurve[c]! >= 0), dev: Math.max(dev?.[0] ?? NaN,
      dev?.[2] ?? NaN) };
  };
  assert.deepEqual((await dev(0.0025, false)).pcurves, [false, false], 'off: left bare');
  const coarse = await dev(1e9, true), fine = await dev(5e-5, true);
  assert.deepEqual([coarse.pcurves, fine.pcurves], [[true, true], [true, true]], 'on: made');
  assert.ok(fine.dev <= 5e-5, `within the fit tolerance: ${fine.dev}`);
  assert.ok(coarse.dev > 5e-5 && coarse.dev <= 0.01, `else the edge's tolerance: ${coarse.dev}`);
});

test('pcurveMissingOnPlane: a plane\'s bare uses given their curves\' exact images (a line, a rational B-spline), in '
  + 'their parameters; independent of the other two', async () => {
  const PLANE = { fixes: { pcurveMissingOnPlane: true } };
  const d = planeArc(null).finish();
  assert.deepEqual([d.coedge.pcurve[0], d.coedge.pcurve[1]], [-1, -1]);
  const r = await healPart(d, PLANE, module);
  const { CURVE_KIND } = await import('cad-brep');
  assert.deepEqual([0, 1].map((c) => r.model.curve.kind[r.model.coedge.pcurve[c]!]), [CURVE_KIND.bspline,
    CURVE_KIND.line]);
  assert.ok(sameParameterGap(module, r.model, 0, [0, 1]) < 1e-12, 'the arc\'s image, the same parameter');
  assert.ok(sameParameterGap(module, r.model, 1, [0, 2]) < 1e-12, 'the line\'s');
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveMissingOnPlane:'))!.message,
    /^pcurveMissingOnPlane: 2 p-curves made on planes/);
  const a = await analysisFor(r.model, r.analysis!);
  assert.deepEqual([a.coedge.pcurveFrom[0], a.coedge.pcurveFrom[1]], [PROVENANCE.healed, PROVENANCE.healed]);
  // Independent: the other two leave the plane's bare, and pcurveMissingOnPlane alone a B-spline's.
  assert.equal((await healPart(d, { fixes: { ...ON.fixes, ...FREE.fixes } }, module)).model.coedge.pcurve[1], -1);
  const cyl = bsplineCylinder(line2([1, 0], [0, 1])).finish();
  assert.equal((await healPart(cyl, PLANE, module)).model.coedge.pcurve[0], -1);
});

test('pcurveMissingOnPlane: a circle turning the other way in the plane\'s (u, v) left without, said', async () => {
  const { BrepBuilder } = await import('cad-brep');
  const b = new BrepBuilder({ uncertainty: 1e-6 });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  const circle = b.addCurve({ kind: 'circle', position: { origin: [0, 0, 0], axis: [0, 0, -1], xDir: [1, 0, 0] },
    radius: 1 });
  const v = b.addVertex({ point: [1, 0, 0] });
  const e = b.addEdge({ curve: circle, start: v, end: v, sameSense: true, id: 51 });
  const face = b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: false,
    coedges: [{ edge: e, orientation: 'forward', id: 61 }] }], id: 7 });
  b.addItem({ kind: 'body', ref: b.addBody({ kind: 'sheet', members: [{ ref: b.addShell({ kind: 'open',
    faces: [{ face, sense: true }] }), sense: true }] }) });
  const r = await healPart(b.finish(), { fixes: { pcurveMissingOnPlane: true } }, module);
  assert.equal(r.model.coedge.pcurve[0], -1);
  assert.match(r.diagnostics.find((x) => x.message.startsWith('pcurveMissingOnPlane:'))!.message,
    /left without a p-curve \(a conic turning the other way in \(u, v\)\)/);
});
