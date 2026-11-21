// fix/domain.ts: healed p-curves' poles clamped onto their surface's domain.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CURVE_KIND } from 'cad-brep';
import type { Curve2 } from '../src/edit.ts';
import { evalCurve2, intoDomain, overshoot } from '../src/fix/domain.ts';

/** A cubic Bezier p-curve (one span over [0, 1]) through the four poles, rational where weights are given. */
function bezier(poles: [number, number][], weights?: number[]): Curve2 {
  return { kind: CURVE_KIND.bspline, reals: [0, 1, ...poles.flat(), ...weights ?? []],
    ints: [3, 4, 2, weights ? 1 : 0, 0, 0, 0, 4, 4] };
}
const polesOf = (c: Curve2) => Array.from({ length: c.ints[1]! }, (_, j) => [c.reals[c.ints[2]! + 2 * j]!,
  c.reals[c.ints[2]! + 2 * j + 1]!]);

test('poles past a side are clamped onto it, in the directions asked, and the moves reported', () => {
  // Ending a hair past v = 1 (a fit's overshoot along the iso-line), its first pole a hair below u = 0.
  const c = bezier([[-2e-6, 0.2], [0.3, 0.6], [0.6, 0.9], [0.9, 1 + 3e-5]], [1, 0.8, 0.8, 1]);
  const [ou, ov] = overshoot(c, [0, 1], [0, 1]);
  assert.ok(Math.abs(ou - 2e-6) < 1e-18 && Math.abs(ov - 3e-5) < 1e-15, `${ou} ${ov}`);
  const p = intoDomain(c, [0, 1], [0, 1], true, true);
  assert.deepEqual(polesOf(p.curve), [[0, 0.2], [0.3, 0.6], [0.6, 0.9], [0.9, 1]]);
  assert.ok(Math.abs(p.du - 2e-6) < 1e-18 && Math.abs(p.dv - 3e-5) < 1e-15);
  // Knots, weights and ints untouched; the input not changed.
  assert.deepEqual(Array.from(p.curve.reals).slice(0, 2), [0, 1]);
  assert.deepEqual(Array.from(p.curve.reals).slice(-4), [1, 0.8, 0.8, 1]);
  assert.deepEqual(p.curve.ints, c.ints);
  assert.equal(polesOf(c)[3]![1], 1 + 3e-5);
  // Only v asked (u periodic on the face, say): u left as it is.
  const q = intoDomain(c, [0, 1], [0, 1], false, true);
  assert.deepEqual(polesOf(q.curve)[0], [-2e-6, 0.2]);
  assert.equal(q.du, 0);
});

test('a side whose bound is infinite stays open; other kinds and curves inside are left', () => {
  const c = bezier([[0.1, -5], [0.2, 0], [0.3, 0.5], [0.4, 7]]);
  assert.deepEqual(overshoot(c, [0, 1], [-Infinity, Infinity]), [0, 0]);
  const p = intoDomain(c, [0, 1], [-Infinity, Infinity], true, true);
  assert.deepEqual(polesOf(p.curve), polesOf(c));
  assert.equal(p.du + p.dv, 0);
  const line: Curve2 = { kind: CURVE_KIND.line, reals: [0, 1.5, 1, 0, 1], ints: [] };
  assert.deepEqual(overshoot(line, [0, 1], [0, 1]), [0, 0]);
  assert.equal(intoDomain(line, [0, 1], [0, 1], true, true).curve, line);
  const inside = bezier([[0.1, 0.1], [0.2, 0.2], [0.3, 0.3], [0.4, 0.4]]);
  assert.deepEqual(overshoot(inside, [0, 1], [0, 1]), [0, 0]);
});

test('evalCurve2: a rational cubic Bezier against its closed form, a line by its parameter', () => {
  const P: [number, number][] = [[0, 0], [1, 2], [3, 2], [4, 0]], w = [1, 0.5, 2, 1];
  const c = bezier(P, w);
  for (const t of [0, 0.25, 0.5, 0.9, 1]) {
    const B = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    const W = B.reduce((s, b, i) => s + b * w[i]!, 0);
    const x = B.reduce((s, b, i) => s + b * w[i]! * P[i]![0], 0) / W, y = B.reduce((s, b, i) => s + b * w[i]! *
      P[i]![1], 0) / W;
    const q = evalCurve2(c, t)!;
    assert.ok(Math.abs(q[0] - x) < 1e-14 && Math.abs(q[1] - y) < 1e-14, `${t}: ${q} vs ${x}, ${y}`);
  }
  const line: Curve2 = { kind: CURVE_KIND.line, reals: [1, 2, 0.6, 0.8, 5], ints: [] };
  assert.deepEqual(evalCurve2(line, 2), [1 + 2 * 5 * 0.6, 2 + 2 * 5 * 0.8]);
});

test('a line past a side at its range\'s end is passed through its ends clamped, in the same parameter', () => {
  // Along v = 1 (an iso-line), its end at t = 5 a hair past; its parameter running over [2, 5].
  const line: Curve2 = { kind: CURVE_KIND.line, reals: [0.1, 1 - 4e-9, 0.6, 0.8 * 1e-8 / 0.6, 0.1], ints: [] };
  const range: [number, number] = [2, 5];
  const [, ov] = overshoot(line, [0, 1], [0, 1], range);
  assert.ok(ov > 0, `${ov}`);
  const p = intoDomain(line, [0, 1], [0, 1], false, true, range);
  const a = evalCurve2(p.curve, 2)!, b = evalCurve2(p.curve, 5)!, a0 = evalCurve2(line, 2)!, b0 = evalCurve2(line, 5)!;
  assert.ok(Math.abs(a[0] - a0[0]) < 1e-15 && Math.abs(a[1] - a0[1]) < 1e-15, `start kept: ${a} vs ${a0}`);
  assert.ok(Math.abs(b[0] - b0[0]) < 1e-15 && b[1] === 1, `end on the side: ${b}`);
  assert.ok(Math.abs(p.dv - ov) < 1e-15);
});
