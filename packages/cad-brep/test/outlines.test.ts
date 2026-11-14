import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrepBuilder, faceOutlines } from '../src/index.ts';
import { cube, everyKind, facetedAndWire, seamCylinder } from './models.ts';

const O = { linearDeflection: 0.01, angularDeflection: 0.5 };
const pts = (o: ReturnType<typeof faceOutlines>, k: number) => {
  const x = o.outlines[k]!;
  return Array.from({ length: x.count }, (_, j) => Array.from(o.positions.subarray(3 * (x.start + j), 3 * (x.start + j)
    + 3)));
};

test('a cube: every face\'s four edges, straight, from vertex to vertex, minus the origin', () => {
  const o = faceOutlines(cube().finish(), [1, 0, 0], O);
  assert.deepEqual(o.faces, [21, 22, 23, 24, 25, 26]);
  assert.equal(o.outlines.length, 24);
  assert.ok(o.outlines.every((x) => x.count === 2));
  // The first face (z = 0: corners 0, 2, 3, 1) first edge, from corner 0 to corner 2, the origin taken off.
  assert.deepEqual(pts(o, 0), [[-1, 0, 0], [-1, 1, 0]]);
  const only = faceOutlines(cube().finish(), [0, 0, 0], O, new Set([23]));
  assert.deepEqual([...new Set(only.outlines.map((x) => x.source))], [23]);
  assert.equal(only.faces.length, 6);
  // A face without an id (0) goes by its row.
  const d = cube().finish();
  d.face.id[2] = 0;
  const unnamed = faceOutlines(d, [0, 0, 0], O);
  assert.deepEqual(unnamed.faces, [21, 22, 2, 24, 25, 26]);
  assert.equal(unnamed.outlines.filter((x) => x.source === 2).length, 4);
});

test('a cylinder\'s circles stepped by the deflections, on the circle, through the vertices; the seam once', () => {
  const o = faceOutlines(seamCylinder().finish(), [0, 0, 0], O);
  // The bottom circle, the seam (used twice, drawn once), the top circle.
  assert.equal(o.outlines.length, 3);
  const bottom = pts(o, 0);
  // Radius 2, deflection 0.01: steps of at most 2 acos(1 - 0.005) = 0.2 rad, so 63 over a whole turn.
  assert.equal(bottom.length - 1, Math.ceil(2 * Math.PI / (2 * Math.acos(1 - 0.01 / 2))));
  for (const p of bottom) assert.ok(Math.abs(Math.hypot(p[0]!, p[1]!) - 2) < 1e-6 && Math.abs(p[2]!) < 1e-6);
  assert.deepEqual(bottom[0], [2, 0, 0]);
  assert.deepEqual(bottom.at(-1), [2, 0, 0]);
  // A coarse angle limits the step: 0.5 rad, 13 steps.
  const coarse = faceOutlines(seamCylinder().finish(), [0, 0, 0], { linearDeflection: 10, angularDeflection: 0.5 });
  assert.equal(pts(coarse, 0).length - 1, Math.ceil(2 * Math.PI / 0.5));
});

test('B-spline edges within the deflection; poly loops\' sides; a p-curve-only edge on its surface', () => {
  const b = new BrepBuilder();
  const poles = [[0, 0, 0], [1, 2, 0], [3, 2, 0], [4, 0, 0]];
  const c = b.addCurve({ kind: 'bspline', degree: 3, knots: [0, 1], multiplicities: [4, 4], poles, closed: false,
    selfIntersect: false, form: 'unspecified' });
  const v = [b.addVertex({ point: [0, 0, 0] }), b.addVertex({ point: [4, 0, 0] })];
  const e1 = b.addEdge({ curve: c, start: v[0], end: v[1], sameSense: true });
  const line = b.addCurve({ kind: 'line', point: [4, 0, 0], direction: [-1, 0, 0], magnitude: 1 });
  const e2 = b.addEdge({ curve: line, start: v[1], end: v[0], sameSense: true });
  const plane = b.addSurface({ kind: 'plane', position: { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] } });
  b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e1, orientation: 'forward' }, { edge: e2, orientation: 'forward' }] }], id: 5 });
  // A circle of radius 1 at (10, 0) in the plane, as a p-curve only.
  const pc = b.addCurve({ kind: 'circle', position: { origin: [10, 0], xDir: [1, 0] }, radius: 1 });
  const bare = b.addEdge({ sameSense: true });
  b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: bare, orientation: 'forward', pcurve: pc }] }], id: 6 });
  const d = b.finish();
  const o = faceOutlines(d, [0, 0, 0], O);
  const spline = pts(o, 0);
  assert.deepEqual([spline[0], spline.at(-1)], [[0, 0, 0], [4, 0, 0]]);
  // Each segment's midpoint within the deflection of the curve (Bernstein, independently).
  const at = (t: number) => poles.reduce((a, p, k) => a.map((x, i) => x + [1, 3, 3, 1][k]! * t ** k * (1 - t) ** (3 - k)
    * p[i]!), [0, 0, 0]);
  const near = (q: number[]) => Math.min(...Array.from({ length: 2001 }, (_, k) => Math.hypot(...at(k / 2000)
    .map((x, i) => x - q[i]!))));
  for (let k = 0; k + 1 < spline.length; k++) {
    assert.ok(near(spline[k]!.map((x, i) => (x + spline[k + 1]![i]!) / 2)) < 0.01 + 1e-6);
  }
  assert.ok(spline.length > 10 && spline.length < 200, `${spline.length}`);
  assert.deepEqual(pts(o, 1), [[4, 0, 0], [0, 0, 0]]);
  const circle = pts(o, 2);
  assert.equal(o.outlines[2]!.source, 6);
  for (const q of circle) assert.ok(Math.abs(Math.hypot(q[0]! - 10, q[1]!) - 1) < 1e-6);

  // A poly loop: its sides as line edges (the builder's canonical form), one outline each.
  const poly = faceOutlines(facetedAndWire().finish(), [0, 0, 0], O);
  const sides = poly.outlines.flatMap((x, k) => x.source === poly.outlines[0]!.source ? [pts(poly, k)] : []);
  assert.deepEqual(sides.map((q) => q.map((p) => p.join()).sort().join(' ')).sort(),
    ['0,0,0 0,1,0', '0,0,0 1,0,0', '0,1,0 1,0,0']);
  // everyKind's curve-bounded face: one circle edge.
  assert.ok(faceOutlines(everyKind().finish(), [0, 0, 0], O).outlines.some((x) => x.count > 10));
});

test('outlines end at the vertices themselves; ellipses stepped by their larger semi-axis', () => {
  const b = new BrepBuilder();
  const P = { origin: [0, 0, 0], axis: [0, 0, 1], xDir: [1, 0, 0] };
  const ellipse = b.addCurve({ kind: 'ellipse', position: P, semiAxis1: 4, semiAxis2: 1 });
  // The vertex off the ellipse: the outline starts at it, not at the curve's point.
  const v = b.addVertex({ point: [4.01, 0, 0] });
  const e = b.addEdge({ curve: ellipse, start: v, end: v, sameSense: true });
  const plane = b.addSurface({ kind: 'plane', position: P });
  b.addFace({ surface: plane, sameSense: true, loops: [{ kind: 'edge', bound: 'outer', sense: true,
    coedges: [{ edge: e, orientation: 'forward' }] }] });
  const o = faceOutlines(b.finish(), [0, 0, 0], O);
  const p = pts(o, 0);
  assert.deepEqual([p[0], p.at(-1)], [[Math.fround(4.01), 0, 0], [Math.fround(4.01), 0, 0]]);
  assert.equal(p.length - 1, Math.ceil(2 * Math.PI / (2 * Math.acos(1 - 0.01 / 4))));
});
