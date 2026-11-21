import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { analysisFor, type BrepAnalysis, PROVENANCE, TRACE_STATUS, TRACE_STOP } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { type Diagnostic, MESH_PROFILES, type Scene } from 'cad-scene';
import { type CurvesRecord, healCurves, MESH_FIT } from '../src/curves.ts';
import { ModelEdit } from '../src/edit.ts';
import { fixesOn, healPart, healScene, traceRows } from '../src/index.ts';
import { GROWTH } from '../src/fix/tolerance.ts';
import type { Trace, Tracer } from '../src/trace.ts';
import { bsplineCylinder, cylinderSide, line2 } from './models.ts';
import { sameParameterGap } from './util.ts';

const module = await init();
// bsplineCylinder's coedges: 0 the bottom circle (no p-curve), 1 the seam up, 2 the top circle (none), 3 the seam
// down. Its surface is a B-spline, so the circles' distances from it aren't closed form: past the grid's bound, traced.
const BOTTOM = 0, TOP = 2;
const cylinder = (bottomRadius = 2) => bsplineCylinder(line2([1, 0], [0, 1]), undefined, bottomRadius).finish();

/** The analysis's trace row of coedge c, as an object, or undefined where it wasn't traced. */
function traceRow(a: BrepAnalysis, c: number) {
  const i = Array.from(a.trace.coedge).indexOf(c);
  return i < 0 ? undefined : { status: a.trace.status[i]!, tol: a.trace.tol[i]!, offSurface: a.trace.offSurface[i]!,
    stopAt: a.trace.stopAt[i]!, stopWhy: a.trace.stopWhy[i]! };
}
/** healCurves' record of coedge c's trace. */
const recorded = (r: CurvesRecord, c: number) => r.traces.find((x) => x.coedge === c)!;

test('a bare coedge on a B-spline the grid can\'t bound: traced, the trace\'s p-curve kept in the curve\'s parameter',
  async () => {
  const d = cylinder(), r = await healPart(d, {}, module);
  const a = await analysisFor(r.model, r.analysis!);
  for (const c of [BOTTOM, TOP]) {
    assert.ok(r.model.coedge.pcurve[c]! >= 0, `coedge ${c} given a p-curve`);
    assert.equal(a.coedge.pcurveFrom[c], PROVENANCE.healed);
    const t = traceRow(a, c)!;
    assert.equal(t.status, TRACE_STATUS.ok);
    assert.equal(t.tol, 1e-6, 'traced at the edge\'s tolerance (past MESH_FIT x the fine profile\'s deflection)');
    assert.ok(t.offSurface < 1e-6);
    assert.ok(Number.isNaN(t.stopAt) && t.stopWhy === TRACE_STOP.none);
    assert.ok(sameParameterGap(module, r.model, c, [0, 2 * Math.PI]) < 1e-6, 'the p-curve in the curve\'s parameter');
  }
  assert.ok([...r.model.edge.tolerance].every(Number.isNaN), 'nothing grown');
  assert.deepEqual(Array.from(a.trace.coedge), [BOTTOM, TOP], 'only the traced coedges have rows, in order');
  assert.match(r.diagnostics.find((x) => x.message.includes('traced'))!.message,
    /^edgeTolerance: 2 coedges' curves traced onto their surfaces .* given the trace's p-curve, 0 of them with their /);
});

test('a curve off its B-spline by 0.05, bare: traced, its p-curve kept and its edge grown to cover it', async () => {
  const r = await healPart(cylinder(2.05), {}, module);
  const a = await analysisFor(r.model, r.analysis!);
  assert.ok(r.model.coedge.pcurve[BOTTOM]! >= 0);
  const off = traceRow(a, BOTTOM)!.offSurface;
  assert.ok(Math.abs(off - 0.05) < 1e-6, `${off}`);
  // Grown to GROWTH times the larger of the curve's distance and the fit's error (its |S(p(t)) - C(t)|, a little more).
  const t = r.model.edge.tolerance[0]!;
  assert.ok(t >= GROWTH * off && t <= GROWTH * 0.0501, `${t}`);
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

/** healCurves on bsplineCylinder(2.05) with a tracer giving `trace` for every coedge. */
function withTracer(trace: Trace) {
  const d = cylinder(2.05), edit = new ModelEdit(d), diagnostics: Diagnostic[] = [];
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const record = healCurves(g, d, new Set(fixesOn()), edit, diagnostics, { trace: () => trace });
  return { d, model: edit.finish(), record, diagnostics };
}

// The bottom circle's p-curve: (u, v) = (t / 2 pi, 0) over the circle's [0, 2 pi], right for its fit.
const fitted = { curve: { kind: 1, reals: [0, 0, 1, 0, 2 * Math.PI], ints: [] }, error: 0.05,
  range: [0, 2 * Math.PI] as [number, number], within: true };

test('a trace that stops: no p-curve (even with a fit), where and why recorded and said, its measure kept', () => {
  // Its measure, 0.08, past the vertex's 0.05 gap (which grows the edge too), so it's what sets the edge's.
  const { model, record, diagnostics } = withTracer({ status: 'stopped', offSurface: 0.08, stopAt: 1.25,
    stopWhy: TRACE_STOP.jump, fit: fitted });
  assert.equal(model.coedge.pcurve[BOTTOM], -1);
  assert.deepEqual(recorded(record, BOTTOM), { coedge: BOTTOM, status: TRACE_STATUS.stopped, tol: 1e-6,
    offSurface: 0.08, stopAt: 1.25, stopWhy: TRACE_STOP.jump });
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
    assert.equal(recorded(record, BOTTOM).status, TRACE_STATUS.ok);
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

test('a trace fitted within MESH_FIT x the deflection, the edge\'s tolerance only where that fit fails', () => {
  // A deflection of 1e-5 (5e-7 the fine fit, under the edge's 1e-6); a tracer whose fit is within only at the edge's
  // tolerance, or at any.
  for (const fineOk of [false, true]) {
    const tols: number[] = [], d = cylinder(), edit = new ModelEdit(d);
    using g = new Geometry(module, new Uint8Array(d.buffer));
    const record = healCurves(g, d, new Set(fixesOn()), edit, [], { trace: (c, tol) => (tols.push(tol), {
      status: 'ok', offSurface: 1e-9, stopAt: NaN, stopWhy: 0,
      fit: { ...fitted, error: tol / 2, within: fineOk || tol >= 1e-6 } }) }, undefined, 1e-5);
    const what = fineOk ? 'the fine fit within' : 'the fine fit short';
    assert.deepEqual(tols.map((t) => t.toExponential(2)), fineOk ? ['5.00e-7', '5.00e-7'] : ['5.00e-7', '1.00e-6',
      '5.00e-7', '1.00e-6'], what);
    assert.equal(recorded(record, BOTTOM).tol, fineOk ? MESH_FIT * 1e-5 : 1e-6, `${what}: the tolerance recorded`);
    assert.equal(record.deviation[BOTTOM], fineOk ? MESH_FIT * 1e-5 / 2 : 5e-7, `${what}: the fit kept`);
    assert.ok(edit.finish().coedge.pcurve[BOTTOM]! >= 0, what);
  }
});

test('healScene sets each healed part\'s analysis beside its model', async () => {
  const model = cylinder();
  const scene = { parts: [{ brep: { model, format: 'step' }, sources: [] }], diagnostics: [] } as unknown as Scene;
  await healScene(scene, {}, module);
  const b = scene.parts[0]!.brep!;
  assert.notEqual(b.model, model, 'healed');
  await analysisFor(b.model, b.analysis!);
});

test('the trace rows are written in coedge order whatever order the faces traced them in', () => {
  const t = (coedge: number) => ({ coedge, status: 1, tol: 1e-6, offSurface: coedge / 10, stopAt: NaN, stopWhy: 0 });
  const rows = traceRows([t(7), t(2), t(5)]);
  assert.deepEqual(rows.coedge, [2, 5, 7]);
  assert.deepEqual(rows.offSurface, [0.2, 0.5, 0.7], 'each column with its row');
});

test('MESH_FIT mirrors tess-cadio\'s kMeshTolerance (edges.cpp), how the mesher projects a use healing gives none', () => {
  const src = fs.readFileSync(new URL('../../tess-cadio/native/src/edges.cpp', import.meta.url), 'utf8');
  const m = /constexpr double kMeshTolerance = ([0-9.e-]+);/.exec(src);
  assert.ok(m, 'kMeshTolerance found');
  assert.equal(MESH_FIT, Number(m[1]));
});

test('healPart\'s meshDeflection reaches the traces: fitted within MESH_FIT x it', async () => {
  const r = await healPart(cylinder(), { meshDeflection: 1e-5 }, module);
  const a = await analysisFor(r.model, r.analysis!);
  assert.equal(traceRow(a, BOTTOM)!.tol, MESH_FIT * 1e-5);
  assert.ok(r.model.coedge.pcurve[BOTTOM]! >= 0);
});

test('by default the traces are fitted for the fine profile: MESH_FIT x its deflection, under a coarse tolerance', () => {
  const d = cylinder();
  d.edge.tolerance.fill(0.01);
  const tols: number[] = [];
  using g = new Geometry(module, new Uint8Array(d.buffer));
  healCurves(g, d, new Set(fixesOn()), new ModelEdit(d), [], { trace: (c, tol) => (tols.push(tol), { status: 'notMade',
    offSurface: NaN, stopAt: NaN, stopWhy: 0, fit: { why: 'spy' } }) });
  assert.equal(tols[0], MESH_FIT * MESH_PROFILES.fine.linearDeflection);
  assert.equal(tols[1], 0.01, 'then the edge\'s tolerance');
});
