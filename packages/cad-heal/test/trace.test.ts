import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, PROVENANCE, rowCount, TRACE_STATUS, TRACE_STOP } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import type { Diagnostic, Scene } from 'cad-scene';
import { healCurves } from '../src/curves.ts';
import { ModelEdit } from '../src/edit.ts';
import { fixesOn, healPart, healScene } from '../src/index.ts';
import { GROWTH } from '../src/fix/tolerance.ts';
import type { Trace, Tracer } from '../src/trace.ts';
import { bsplineCylinder, cylinderSide, line2 } from './models.ts';
import { sameParameterGap } from './util.ts';

const module = await init();
// bsplineCylinder's coedges: 0 the bottom circle (no p-curve), 1 the seam up, 2 the top circle (none), 3 the seam
// down. Its surface is a B-spline, so the circles' distances from it aren't closed form: past the grid's bound, traced.
const BOTTOM = 0, TOP = 2;
const cylinder = (bottomRadius = 2) => bsplineCylinder(line2([1, 0], [0, 1]), undefined, bottomRadius).finish();

test('a bare coedge on a B-spline the grid can\'t bound: traced, the trace\'s p-curve kept in the curve\'s parameter',
  async () => {
  const d = cylinder(), r = await healPart(d, {}, module);
  const a = await analysisFor(r.model, r.analysis!);
  for (const c of [BOTTOM, TOP]) {
    assert.ok(r.model.coedge.pcurve[c]! >= 0, `coedge ${c} given a p-curve`);
    assert.equal(a.coedge.pcurveFrom[c], PROVENANCE.healed);
    assert.equal(a.coedge.traceStatus[c], TRACE_STATUS.ok);
    assert.equal(a.coedge.traceTol[c], 1e-6, 'traced at the edge\'s tolerance');
    assert.ok(a.coedge.offSurface[c]! < 1e-6);
    assert.ok(Number.isNaN(a.coedge.stopAt[c]!) && a.coedge.stopWhy[c] === TRACE_STOP.none);
    assert.ok(sameParameterGap(module, r.model, c, [0, 2 * Math.PI]) < 1e-6, 'the p-curve in the curve\'s parameter');
  }
  assert.ok([...r.model.edge.tolerance].every(Number.isNaN), 'nothing grown');
  assert.equal(a.coedge.traceStatus[1], TRACE_STATUS.none, 'a given p-curve isn\'t traced');
  assert.match(r.diagnostics.find((x) => x.message.includes('traced'))!.message,
    /^edgeTolerance: 2 coedges' curves traced onto their surfaces .* given the trace's p-curve, 0 of them with their /);
});

test('a curve off its B-spline by 0.05, bare: traced, its p-curve kept and its edge grown to cover it', async () => {
  const r = await healPart(cylinder(2.05), {}, module);
  const a = await analysisFor(r.model, r.analysis!);
  assert.ok(r.model.coedge.pcurve[BOTTOM]! >= 0);
  assert.ok(Math.abs(a.coedge.offSurface[BOTTOM]! - 0.05) < 1e-6, `${a.coedge.offSurface[BOTTOM]}`);
  // Grown to GROWTH times the larger of the curve's distance and the fit's error (its |S(p(t)) - C(t)|, a little more).
  const t = r.model.edge.tolerance[0]!;
  assert.ok(t >= GROWTH * a.coedge.offSurface[BOTTOM]! && t <= GROWTH * 0.0501, `${t}`);
  assert.match(r.diagnostics.find((x) => x.message.includes('traced'))!.message, /, 1 of them with their edges' /);
});

test('closed-form surfaces aren\'t traced (their inversion is no global search); edgeTolerance off traces nothing',
  async () => {
  const calls: number[] = [];
  const spy: Tracer = { trace: (c) => (calls.push(c), { status: 'notMade', offSurface: NaN, stopAt: NaN,
    stopWhy: 0, fit: { why: 'spy' } }) };
  for (const d of [cylinderSide({}, 1e-6, 0, undefined, 2.05).finish()]) {
    using g = new Geometry(module, new Uint8Array(d.buffer));
    healCurves(g, d, new Set(fixesOn()), new ModelEdit(d), [], spy);
  }
  assert.deepEqual(calls, [], 'a cylinder\'s coedges');
  const d = cylinder(2.05);
  using g = new Geometry(module, new Uint8Array(d.buffer));
  healCurves(g, d, new Set(fixesOn({ fixes: { edgeTolerance: false } })), new ModelEdit(d), [], spy);
  assert.deepEqual(calls, [], 'edgeTolerance off');
  healCurves(g, d, new Set(fixesOn()), new ModelEdit(d), [], spy);
  assert.deepEqual(calls, [BOTTOM, TOP], 'on, the B-spline\'s bare coedges');
});

/** healCurves on bsplineCylinder(2.05) with a tracer giving `trace` for every coedge, and an end search counted. */
function withTracer(trace: Trace) {
  const d = cylinder(2.05), edit = new ModelEdit(d), diagnostics: Diagnostic[] = [];
  const searched: string[] = [];
  const tracer: Tracer = { endSearch: (v, f, t) => (searched.push(`${v},${f},${t}`), { v }), trace: () => trace };
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const record = healCurves(g, d, new Set(fixesOn()), edit, diagnostics, tracer);
  return { d, model: edit.finish(), record, diagnostics, searched };
}

// The bottom circle's p-curve: (u, v) = (t / 2 pi, 0) over the circle's [0, 2 pi], right for its fit.
const fitted = { curve: { kind: 1, reals: [0, 0, 1, 0, 2 * Math.PI], ints: [] }, error: 0.05,
  range: [0, 2 * Math.PI] as [number, number], within: true };

test('a trace that stops: no p-curve (even with a fit), where and why recorded and said, its measure kept', () => {
  // Its measure, 0.08, past the vertex's 0.05 gap (which grows the edge too), so it's what sets the edge's.
  const { model, record, diagnostics } = withTracer({ status: 'stopped', offSurface: 0.08, stopAt: 1.25,
    stopWhy: TRACE_STOP.jump, fit: fitted });
  assert.equal(model.coedge.pcurve[BOTTOM], -1);
  assert.equal(record.traceStatus[BOTTOM], TRACE_STATUS.stopped);
  assert.equal(record.stopAt[BOTTOM], 1.25);
  assert.equal(record.stopWhy[BOTTOM], TRACE_STOP.jump);
  assert.equal(record.offSurface[BOTTOM], 0.08);
  assert.match(diagnostics.find((x) => x.message.includes('stopped before'))!.message,
    /^edgeTolerance: 2 traces stopped before their curves' ends: coedge #21 \(edge #11\) at t = 1\.25000 \(jump\)/);
  assert.match(diagnostics.find((x) => x.message.includes('left without'))!.message, /\(stopped\)/);
  assert.ok(Math.abs(model.edge.tolerance[0]! - GROWTH * 0.08) < 1e-12, 'the stopped trace\'s measure grows the edge');
});

test('a finished trace whose fit missed the tolerance, or whose fit is in several pieces: no p-curve, why said', () => {
  for (const [fit, why] of [[{ ...fitted, within: false }, 'its fit short of the tolerance'],
    [{ why: 'several pieces' }, 'several pieces']] as const) {
    const { model, record, diagnostics } = withTracer({ status: 'ok', offSurface: 0.05, stopAt: NaN, stopWhy: 0,
      fit });
    assert.equal(model.coedge.pcurve[BOTTOM], -1, why);
    assert.equal(record.traceStatus[BOTTOM], TRACE_STATUS.ok);
    assert.ok(diagnostics.some((x) => x.message.includes(`left without a p-curve (${why})`)), why);
  }
});

test('a finished trace with its fit within: the fit kept as the coedge\'s p-curve (a control for the above)', () => {
  // The curve's distance (0.08) past the fit's error (0.05): the edge grown to cover the larger.
  const { model, record } = withTracer({ status: 'ok', offSurface: 0.08, stopAt: NaN, stopWhy: 0, fit: fitted });
  assert.ok(model.coedge.pcurve[BOTTOM]! >= 0);
  assert.ok(Math.abs(model.edge.tolerance[0]! - GROWTH * 0.08) < 1e-12, `${model.edge.tolerance[0]}`);
  assert.equal(record.pcurveFrom[BOTTOM], PROVENANCE.healed);
  assert.equal(record.deviation[BOTTOM], 0.05);
});

test('the end searches: once per (vertex, face, tolerance), every trace there reading it', () => {
  const { searched, d } = withTracer({ status: 'notMade', offSurface: NaN, stopAt: NaN, stopWhy: 0,
    fit: { why: 'x' } });
  // The bottom's vertex 0 at both its ends, the top's vertex 1: two searches for four ends.
  assert.equal(rowCount(d, 'vertex'), 2);
  assert.deepEqual(searched, ['0,0,0.000001', '1,0,0.000001']);
});

test('healScene sets each healed part\'s analysis beside its model', async () => {
  const model = cylinder();
  const scene = { parts: [{ brep: { model, format: 'step' }, sources: [] }], diagnostics: [] } as unknown as Scene;
  await healScene(scene, {}, module);
  const b = scene.parts[0]!.brep!;
  assert.notEqual(b.model, model, 'healed');
  await analysisFor(b.model, b.analysis!);
});
