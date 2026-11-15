// Vector arithmetic for the reference shapes, and the similarities their variants are built at. Written apart from
// src/ (geometry.ts, transform.ts) so the facts don't share code with what they check.

export type V = number[];

export const add = (a: V, b: V): V => a.map((x, k) => x + b[k]!);
export const sub = (a: V, b: V): V => a.map((x, k) => x - b[k]!);
export const mul = (a: V, k: number): V => a.map((x) => x * k);
export const dot = (a: V, b: V): number => a.reduce((s, x, k) => s + x * b[k]!, 0);
export const cross = (a: V, b: V): V => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!];
export const norm = (a: V): number => Math.hypot(...a);
export const unit = (a: V): V => mul(a, 1 / norm(a));
/** Sum of scaled vectors: lin([k1, a1], [k2, a2], ...). */
export const lin = (...terms: [number, V][]): V => terms.reduce((s, [k, a]) => add(s, mul(a, k)),
  terms[0]![1].map(() => 0));
/** No -0 (JSON has none, so a fixture read back would differ). */
export const clean = (a: V): V => a.map((x) => x + 0);

/**
 * A similarity T(p) = s Q p + t: Q orthogonal (a rotation, or a mirror when det Q = -1), as its three columns, s > 0.
 */
export interface Similarity {
  s: number;
  q: [V, V, V];
  t: V;
}

export const IDENTITY: Similarity = { s: 1, q: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] };

export const det = (T: Similarity): number => dot(cross(T.q[0], T.q[1]), T.q[2]);
/** Q d: a direction. */
export const rotate = (T: Similarity, d: V): V => lin([d[0]!, T.q[0]], [d[1]!, T.q[1]], [d[2]!, T.q[2]]);
/** s Q d: a derivative. */
export const linear = (T: Similarity, d: V): V => mul(rotate(T, d), T.s);
export const apply = (T: Similarity, p: V): V => add(linear(T, p), T.t);

/** The rotation by `angle` about the unit `axis` (Rodrigues), as columns. */
export function rotation(axis: V, angle: number): [V, V, V] {
  const a = unit(axis), c = Math.cos(angle), s = Math.sin(angle);
  const col = (e: V) => lin([c, e], [s, cross(a, e)], [(1 - c) * dot(a, e), a]);
  return [col([1, 0, 0]), col([0, 1, 0]), col([0, 0, 1])];
}

/** The columns of A B. */
export function compose(a: [V, V, V], b: [V, V, V]): [V, V, V] {
  const at = (d: V) => lin([d[0]!, a[0]], [d[1]!, a[1]], [d[2]!, a[2]]);
  return [at(b[0]), at(b[1]), at(b[2])];
}

/** The variants every shape is built at: name and similarity. */
export const VARIANTS: { name: string; T: Similarity }[] = [
  { name: 's1', T: IDENTITY },
  { name: 's1e-3', T: { ...IDENTITY, s: 1e-3 } },
  { name: 's1e3', T: { ...IDENTITY, s: 1e3 } },
  { name: 's1e6', T: { ...IDENTITY, s: 1e6 } },
  { name: 'far', T: { ...IDENTITY, t: [1e6, -1e6, 1e6] } },
  // Turned 0.7 rad about (1, 2, 3) and moved.
  { name: 'moved', T: { s: 1, q: rotation([1, 2, 3], 0.7), t: [12.5, -7.25, 3] } },
  // The mirror in the plane x = 0, then turned 0.4 rad about (0, 1, 1) and moved: det Q = -1.
  { name: 'mirror', T: { s: 1, q: compose(rotation([0, 1, 1], 0.4), [[-1, 0, 0], [0, 1, 0], [0, 0, 1]]),
    t: [-3, 4, 5.5] } },
];
