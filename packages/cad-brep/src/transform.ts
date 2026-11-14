// Baking a similarity into rows (plain objects, types.ts), kind by kind as docs/brep-reference.md ("Transforms")
// states: every curve keeps its parameter and every surface its (u, v) up to a signed factor per coordinate, so ranges
// and trim parameters never change and p-curves take their surface's map. References between rows are left to the
// caller (the copier, copy.ts): these functions map one row's own numbers.

import type { Curve, Placement, Point, Surface, Transform } from './types.ts';

/** A similarity p -> s Q p + t, Q orthogonal: `m` = s Q, column-major. */
export interface Similarity {
  m: number[];
  t: number[];
  s: number;
  /** det Q: -1 for a mirror. */
  det: 1 | -1;
}

/** Within this of orthogonal (relative), a transform's linear part is a similarity. */
export const SIMILARITY_TOLERANCE = 1e-9;

/** A transform (12 numbers, column-major: x, y, z, translation) as a similarity, or undefined if it isn't one. */
export function similarity(tr: Transform): Similarity | undefined {
  const m = tr.slice(0, 9), t = tr.slice(9, 12);
  const col = (j: number) => m.slice(3 * j, 3 * j + 3);
  const dot = (a: number[], b: number[]) => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const c = [col(0), col(1), col(2)];
  const s2 = dot(c[0]!, c[0]!);
  if (!(s2 > 0) || !Number.isFinite(s2) || !t.every(Number.isFinite)) return undefined;
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const want = i === j ? s2 : 0;
      if (Math.abs(dot(c[i]!, c[j]!) - want) > SIMILARITY_TOLERANCE * s2) return undefined;
    }
  }
  const [a, b, d] = c as [number[], number[], number[]];
  const det = a[0]! * (b[1]! * d[2]! - b[2]! * d[1]!) - b[0]! * (a[1]! * d[2]! - a[2]! * d[1]!)
    + d[0]! * (a[1]! * b[2]! - a[2]! * b[1]!);
  return { m, t, s: Math.sqrt(s2), det: det < 0 ? -1 : 1 };
}

/** `outer` after `inner`: inner's transform first, then outer's. */
export function compose(outer: Similarity, inner: Similarity): Similarity {
  const m = Array<number>(9).fill(0);
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      let x = 0;
      for (let k = 0; k < 3; k++) x += outer.m[3 * k + i]! * inner.m[3 * j + k]!;
      m[3 * j + i] = x;
    }
  }
  return { m, t: point(outer, inner.t), s: outer.s * inner.s, det: (outer.det * inner.det) as 1 | -1 };
}

export const IDENTITY: Similarity = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0], s: 1, det: 1 };

export function isIdentity(T: Similarity): boolean {
  return T.m.every((x, k) => x === IDENTITY.m[k]) && T.t.every((x) => x === 0);
}

const linear = (T: Similarity, p: Point) => [0, 1, 2].map((i) =>
  T.m[i]! * p[0]! + T.m[3 + i]! * p[1]! + T.m[6 + i]! * p[2]!);

/** A point. */
export function point(T: Similarity, p: Point): Point {
  const q = linear(T, p);
  return [q[0]! + T.t[0]!, q[1]! + T.t[1]!, q[2]! + T.t[2]!];
}

/** A direction (unit in, unit out: Q d). */
export function direction(T: Similarity, d: Point): Point {
  return linear(T, d).map((x) => x / T.s);
}

/** A 3D placement: x and the origin mapped, the axis too but turned over under a mirror, so y maps to y. */
export function placement(T: Similarity, p: Placement): Placement {
  const axis = direction(T, p.axis!);
  return { origin: point(T, p.origin), axis: T.det < 0 ? axis.map((x) => -x) : axis, xDir: direction(T, p.xDir) };
}

/** A 3D curve's own numbers (its references kept). */
export function curve3(T: Similarity, c: Curve): Curve {
  const s = T.s;
  switch (c.kind) {
    case 'line': return { ...c, point: point(T, c.point), direction: direction(T, c.direction),
      magnitude: c.magnitude * s };
    case 'circle': return { ...c, position: placement(T, c.position), radius: c.radius * s };
    case 'ellipse': return { ...c, position: placement(T, c.position), semiAxis1: c.semiAxis1 * s,
      semiAxis2: c.semiAxis2 * s };
    case 'hyperbola': return { ...c, position: placement(T, c.position), semiAxis: c.semiAxis * s,
      semiImagAxis: c.semiImagAxis * s };
    case 'parabola': return { ...c, position: placement(T, c.position), focalDist: c.focalDist * s };
    case 'bspline': return { ...c, poles: c.poles.map((p) => point(T, p)) };
    case 'polyline': return { ...c, points: c.points.map((p) => point(T, p)) };
    case 'trimmed': {
      const trim = (x: { parameter?: number; point?: Point }) => x.point ? { ...x, point: point(T, x.point) } : x;
      return { ...c, trim1: trim(c.trim1), trim2: trim(c.trim2) };
    }
    case 'composite': return c;
    case 'offset': return { ...c, distance: c.distance * s * T.det, refDirection: direction(T, c.refDirection!) };
  }
}

/** A surface's (u, v) map: each coordinate times its factor (negative where a mirror reverses it). */
export type ParamMap = [number, number];
export const NO_MAP: ParamMap = [1, 1];

/**
 * A surface's own numbers, its (u, v) map, and sigma: -1 where its own normal ends up against the mapped one (a face
 * on it turns its sameSense). `basis` is the baked basis's (offsets, rectangular trims), undefined otherwise.
 * Undefined: a swept surface under a mirror (its profile's frame changes hands).
 */
export function surface(T: Similarity, x: Surface, basis?: { map: ParamMap; sigma: number }):
  { surface: Surface; map: ParamMap; sigma: number } | undefined {
  const s = T.s, det = T.det;
  switch (x.kind) {
    case 'plane': return { surface: { ...x, position: placement(T, x.position) }, map: [s, s], sigma: det };
    case 'cylinder': return { surface: { ...x, position: placement(T, x.position), radius: x.radius * s },
      map: [1, s * det], sigma: 1 };
    case 'cone': return { surface: { ...x, position: placement(T, x.position), radius: x.radius * s,
      semiAngle: x.semiAngle * det }, map: [1, s * det], sigma: 1 };
    case 'sphere': return { surface: { ...x, position: placement(T, x.position), radius: x.radius * s },
      map: [1, det], sigma: 1 };
    case 'torus': return { surface: { ...x, position: placement(T, x.position), majorRadius: x.majorRadius * s,
      minorRadius: x.minorRadius * s }, map: [1, det], sigma: 1 };
    case 'bspline': return { surface: { ...x, poles: x.poles.map((r) => r.map((p) => point(T, p))) }, map: NO_MAP,
      sigma: det };
    case 'extrusion': return { surface: { ...x, direction: direction(T, x.direction), magnitude: x.magnitude * s },
      map: NO_MAP, sigma: det };
    case 'revolution': {
      const a = direction(T, x.axisDirection);
      return { surface: { ...x, axisOrigin: point(T, x.axisOrigin), axisDirection: det < 0 ? a.map((v) => -v) : a },
        map: NO_MAP, sigma: det };
    }
    case 'offset': return { surface: { ...x, distance: x.distance * s * basis!.sigma }, map: basis!.map,
      sigma: basis!.sigma };
    case 'rectangularTrimmed': {
      const [fu, fv] = basis!.map;
      return { surface: { ...x, u1: x.u1 * fu, u2: x.u2 * fu, v1: x.v1 * fv, v2: x.v2 * fv }, map: basis!.map,
        sigma: basis!.sigma };
    }
    case 'curveSwept': return det < 0 ? undefined : { surface: x, map: NO_MAP, sigma: 1 };
    case 'fixedReferenceSwept': return det < 0 ? undefined : { surface: { ...x,
      fixedReference: direction(T, x.fixedReference) }, map: NO_MAP, sigma: 1 };
  }
}

/** The similarity a swept surface's profile takes: held in its moving frame, it scales about the frame's origin. */
export function profileOf(T: Similarity): Similarity {
  return { m: [T.s, 0, 0, 0, T.s, 0, 0, 0, T.s], t: [0, 0, 0], s: T.s, det: 1 };
}

/**
 * A 2D curve's own numbers under a (u, v) map (its references kept), or a reason it has no exact form: a conic or a 2D
 * offset where the map isn't uniform, a conic where it reverses orientation.
 */
export function curve2(map: ParamMap, c: Curve): Curve | string {
  const [fu, fv] = map;
  if (fu === 1 && fv === 1) return c;
  const p2 = (p: Point) => [p[0]! * fu, p[1]! * fv];
  const uniform = Math.abs(fu) === Math.abs(fv), keeps = fu * fv > 0;
  switch (c.kind) {
    case 'line': {
      const d = p2(c.direction), n = Math.hypot(d[0]!, d[1]!);
      return { ...c, point: p2(c.point), direction: [d[0]! / n, d[1]! / n], magnitude: c.magnitude * n };
    }
    case 'circle': case 'ellipse': case 'hyperbola': case 'parabola': {
      if (!uniform) return 'a conic in (u, v) under an unequal scale';
      if (!keeps) return 'a conic in (u, v) that a mirror would run the other way round';
      const f = Math.abs(fu), sign = Math.sign(fu);
      const position = { origin: p2(c.position.origin), xDir: c.position.xDir.map((x) => x * sign) };
      if (c.kind === 'circle') return { ...c, position, radius: c.radius * f };
      if (c.kind === 'ellipse') return { ...c, position, semiAxis1: c.semiAxis1 * f, semiAxis2: c.semiAxis2 * f };
      if (c.kind === 'hyperbola') return { ...c, position, semiAxis: c.semiAxis * f, semiImagAxis: c.semiImagAxis * f };
      return { ...c, position, focalDist: c.focalDist * f };
    }
    case 'bspline': return { ...c, poles: c.poles.map(p2) };
    case 'polyline': return { ...c, points: c.points.map(p2) };
    case 'trimmed': {
      const trim = (x: { parameter?: number; point?: Point }) => x.point ? { ...x, point: p2(x.point) } : x;
      return { ...c, trim1: trim(c.trim1), trim2: trim(c.trim2) };
    }
    case 'composite': return c;
    case 'offset':
      // (The offset is to the right of the tangent: a map reversing orientation puts it on the left.)
      if (!uniform) return 'a 2D offset curve under an unequal scale';
      return { ...c, distance: c.distance * Math.abs(fu) * (keeps ? 1 : -1) };
  }
}
