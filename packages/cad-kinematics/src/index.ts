// Rigid motions in 3D: the exponential and logarithm maps of SO(3) (rotations) and SE(3) (rotations with
// translations), and the screw motion between two poses (Chasles' theorem: any rigid displacement is a rotation about
// an axis with a translation along it), for interpolating poses along a helix.
//
// Conventions: matrices are column-major Float64Arrays (as cad-scene's), a rotation 3x3 (R[c * 3 + r]) and a pose 4x4
// (T[c * 4 + r], a rotation and a translation, its last row 0 0 0 1). A rotation vector `w` is the axis scaled by the
// angle in radians; a twist (w, v) is the angular part w and the linear part v, both scaled by the angle (exp of the
// 4x4 matrix [[w]x v; 0 0]), so exp(s * twist) moves a fraction s of the way. se3Log's angle is at most pi (the
// shortest turn); at exactly pi either direction is as short, and which comes back is unspecified.
//
// The closed forms (Rodrigues' formula and the left Jacobian of SO(3)) lose precision near angle 0 by cancellation;
// there their Taylor series are used, so exp and log are smooth through the identity. The logarithm takes the angle
// from atan2 (well conditioned everywhere) and, past a right angle, the axis from the rotation's symmetric part, as
// the antisymmetric part vanishes towards pi.

export type Vec3 = [number, number, number];

/** A twist: angular part `w` (a rotation vector) and linear part `v`, as exp(twist) takes them. */
export interface Twist { w: Vec3; v: Vec3 }

/** A screw's geometry (a twist's, in the frame its poses are expressed in). */
export interface Screw {
  /** The turn about the axis, radians (|w|; under 1e-12, 0: a pure translation, no axis to place). */
  angle: number;
  /** The axis's direction (unit); for a pure translation, the translation's (zero for none). */
  direction: Vec3;
  /** The translation along the axis per radian of turn (Infinity for a pure translation, NaN for none). */
  pitch: number;
  /** The axis's point nearest the origin (undefined for a pure translation or none). */
  point?: Vec3;
  /** The distance moved along the axis (the whole translation, for a pure translation). */
  slide: number;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: ArrayLike<number>, b: ArrayLike<number>): Vec3 => [a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];

/**
 * The coefficients of Rodrigues' formula and the left Jacobian for an angle t: a = sin t / t, b = (1 - cos t) / t^2,
 * c = (t - sin t) / t^3, each by its series where the closed form cancels.
 */
function coefficients(t: number): { a: number; b: number; c: number } {
  const t2 = t * t;
  const a = t < 1e-6 ? 1 - t2 / 6 : Math.sin(t) / t;
  // (2 sin^2(t/2) has no cancellation.)
  const h = Math.sin(t / 2);
  const b = t < 1e-6 ? 0.5 - t2 / 24 : 2 * h * h / t2;
  const c = t < 0.1 ? 1 / 6 - t2 * (1 / 120 - t2 * (1 / 5040 - t2 * (1 / 362880 - t2 / 39916800)))
    : (t - Math.sin(t)) / (t2 * t);
  return { a, b, c };
}

/** The rotation exp([w]x): by `w`'s length about its direction (Rodrigues' formula). */
export function so3Exp(w: ArrayLike<number>): Float64Array {
  const { a, b } = coefficients(Math.hypot(w[0]!, w[1]!, w[2]!));
  const R = new Float64Array(9);
  // R = I + a [w]x + b [w]x^2, [w]x^2 = w w^T - |w|^2 I.
  const t2 = dot(w, w);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) {
    R[c * 3 + r] = (r === c ? 1 - b * t2 : 0) + b * w[r]! * w[c]!;
  }
  R[1]! += a * w[2]!; R[3]! -= a * w[2]!;
  R[6]! += a * w[1]!; R[2]! -= a * w[1]!;
  R[5]! += a * w[0]!; R[7]! -= a * w[0]!;
  return R;
}

/** The rotation vector of a rotation matrix (angle in [0, pi]): so3Exp's inverse. */
export function so3Log(R: ArrayLike<number>): Vec3 {
  const at = (r: number, c: number) => R[c * 3 + r]!;
  const cos = (at(0, 0) + at(1, 1) + at(2, 2) - 1) / 2;
  // sin t times the axis.
  const s: Vec3 = [(at(2, 1) - at(1, 2)) / 2, (at(0, 2) - at(2, 0)) / 2, (at(1, 0) - at(0, 1)) / 2];
  const sin = Math.hypot(...s);
  const t = Math.atan2(sin, cos);
  if (cos > 0) {
    const f = t < 1e-6 ? 1 + t * t / 6 : t / sin;
    return [s[0] * f, s[1] * f, s[2] * f];
  }
  // Past a right angle: u u^T = (sym(R) - I) / (1 - cos t) + I, from its largest diagonal entry.
  const k = 1 - cos;
  const m = (r: number, c: number) => ((at(r, c) + at(c, r)) / 2 - (r === c ? 1 : 0)) / k + (r === c ? 1 : 0);
  const i = [0, 1, 2].reduce((x, y) => (m(y, y) > m(x, x) ? y : x), 0);
  const ui = Math.sqrt(Math.max(0, m(i, i)));
  const u: Vec3 = [0, 0, 0];
  for (let j = 0; j < 3; j++) u[j] = j === i ? ui : m(i, j) / ui;
  // (The sign from the antisymmetric part, which still says it short of pi.)
  const sign = dot(u, s) < 0 ? -1 : 1;
  const n = Math.hypot(...u);
  return [sign * t * u[0] / n, sign * t * u[1] / n, sign * t * u[2] / n];
}

/** The pose exp(twist). */
export function se3Exp(twist: Twist): Float64Array {
  const { w, v } = twist;
  const R = so3Exp(w);
  const { b, c } = coefficients(Math.hypot(...w));
  // p = (I + b [w]x + c [w]x^2) v.
  const wv = cross(w, v), wwv = cross(w, wv);
  const T = new Float64Array(16);
  for (let k = 0; k < 3; k++) {
    for (let r = 0; r < 3; r++) T[k * 4 + r] = R[k * 3 + r]!;
    T[12 + k] = v[k]! + b * wv[k]! + c * wwv[k]!;
  }
  T[15] = 1;
  return T;
}

/** The twist of a pose (its angle in [0, pi]): se3Exp's inverse. */
export function se3Log(T: ArrayLike<number>): Twist {
  const R = new Float64Array(9);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) R[c * 3 + r] = T[c * 4 + r]!;
  const w = so3Log(R);
  const t = Math.hypot(...w), t2 = t * t;
  // v = (I - [w]x / 2 + d [w]x^2) p, d = (1 - (t/2) cot(t/2)) / t^2.
  const d = t < 0.05 ? 1 / 12 + t2 * (1 / 720 + t2 * (1 / 30240 + t2 / 1209600))
    : (1 - (t / 2) / Math.tan(t / 2)) / t2;
  const p: Vec3 = [T[12]!, T[13]!, T[14]!];
  const wp = cross(w, p), wwp = cross(w, wp);
  return { w, v: [p[0] - wp[0] / 2 + d * wwp[0], p[1] - wp[1] / 2 + d * wwp[1], p[2] - wp[2] / 2 + d * wwp[2]] };
}

/** a b (4x4). */
export function multiply(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    let x = 0;
    for (let k = 0; k < 4; k++) x += a[k * 4 + r]! * b[c * 4 + k]!;
    out[c * 4 + r] = x;
  }
  return out;
}

/** A pose's inverse (a rigid motion: the rotation transposed). */
export function invertPose(T: ArrayLike<number>): Float64Array {
  const out = new Float64Array(16);
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] = T[r * 4 + c]!;
  for (let r = 0; r < 3; r++) out[12 + r] = -(out[r]! * T[12]! + out[4 + r]! * T[13]! + out[8 + r]! * T[14]!);
  out[15] = 1;
  return out;
}

/** A twist scaled by s. */
export function scaleTwist(t: Twist, s: number): Twist {
  return { w: [t.w[0] * s, t.w[1] * s, t.w[2] * s], v: [t.v[0] * s, t.v[1] * s, t.v[2] * s] };
}

/**
 * The screw motion from pose `from` to pose `to`: the twist taking one to the other in `from`'s own frame
 * (log(from^-1 to)), and the pose a fraction s of the way along it, from exp(s twist): from at 0, to at 1, each point
 * moving on a helix about one axis at an even pace (the shortest turn: at most pi).
 */
export function screwMotion(from: ArrayLike<number>, to: ArrayLike<number>): { twist: Twist;
  at(s: number): Float64Array } {
  const start = Float64Array.from(from);
  const twist = se3Log(multiply(invertPose(start), to));
  return { twist, at: (s) => multiply(start, se3Exp(scaleTwist(twist, s))) };
}

/** The pose a fraction s of the way from `from` to `to` along their screw motion (screwMotion). */
export function screwInterpolate(from: ArrayLike<number>, to: ArrayLike<number>, s: number): Float64Array {
  return screwMotion(from, to).at(s);
}

/** A twist's screw: its axis, angle, pitch and slide along the axis (Chasles' theorem). */
export function screwOf(twist: Twist): Screw {
  const { w, v } = twist;
  const angle = Math.hypot(...w);
  if (angle < 1e-12) {
    const slide = Math.hypot(...v);
    return { angle: 0, direction: slide ? [v[0] / slide, v[1] / slide, v[2] / slide] : [0, 0, 0],
      pitch: slide ? Infinity : NaN, slide };
  }
  const direction: Vec3 = [w[0] / angle, w[1] / angle, w[2] / angle];
  const slide = dot(direction, v);
  const q = cross(w, v);
  return { angle, direction, pitch: slide / angle,
    point: [q[0] / (angle * angle), q[1] / (angle * angle), q[2] / (angle * angle)], slide };
}
