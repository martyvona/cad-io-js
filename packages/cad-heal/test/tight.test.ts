import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisFor, BrepBuilder, type BrepData, PROVENANCE } from 'cad-brep';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { chained, tightFaces } from '../src/fix/tight.ts';

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
    const r = g.edgeParams(d.coedge.edge[c]!), fwd = d.coedge.orientation[c] === 0;
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

test('pcurveTight: a sphere\'s octant to its pole, and a cylinder\'s band between two circles (each loop winding '
  + 'its period): their (u, v) images mean nothing there, neither caught nor said', () => {
  const k = new BrepBuilder({ uncertainty: 1e-6 });
  // The octant of a sphere of radius 5 at the origin down to its south pole: an equator quarter from (-5, 0, 0) to
  // (0, 5, 0) and two meridian quarters from the pole, their circles 1e-11 out, no ranges, listed out of the order
  // they run (B to A, S to B, A to S).
  const sphere = k.addSurface({ kind: 'sphere', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 5 });
  const pa = k.addVertex({ point: [-5, 0, 0] }), pb = k.addVertex({ point: [0, 5, 0] });
  const ps = k.addVertex({ point: [0, 0, -5] });
  const arc = (axis: P, xDir: P, a: number, b: number) => k.addEdge({ curve: k.addCurve({ kind: 'circle', position: {
    origin: [0, 0, 0], axis, xDir }, radius: 5 + 1e-11 }), start: a, end: b, sameSense: true });
  const eq = arc([0, 0, -1], [-1, 0, 0], pa, pb), mb = arc([1, 0, 0], [0, 0, 1], ps, pb);
  const ma = arc([0, 1, 0], [0, 0, 1], ps, pa);
  k.addFace({ surface: sphere, sameSense: true, id: 1, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: eq, orientation: 'reversed' }, { edge: mb, orientation: 'forward' }, { edge: ma, orientation: 'reversed' }] }] });
  // The cylinder: radius 1 about z, the band from z = 0 to 1, its loops the two circles (the top one tilted by 1e-8,
  // within the tolerance, so its exact feet aren't all at one v).
  const cyl = k.addSurface({ kind: 'cylinder', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const circle = (z: number, tilt: number) => {
    const v = k.addVertex({ point: [1, 0, z + tilt] });
    return k.addEdge({ curve: k.addCurve({ kind: 'circle', position: { origin: [0, 0, z], axis: [-tilt, 0, 1],
      xDir: [1, 0, tilt] }, radius: 1 }), start: v, end: v, sameSense: true, range: [0, 2 * Math.PI], tolerance: 1e-6 });
  };
  k.addFace({ surface: cyl, sameSense: true, id: 2, loops: [
    { kind: 'edge', bound: 'outer', coedges: [{ edge: circle(0, 0), orientation: 'forward' }] },
    { kind: 'edge', bound: 'outer', coedges: [{ edge: circle(1, 1e-8), orientation: 'reversed' }] }] });
  const d = k.finish();
  const g = new Geometry(module, new Uint8Array(d.buffer)), t = tightFaces(g, d, 0.0025);
  g.dispose();
  assert.deepEqual([[...t.fit.keys()], t.left], [[], []]);
});

test('pcurveTight takes a loop\'s coedges in the order they run, whatever order they\'re listed in', () => {
  // A triangle A, B, C: B to A, C to B, A to C (the first and last reversed uses of A -> B and C -> A), listed out of
  // that order.
  const k = new BrepBuilder({ uncertainty: 1e-6 });
  const s = k.addSurface({ kind: 'cylinder', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const a = k.addVertex({ point: [1, 0, 0] }), b = k.addVertex({ point: [0, 1, 0] }), c = k.addVertex({ point: [0, 1, 1] });
  const line = (p: P, q: P) => k.addCurve({ kind: 'line', point: p, direction: [q[0] - p[0], q[1] - p[1], q[2] - p[2]]
    .map((x, _, v) => x / Math.hypot(...v)) as P, magnitude: 1 });
  const ab = k.addEdge({ curve: line([1, 0, 0], [0, 1, 0]), start: a, end: b, sameSense: true });
  const cb = k.addEdge({ curve: line([0, 1, 1], [0, 1, 0]), start: c, end: b, sameSense: true });
  const ca = k.addEdge({ curve: line([0, 1, 1], [1, 0, 0]), start: c, end: a, sameSense: true });
  k.addFace({ surface: s, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: ab, orientation: 'reversed' }, { edge: cb, orientation: 'forward' }, { edge: ca, orientation: 'reversed' }] }] });
  const d = k.finish(), l = d.face.firstLoop[0]!, f0 = d.loop.first[l]!;
  assert.deepEqual(chained(d, l), [f0, f0 + 2, f0 + 1]);
  // An external use among them (where its edge would run as a reversed use does): no chain.
  d.coedge.orientation[f0] = 3;
  assert.equal(chained(d, l), undefined);
  // A loop that doesn't close: refused.
  const k2 = new BrepBuilder({ uncertainty: 1e-6 });
  const s2 = k2.addSurface({ kind: 'cylinder', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] },
    radius: 1 });
  const x = k2.addVertex({ point: [1, 0, 0] }), y = k2.addVertex({ point: [0, 1, 0] }), z = k2.addVertex({ point: [0, 1, 1] });
  const e1 = k2.addEdge({ curve: k2.addCurve({ kind: 'line', point: [1, 0, 0], direction: [-Math.SQRT1_2, Math.SQRT1_2, 0],
    magnitude: 1 }), start: x, end: y, sameSense: true });
  const e2 = k2.addEdge({ curve: k2.addCurve({ kind: 'line', point: [0, 1, 0], direction: [0, 0, 1], magnitude: 1 }),
    start: y, end: z, sameSense: true });
  k2.addFace({ surface: s2, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', coedges: [
    { edge: e1, orientation: 'forward' }, { edge: e2, orientation: 'forward' }] }] });
  const d2 = k2.finish();
  assert.equal(chained(d2, d2.face.firstLoop[0]!), undefined);
});
