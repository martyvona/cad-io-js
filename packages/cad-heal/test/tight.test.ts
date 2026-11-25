import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, BrepBuilder, type BrepData, PROVENANCE } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { tightFaces } from '../src/fix/tight.ts';

const module = await init();
type P = [number, number, number];

/**
 * A strip 10 mm long and 0.0004 mm wide (a bilinear B-spline, (10 u, 0.0004 v, 0)) and a face on it whose one loop
 * is two chains meeting at (0, 0.0004, 0) and (10, 0.0004, 0): A along the side v = 1 (a line), B a quadratic whose
 * middle pole is `b` (into the strip by y, off it by z). No p-curves; edges' tolerance `tol`.
 */
function strip(b: P, tol = 0.1): BrepData {
  const w = 0.0004, k = new BrepBuilder({ uncertainty: 1e-6 });
  const surface = k.addSurface({ kind: 'bspline', uDegree: 1, vDegree: 1, uKnots: [0, 1], vKnots: [0, 1],
    uMultiplicities: [2, 2], vMultiplicities: [2, 2], poles: [[[0, 0, 0], [0, w, 0]], [[10, 0, 0], [10, w, 0]]],
    uClosed: false, vClosed: false, selfIntersect: false, form: 'unspecified' });
  const p0 = k.addVertex({ point: [0, w, 0] }), p1 = k.addVertex({ point: [10, w, 0] });
  const ea = k.addEdge({ curve: k.addCurve({ kind: 'line', point: [0, w, 0], direction: [1, 0, 0], magnitude: 1 }),
    start: p0, end: p1, sameSense: true, range: [0, 10], tolerance: tol, id: 21 });
  const eb = k.addEdge({ curve: k.addCurve({ kind: 'bspline', degree: 2, knots: [0, 1], multiplicities: [3, 3],
    poles: [[0, w, 0], b, [10, w, 0]], closed: false, selfIntersect: false, form: 'unspecified' }), start: p0, end: p1,
  sameSense: true, range: [0, 1], tolerance: tol, id: 22 });
  k.addFace({ surface, sameSense: true, id: 9, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: ea, orientation: 'forward' }, { edge: eb, orientation: 'reversed' }] }] });
  return k.finish();
}

/** The face's loop's (u, v) image area as the face API takes it (p-curves, else its projections). */
function imageArea(d: BrepData): number {
  const g = new Geometry(module, new Uint8Array(d.buffer));
  const uv: number[] = [];
  for (const c of [0, 1]) {
    const r = g.edgeParams(d.coedge.edge[c]!), fwd = d.coedge.orientation[c] === 1;
    const ts = Array.from({ length: 33 }, (_, i) => fwd ? r.t0 + (r.t1 - r.t0) * i / 32 : r.t1 + (r.t0 - r.t1) * i / 32);
    const ev = g.evalCoedge(c, ts, 0);
    for (let i = 0; i < 33; i++) uv.push(ev.values[3 * i]!, ev.values[3 * i + 1]!);
  }
  g.dispose();
  let a = 0;
  for (let i = 0; i < uv.length / 2; i++) {
    const j = (i + 1) % (uv.length / 2);
    a += uv[2 * i]! * uv[2 * j + 1]! - uv[2 * j]! * uv[2 * i + 1]!;
  }
  return Math.abs(a) / 2;
}

test('pcurveTight: a strip\'s face whose loose projections collapse it, its exact feet not: tight p-curves, the '
  + 'loop\'s area kept, said', async () => {
  // B 0.0003 into the strip (v down to 0.25 at its middle) and 0.001 off it: its feet's region is 2/3 x 0.75 in (u, v).
  const d = strip([5, 0.0004 - 0.0006, 0.002]);
  assert.ok(imageArea(d) < 0.05, `the loose image: ${imageArea(d)}`);
  const g = new Geometry(module, new Uint8Array(d.buffer)), t = tightFaces(g, d, 0.0025);
  g.dispose();
  assert.deepEqual([...t.fit.keys()], [0]);
  assert.ok(t.fit.get(0)! < 0.0025, `tighter than the fit tolerance where needed: ${t.fit.get(0)}`);
  const r = await healPart(d, {}, module);
  const said = r.diagnostics.filter((x) => x.message.startsWith('pcurveTight'));
  assert.deepEqual(said.map((x) => x.severity), ['warning', 'warning'], JSON.stringify(r.diagnostics));
  assert.match(said[0]!.message, new RegExp(String.raw`^pcurveTight: 1 face whose bare uses' projections .* given `
    + String.raw`p-curves fitted within 0\.0025 mm, down to 0\.00025 mm where that collapses them too: #9$`));
  assert.match(said[1]!.message, /^pcurveTight: 2 p-curves made by projecting their edges' curves/);
  const a = await analysisFor(r.model, r.analysis!);
  for (const c of [0, 1]) {
    assert.ok(r.model.coedge.pcurve[c]! >= 0);
    assert.equal(a.coedge.pcurveFrom[c], PROVENANCE.healed);
  }
  const area = imageArea(r.model);
  assert.ok(Math.abs(area - 0.5) < 0.05, `the tight image's area ${area} (its feet's 0.5)`);
});

test('pcurveTight: where the loose projections keep the loop (tolerance 1e-6), or switched off: nothing', async () => {
  const d = strip([5, 0.0004 - 0.0006, 0], 1e-6);
  const g = new Geometry(module, new Uint8Array(d.buffer));
  assert.equal(tightFaces(g, d, 0.0025).fit.size, 0);
  g.dispose();
  const off = await healPart(strip([5, 0.0004 - 0.0006, 0.002]), { fixes: { pcurveTight: false } }, module);
  assert.ok(!off.diagnostics.some((x) => x.message.startsWith('pcurveTight')));
  assert.ok(off.model.coedge.pcurve[1]! < 0, 'bare, as built');
});

test('pcurveTight: a face that bounds next to nothing on its surface whichever way it\'s projected: left', async () => {
  // B along the side 0.002 off the strip, no dip: its exact feet along v = 1 too.
  const d = strip([5, 0.0004, 0.004]);
  const g = new Geometry(module, new Uint8Array(d.buffer));
  assert.equal(tightFaces(g, d, 0.0025).fit.size, 0);
  g.dispose();
});
