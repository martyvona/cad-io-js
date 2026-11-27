import assert from 'node:assert/strict';
import { test } from 'node:test';
import { invertPose, multiply, scaleTwist, screwInterpolate, screwMotion, screwOf, se3Exp, se3Log, so3Exp, so3Log,
  type Twist, type Vec3 } from '../src/index.ts';

// The oracle: the matrix exponential of the twist's 4x4 matrix by its Taylor series, after scaling it down by 2^k and
// squaring k times (no closed form, no special cases).
function expm(t: Twist): Float64Array {
  const [x, y, z] = t.w;
  const a = new Float64Array(16);
  // [[w]x v; 0 0], column-major.
  a[1] = z; a[2] = -y; a[4] = -z; a[6] = x; a[8] = y; a[9] = -x;
  a[12] = t.v[0]; a[13] = t.v[1]; a[14] = t.v[2];
  // (The series converges at the turn's pace: v enters each term once, so only the turn needs scaling down.)
  const k = Math.max(0, Math.ceil(Math.log2(Math.max(Math.hypot(x, y, z), 1e-300))) + 4);
  for (let i = 0; i < 16; i++) a[i]! /= 2 ** k;
  let sum: Float64Array = identity(), term: Float64Array = identity();
  for (let n = 1; n < 30; n++) {
    term = multiply(term, a).map((e) => e / n);
    sum = sum.map((e, i) => e + term[i]!);
  }
  for (let i = 0; i < k; i++) sum = multiply(sum, sum);
  return sum;
}

const identity = () => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
const far = (a: ArrayLike<number>, b: ArrayLike<number>) => Math.max(...Array.from(a, (x, i) => Math.abs(x - b[i]!)));

// Deterministic randomness (a linear congruential generator), so failures repeat.
let seed = 0;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const unit = (): Vec3 => {
  const v: Vec3 = [random() - 0.5, random() - 0.5, random() - 0.5];
  const n = Math.hypot(...v);
  return [v[0] / n, v[1] / n, v[2] / n];
};
const scaled = (v: Vec3, s: number): Vec3 => [v[0] * s, v[1] * s, v[2] * s];

// Angles over the whole range and at its hard places: 0, tiny, the series' switches, a right angle, near pi, pi.
const ANGLES = [0, 1e-12, 1e-8, 1e-6, 0.99e-6, 1.01e-6, 1e-4, 0.049, 0.051, 0.099, 0.101, 0.5, 1, Math.PI / 2 - 1e-9,
  Math.PI / 2 + 1e-9, 2, 3, Math.PI - 1e-4, Math.PI - 1e-8, Math.PI];

test('se3Exp: the matrix exponential, over angles and scales', () => {
  seed = 12345;
  for (const angle of ANGLES) for (const scale of [1e-3, 1, 1e4]) for (let i = 0; i < 20; i++) {
    const t: Twist = { w: scaled(unit(), angle), v: scaled(unit(), scale * random() * 3) };
    const tol = 1e-12 * Math.max(1, scale * 3);
    assert.ok(far(se3Exp(t), expm(t)) < tol, `angle ${angle}, scale ${scale}: ${far(se3Exp(t), expm(t))}`);
  }
});

test('so3Exp: a rotation, the same as se3Exp\'s', () => {
  seed = 12345;
  for (const angle of ANGLES) for (let i = 0; i < 20; i++) {
    const w = scaled(unit(), angle);
    const R = so3Exp(w), T = expm({ w, v: [0, 0, 0] });
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
      assert.ok(Math.abs(R[c * 3 + r]! - T[c * 4 + r]!) < 1e-13, `angle ${angle}`);
    }
  }
});

test('so3Log and se3Log: exp\'s inverses, the shortest turn, through 0 and pi', () => {
  seed = 12345;
  for (const angle of ANGLES) for (let i = 0; i < 20; i++) {
    const w = scaled(unit(), angle);
    const t: Twist = { w, v: scaled(unit(), random() * 50) };
    const T = expm(t);
    const back = se3Log(T);
    // exp(log(T)) = T always; log(exp(t)) = t short of pi (at pi, -w is as short).
    assert.ok(far(se3Exp(back), T) < 1e-11, `exp(log) at ${angle}: ${far(se3Exp(back), T)}`);
    if (angle < Math.PI - 1e-6) {
      assert.ok(far(back.w, w) < 1e-9 && far(back.v, t.v) < 1e-7, `log(exp) at ${angle}: ${JSON.stringify(back)}`);
    }
    assert.ok(Math.abs(Math.hypot(...back.w) - angle) < 1e-9, `the angle at ${angle}`);
    const R = new Float64Array(9);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) R[c * 3 + r] = T[c * 4 + r]!;
    assert.ok(far(so3Exp(so3Log(R)), R) < 1e-12, `so3 at ${angle}`);
  }
});

test('so3Log: past a right angle about each coordinate axis (the axis from its largest component)', () => {
  for (const k of [0, 1, 2]) for (const sign of [1, -1]) for (const angle of [2, 3, Math.PI - 1e-9]) {
    const w: Vec3 = [0, 0, 0];
    w[k] = sign * angle;
    const back = so3Log(so3Exp(w));
    assert.ok(far(back, w) < 1e-8, `axis ${k}, ${sign * angle}: ${JSON.stringify(back)}`);
  }
});

test('se3Log: past pi, the turn the other way', () => {
  seed = 12345;
  const u = unit();
  for (const angle of [3.5, 4, 2 * Math.PI - 0.1]) {
    const back = se3Log(expm({ w: scaled(u, angle), v: [1, 2, 3] }));
    assert.ok(far(back.w, scaled(u, angle - 2 * Math.PI)) < 1e-9, `${angle}: ${JSON.stringify(back.w)}`);
  }
});

test('invertPose and multiply', () => {
  seed = 12345;
  for (let i = 0; i < 20; i++) {
    // (A pose's rotation orthonormal to rounding, as invertPose assumes: the oracle's is only to 1e-13.)
    const T = se3Exp({ w: scaled(unit(), 3 * random()), v: scaled(unit(), 10) });
    assert.ok(far(multiply(T, invertPose(T)), identity()) < 1e-14 * 10 * 4);
    assert.ok(far(multiply(invertPose(T), T), identity()) < 1e-14 * 10 * 4);
  }
  const a = expm({ w: [0.1, 0.2, 0.3], v: [1, 0, 0] }), b = expm({ w: [0, 0, 1], v: [0, 2, 0] });
  // (Not commutative: the order matters.)
  assert.ok(far(multiply(a, b), multiply(b, a)) > 0.1);
});

test('screwMotion: the ends, an even pace along one helix', () => {
  seed = 12345;
  for (const angle of [0, 1e-7, 0.3, 2, Math.PI - 1e-3]) for (let i = 0; i < 10; i++) {
    const from = expm({ w: scaled(unit(), 2), v: scaled(unit(), 20) });
    const rel: Twist = { w: scaled(unit(), angle), v: scaled(unit(), 30 * random()) };
    const to = multiply(from, expm(rel));
    const m = screwMotion(from, to);
    assert.ok(far(m.at(0), from) < 1e-12 && far(m.at(1), to) < 1e-10,
      `the ends at ${angle}: ${far(m.at(0), from)} ${far(m.at(1), to)}`);
    assert.ok(far(screwInterpolate(from, to, 0.5), m.at(0.5)) < 1e-15);
    // Every step of a tenth is the same motion (in the moving frame).
    const step = multiply(invertPose(m.at(0)), m.at(0.1));
    for (let k = 1; k < 10; k++) {
      assert.ok(far(multiply(invertPose(m.at(k / 10)), m.at((k + 1) / 10)), step) < 1e-10, `step ${k} at ${angle}`);
    }
    // Half of it twice is all of it.
    const half = expm(scaleTwist(m.twist, 0.5));
    assert.ok(far(multiply(from, multiply(half, half)), to) < 1e-9);
  }
});

test('screwMotion: a turn about a fixed point keeps it; a translation goes straight', () => {
  seed = 12345;
  // About the point (5, 0, 0) of `from`'s frame, a quarter turn about Z.
  const from = expm({ w: [0.3, -0.2, 0.1], v: [1, 2, 3] });
  const about = (p: Vec3, w: Vec3): Twist => ({ w, v: scaled(cross(w, p), -1) });
  const to = multiply(from, expm(about([5, 0, 0], [0, 0, Math.PI / 2])));
  const m = screwMotion(from, to);
  const fixed = apply(from, [5, 0, 0]);
  for (const s of [0.1, 0.25, 0.5, 0.9]) assert.ok(far(apply(m.at(s), [5, 0, 0]), fixed) < 1e-12);
  const screw = screwOf(m.twist);
  assert.ok(Math.abs(screw.angle - Math.PI / 2) < 1e-12 && Math.abs(screw.pitch) < 1e-12 &&
    far(screw.point!, [5, 0, 0]) < 1e-12 && far(screw.direction, [0, 0, 1]) < 1e-12, JSON.stringify(screw));
  // A translation: the origin on the straight line, at an even pace; the turn the same throughout.
  const moved = multiply(from, expm({ w: [0, 0, 0], v: [3, 4, 0] }));
  const line = screwMotion(from, moved);
  for (const s of [0.2, 0.7]) {
    const p = apply(line.at(s), [0, 0, 0]), a = apply(from, [0, 0, 0]), b = apply(moved, [0, 0, 0]);
    assert.ok(far(p, a.map((x, i) => x + s * (b[i]! - x))) < 1e-12);
    assert.ok(far(line.at(s).slice(0, 12), from.slice(0, 12)) < 1e-15);
  }
  const t = screwOf(line.twist);
  assert.ok(t.angle === 0 && t.pitch === Infinity && Math.abs(t.slide - 5) < 1e-12 && far(t.direction, [0.6, 0.8, 0])
    < 1e-12 &&
    t.point === undefined, JSON.stringify(t));
  // A turn too small to place an axis: a translation.
  const tiny = screwOf({ w: [1e-14, 0, 0], v: [0, 2, 0] });
  assert.ok(tiny.angle === 0 && tiny.pitch === Infinity && tiny.point === undefined, JSON.stringify(tiny));
  const none = screwOf({ w: [0, 0, 0], v: [0, 0, 0] });
  assert.ok(Number.isNaN(none.pitch) && none.slide === 0 && far(none.direction, [0, 0, 0]) === 0);
});

test('screwOf: Chasles\' theorem, the axis, pitch and slide recovered', () => {
  seed = 12345;
  for (let i = 0; i < 30; i++) {
    const dir = unit(), point = scaled(unit(), 10 * random()), angle = 0.1 + 3 * random(), pitch = 4 * random() - 2;
    // A screw about the line through `point` along `dir`: turn by `angle`, slide pitch * angle.
    const twist: Twist = { w: scaled(dir, angle), v: [0, 1, 2].map((k) => -cross(scaled(dir, angle), point)[k]! +
      pitch * angle * dir[k]!) as Vec3 };
    const s = screwOf(twist);
    // The nearest point to the origin on that line.
    const nearest = point.map((x, k) => x - dot(point, dir) * dir[k]!);
    assert.ok(Math.abs(s.angle - angle) < 1e-12 && Math.abs(s.pitch - pitch) < 1e-12 && far(s.direction, dir) < 1e-12
      && far(s.point!, nearest) < 1e-10 && Math.abs(s.slide - pitch * angle) < 1e-12, JSON.stringify({ s, dir }));
    // Points on the axis slide along it, others keep their distance from it.
    const T = se3Exp(twist);
    const on = apply(T, point);
    assert.ok(far(on, point.map((x, k) => x + pitch * angle * dir[k]!)) < 1e-10);
  }
});

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
const apply = (T: ArrayLike<number>, p: Vec3): Vec3 => [0, 1, 2].map((r) => T[r]! * p[0] + T[4 + r]! * p[1] +
  T[8 + r]! * p[2] + T[12 + r]!) as Vec3;
