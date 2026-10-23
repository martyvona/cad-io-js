// 4×4 transform matrices, column-major in a Float64Array(16) as in three.js and glTF: element (row r, column c) is
// m[c * 4 + r], and a point x maps to m · [x, 1].

export type Mat4 = Float64Array;
export type Vec3 = [number, number, number];

export function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** The matrix with these columns: axes x, y, z (scaled as given) and origin o. */
export function fromAxes(x: Vec3, y: Vec3, z: Vec3, o: Vec3): Mat4 {
  return Float64Array.of(x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, o[0], o[1], o[2], 1);
}

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** The inverse of an affine matrix (last row 0 0 0 1), or undefined if it is singular. */
export function invertAffine(m: Mat4): Mat4 | undefined {
  // The 3×3 part by rows: [a b c; d e f; g h i].
  const a = m[0]!, b = m[4]!, c = m[8]!;
  const d = m[1]!, e = m[5]!, f = m[9]!;
  const g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return undefined;
  const s = 1 / det;
  // The inverse by rows, from the adjugate.
  const inv = [
    [A * s, (c * h - b * i) * s, (b * f - c * e) * s],
    [B * s, (a * i - c * g) * s, (c * d - a * f) * s],
    [C * s, (b * g - a * h) * s, (a * e - b * d) * s],
  ];
  const t = [m[12]!, m[13]!, m[14]!];
  const out = new Float64Array(16);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) out[col * 4 + r] = inv[r]![col]!;
    out[12 + r] = -(inv[r]![0]! * t[0]! + inv[r]![1]! * t[1]! + inv[r]![2]! * t[2]!);
  }
  out[15] = 1;
  return out;
}

export function scaling(s: number): Mat4 {
  const m = identity();
  m[0] = m[5] = m[10] = s;
  return m;
}

export function apply(m: Mat4, p: Vec3): Vec3 {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

export function isIdentity(m: Mat4, eps = 1e-12): boolean {
  const id = identity();
  return m.every((x, i) => Math.abs(x - id[i]!) <= eps);
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);

/** The unit vector along a, or undefined for a zero (or non-finite) vector. */
export function normalize(a: Vec3): Vec3 | undefined {
  const n = norm(a);
  return n > 0 && Number.isFinite(n) ? scale(a, 1 / n) : undefined;
}
