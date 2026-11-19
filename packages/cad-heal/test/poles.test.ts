import assert from 'node:assert/strict';
import test from 'node:test';
import { Geometry, init } from 'cad-geom';
import { healPart } from '../src/index.ts';
import { curveTolerances, FAR, SPAN, strayPoles } from '../src/fix/poles.ts';
import { tolerances } from '../src/measure.ts';
import { strayPole } from './models.ts';

const module = await init();
// strayPole's part is 2 mm across, so a pole is far past FAR x 2 mm outside its box; its uncertainty 1e-6.
const SIZE = 2;
type Model = ReturnType<ReturnType<typeof strayPole>['finish']>;

/** The B-spline's largest |z| over its first piece, [0, k1] (the plane is z = 0), at 201 points. */
function firstPieceOff(d: Model, k1: number, row = 0): number {
  using g = new Geometry(module, new Uint8Array(d.buffer));
  const ts = Array.from({ length: 201 }, (_, i) => k1 * i / 200);
  const v = g.evalCurve(row, ts, 0).values;
  let h = 0;
  for (let i = 0; i < ts.length; i++) h = Math.max(h, Math.abs(v[3 * i + 2]!));
  return h;
}

/** The B-spline's pole i (row 0's). */
function pole(d: Model, i: number, row = 0): number[] {
  const nk = d.pool.curveInt[d.curve.int[row]! + 2]!, at = d.curve.real[row]! + nk + 3 * i;
  return Array.from(d.pool.curveReal.subarray(at, at + 3));
}

const moved = async (b: ReturnType<typeof strayPole>, on = true) => {
  const d = b.finish(), r = await healPart(d, { fixes: { strayPole: on } }, module);
  return { d, r, moved: r.diagnostics.find((x) => x.message.startsWith('strayPole:')) };
};

test('bug24383\'s shape: the stray pole moved onto its neighbours, the curve\'s first piece back on its plane',
  async () => {
  const { d, r, moved: x } = await moved(strayPole());
  assert.ok(firstPieceOff(d, 2e-6) > 1e6, 'the fixture leaves the plane');
  assert.deepEqual(pole(r.model, 1), [0, 0, 0]);
  assert.ok(firstPieceOff(r.model, 2e-6) < 1e-9);
  assert.deepEqual(pole(r.model, 4), [0.5, 1, 0], 'the other poles kept');
  assert.equal(r.changed, true);
  assert.equal(x!.severity, 'warning');
  assert.match(x!.message, new RegExp(`^strayPole: 1 poles of 1 curves moved onto their neighbours' common point `
    + `\\(each over ${FAR} x the part's size of 2\\.00 mm outside it, acting on under ${SPAN} of its curve's knot `
    + `range; up to 5\\.20e\\+7 mm out\\): curve row 0 pole 1 \\(5\\.20e\\+7 mm out\\)$`));
});

test('the rule\'s constants', () => {
  assert.equal(FAR, 1e3);
  assert.equal(SPAN, 1e-4);
});

test('the neighbours apart by less than the tolerance: moved onto their midpoint', async () => {
  const { r, moved: x } = await moved(strayPole(undefined, undefined, [0, 0.8e-6, 0]));
  assert.ok(x);
  assert.deepEqual(pole(r.model, 1), [0, 0.4e-6, 0]);
});

test('strayPole off: nothing moved', async () => {
  const { r, moved: x } = await moved(strayPole(), false);
  assert.equal(x, undefined);
  assert.deepEqual(pole(r.model, 1), [-3e7, -3e7, -3e7]);
});

test('near-misses each condition: kept, so the projection still reports it', async () => {
  for (const [what, b] of [
    ['within FAR x the size', strayPole([-0.99 * FAR * SIZE, 0, 0])],
    ['its support SPAN of the range', strayPole(undefined, SPAN)],
    ['its neighbours past the tolerance apart', strayPole(undefined, undefined, [0, 1.1e-6, 0])],
    ['its neighbours past the tolerance apart along z', strayPole(undefined, undefined, [0, 0, 1.1e-6])],
    ['at FAR x the size, above the box\'s middle', strayPole([1, FAR * SIZE, 0])],
    ['its support long though its first span is short', strayPole(undefined, undefined, undefined, undefined, true)],
  ] as const) {
    const { r, moved: x } = await moved(b);
    assert.equal(x, undefined, what);
    assert.notDeepEqual(pole(r.model, 1), pole(r.model, 0), what);
  }
  const { moved: x } = await moved(strayPole([-1.01 * FAR * SIZE, 0, 0], 0.99 * SPAN));
  assert.ok(x, 'just past FAR and just within SPAN: moved');
});

test('the curve judged by its edge\'s tolerance where larger than the part\'s', async () => {
  assert.ok((await moved(strayPole(undefined, undefined, [0, 5e-4, 0], 1e-3))).moved);
  assert.equal((await moved(strayPole(undefined, undefined, [0, 5e-4, 0]))).moved, undefined, 'the part\'s alone');
});

test('curveTolerances: the largest of the edges on each curve', () => {
  const d = strayPole(undefined, undefined, undefined, 1e-3).finish();
  const t = curveTolerances(d, (e) => [1e-3, 2e-3][e]!);
  assert.deepEqual([...t].sort(), [[0, 1e-3], [1, 2e-3]]);
  assert.equal(curveTolerances(d, tolerances(d).edge).get(0), 1e-3);
  d.edge.curve[1] = 0;
  assert.equal(curveTolerances(d, (e) => [1e-3, 2e-3][e]!).get(0), 2e-3, 'two edges on it, the larger second');
  assert.equal(curveTolerances(d, (e) => [2e-3, 1e-3][e]!).get(0), 2e-3, 'the larger first');
});

test('end poles, 2D curves and other kinds are never moved', () => {
  const d = strayPole().finish(), tol = tolerances(d);
  // A tolerance of 10 mm, so neighbours read past the poles' ends (knots, the next row's reals) would pass.
  const moves = (size = tol.size) => strayPoles(d, () => 10, size, tol.lo, tol.hi).map((m) => [m.curve, m.pole]);
  assert.deepEqual(moves(), [[0, 1]]);
  assert.deepEqual(moves(0), [], 'a part of no size');
  // The stray pole put back and an end pole thrown out instead, in a piece of its own (k1 at 1 - 2e-6 for the end):
  // the curve's end, so never moved.
  const R = d.pool.curveReal, k = d.curve.real[0]!, at = k + 3, n = 7;
  R.set([0, 0, 0], at + 3), R.set([-3e7, 0, 0], at);
  assert.deepEqual(moves(), [], 'the start pole');
  R.set([0, 0, 0], at), R.set([3e7, 0, 0], at + 3 * (n - 1)), R[k + 1] = 1 - 2e-6;
  assert.deepEqual(moves(), [], 'the end pole');
  R.set([2, 0, 0], at + 3 * (n - 1)), R[k + 1] = 2e-6, R.set([3e7, 0, 0], at + 3);
  assert.deepEqual(moves(), [[0, 1]], 'a control');
  d.curve.dim[0] = 2;
  assert.deepEqual(moves(), [], 'a 2D curve');
});
