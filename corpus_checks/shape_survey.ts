// The mesh survey beside coverage_corpus.ts: over the faces every backend meshes, each backend's triangles' shapes
// in 3D (smallest angle, aspect), its triangles per face against SMLib's, each face's worst sampled deviation from
// its surface, and its triangles against the profile's angle by the surface's normals at their corners. Tallies are
// numbers and fixed-length number arrays, so runner.ts's addInto sums them across children.
import type { TessellationResult } from '../packages/cad-scene/src/index.ts';

/** Smallest angle in degrees, in ANGLE_STEP bins over [0, 60] (an equilateral's 60 the last). */
export const ANGLE_STEP = 0.5;
export const ANGLE_BINS = 60 / ANGLE_STEP + 1;
/**
 * Aspect, the longest side squared over twice the area (2 / sqrt 3 for an equilateral, 2 for a right isosceles, ever
 * larger for needles and caps), in ASPECT_PER_DECADE bins per decade from 1, the last bin everything from 1e6 (a
 * triangle of no area included).
 */
export const ASPECT_PER_DECADE = 20;
export const ASPECT_BINS = 6 * ASPECT_PER_DECADE + 1;
/** A backend's triangles per face over SMLib's, log2 in half steps over [-6, 6] (the ends taking all beyond). */
export const RATIO_BINS = 25;
/** A face's worst sampled deviation over the deflection, by upper bound (the last unbounded). */
export const DEVIATION_BOUNDS = [0.25, 0.5, 0.75, 1, 1.1, 1.25, 1.5, 2, 5, 10, Infinity];
/** The triangles sampled per face for its deviation: all of a face's, or its DEVIATION_TRIANGLES largest by area. */
export const DEVIATION_TRIANGLES = 64;

export const angleBin = (deg: number) => Math.min(ANGLE_BINS - 1, Math.max(0, Math.floor(deg / ANGLE_STEP)));
export const aspectBin = (a: number) => !(a < Infinity) ? ASPECT_BINS - 1
  : Math.min(ASPECT_BINS - 1, Math.max(0, Math.floor(Math.log10(Math.max(1, a)) * ASPECT_PER_DECADE)));
export const ratioBin = (n: number, ref: number) => {
  if (ref === 0) return RATIO_BINS - 1;
  if (n === 0) return 0;
  return Math.min(RATIO_BINS - 1, Math.max(0, Math.round(2 * Math.log2(n / ref)) + 12));
};
export const deviationBin = (r: number) => DEVIATION_BOUNDS.findIndex((b) => r <= b);

/** A triangle's smallest angle (degrees) and aspect; a triangle of no area has angle 0 and aspect Infinity. */
export function triangleShape(p: ArrayLike<number>, a: number, b: number, c: number):
  { angle: number; aspect: number } {
  const d = (i: number, j: number) => {
    const x = p[3 * i]! - p[3 * j]!, y = p[3 * i + 1]! - p[3 * j + 1]!, z = p[3 * i + 2]! - p[3 * j + 2]!;
    return x * x + y * y + z * z;
  };
  const ab = d(a, b), bc = d(b, c), ca = d(c, a);
  const ux = p[3 * b]! - p[3 * a]!, uy = p[3 * b + 1]! - p[3 * a + 1]!, uz = p[3 * b + 2]! - p[3 * a + 2]!;
  const vx = p[3 * c]! - p[3 * a]!, vy = p[3 * c + 1]! - p[3 * a + 1]!, vz = p[3 * c + 2]! - p[3 * a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const twice = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const longest = Math.max(ab, bc, ca);
  if (!(twice > 0) || !(longest > 0)) return { angle: 0, aspect: Infinity };
  // The smallest angle is opposite the shortest side: sin = twice the area over the product of the other two.
  const s = Math.sqrt(Math.min(ab, bc, ca));
  const others = Math.sqrt(ab * bc * ca) / s;
  const angle = Math.asin(Math.min(1, twice / others)) * 180 / Math.PI;
  return { angle, aspect: longest / twice };
}

export interface Shapes {
  /** Triangles by smallest angle and by aspect (bins above). */
  angle: number[];
  aspect: number[];
  /** Faces by their worst triangle's smallest angle and aspect. */
  faceAngle: number[];
  faceAspect: number[];
  triangles: number;
  faces: number;
}
export const freshShapes = (): Shapes => ({
  angle: Array(ANGLE_BINS).fill(0), aspect: Array(ASPECT_BINS).fill(0), faceAngle: Array(ANGLE_BINS).fill(0),
  faceAspect: Array(ASPECT_BINS).fill(0), triangles: 0, faces: 0,
});

/** Each face's triangles (as indices into r.indices, 3 each) by face id; a face of several ranges joined. */
export function faceTriangles(r: TessellationResult): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const f of r.faces) {
    if (f.entityId === null || f.count === 0) continue;
    let t = out.get(f.entityId);
    if (!t) out.set(f.entityId, t = []);
    for (let k = f.start; k < f.start + f.count; k += 3) t.push(k);
  }
  return out;
}

/** The faces in `ids` into `into`: their triangles' shapes, and each face's worst. */
export function addShapes(r: TessellationResult, tris: Map<number, number[]>, ids: Iterable<number>, into: Shapes) {
  for (const id of ids) {
    const ts = tris.get(id);
    if (!ts) continue;
    let worstAngle = 60, worstAspect = 0;
    for (const k of ts) {
      const s = triangleShape(r.positions, r.indices[k]!, r.indices[k + 1]!, r.indices[k + 2]!);
      into.angle[angleBin(s.angle)]!++;
      into.aspect[aspectBin(s.aspect)]!++;
      worstAngle = Math.min(worstAngle, s.angle);
      worstAspect = Math.max(worstAspect, s.aspect);
    }
    into.faceAngle[angleBin(worstAngle)]!++;
    into.faceAspect[aspectBin(worstAspect)]!++;
    into.triangles += ts.length;
    into.faces++;
  }
}

/** What deviation sampling and the normals' check need of cad-geom's Geometry (a stand-in in tests). */
export interface Inverter {
  surfaceInfo(row: number): { status: string; u: [number, number]; v: [number, number] };
  /** params (u, v per point) and flags (4: at a singularity) are read by faceAngles only. */
  invertSurface(row: number, points: ArrayLike<number>, box: ArrayLike<number>, tol: number):
    { status: string; distance: Float64Array; statuses: Uint8Array; params: Float64Array; flags: Uint8Array };
  surfaceNormal(row: number, uv: ArrayLike<number>): { status: string; values: Float64Array; statuses: Uint8Array };
}
/** cad-geom's inversion flag for a foot at a pole or apex. */
export const AT_SINGULARITY = 4;

/**
 * A face's worst sampled deviation from surface row `surface`: the centroid and the sides' middles of its triangles
 * (all, or its DEVIATION_TRIANGLES largest), inverted onto the surface over its whole domain within `tol`; points
 * not inverted are left out. NaN where none was; `points` the count inverted. A lower bound on the face's true worst
 * (only these points), and the distance is to the untrimmed surface, which can only understate it.
 */
export function faceDeviation(g: Inverter, surface: number, r: TessellationResult, ts: readonly number[], tol: number):
  { worst: number; points: number } {
  const info = g.surfaceInfo(surface);
  if (info.status !== 'ok') return { worst: NaN, points: 0 };
  const p = r.positions, o = r.origin;
  let pick = ts;
  if (ts.length > DEVIATION_TRIANGLES) {
    const area = (k: number) => triangleArea(p, r.indices[k]!, r.indices[k + 1]!, r.indices[k + 2]!);
    pick = ts.map((k) => ({ k, a: area(k) })).sort((x, y) => y.a - x.a || x.k - y.k).slice(0, DEVIATION_TRIANGLES)
      .map((x) => x.k);
  }
  const pts = new Float64Array(pick.length * 12);
  let n = 0;
  for (const k of pick) {
    const i = r.indices[k]!, j = r.indices[k + 1]!, l = r.indices[k + 2]!;
    for (const [w0, w1, w2] of [[1 / 3, 1 / 3, 1 / 3], [0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]] as const) {
      for (let c = 0; c < 3; c++) pts[n++] = o[c]! + w0 * p[3 * i + c]! + w1 * p[3 * j + c]! + w2 * p[3 * l + c]!;
    }
  }
  const inv = g.invertSurface(surface, pts, [info.u[0], info.u[1], info.v[0], info.v[1]], tol);
  let worst = NaN, points = 0;
  for (let q = 0; q < pts.length / 3; q++) {
    if (inv.statuses[q] !== 0 || !Number.isFinite(inv.distance[q]!)) continue;
    points++;
    worst = Number.isNaN(worst) ? inv.distance[q]! : Math.max(worst, inv.distance[q]!);
  }
  return { worst, points };
}

/** A face's worst triangle's excess over the angle limit, in degrees, by upper bound (the last unbounded). */
export const EXCESS_BOUNDS = [1, 2, 5, 10, 15, 30, 60, 90, Infinity];
/** A face's share of its mesh area in triangles past the limit, by upper bound. */
export const AREA_BOUNDS = [0.001, 0.01, 0.05, 0.1, 0.25, 0.5, 1];
export const excessBin = (deg: number) => EXCESS_BOUNDS.findIndex((b) => deg <= b);
export const areaBin = (f: number) => AREA_BOUNDS.findIndex((b) => f <= b);

/** The angle between two vectors in degrees, by atan2 (sound near 0 and 180); NaN where either is zero. */
export function angleBetween(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const cx = a[1]! * b[2]! - a[2]! * b[1]!, cy = a[2]! * b[0]! - a[0]! * b[2]!, cz = a[0]! * b[1]! - a[1]! * b[0]!;
  const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const cross = Math.sqrt(cx * cx + cy * cy + cz * cz);
  if (!(cross > 0) && dot === 0) return NaN;
  return Math.atan2(cross, dot) * 180 / Math.PI;
}

export interface FaceAngles {
  /** Triangles: all of the face's, past the limit, with a corner at a pole or apex (or no normal there), with a
   * corner not inverted; the last two not judged. */
  triangles: number;
  missed: number;
  excluded: number;
  unmeasured: number;
  /** Of those past the limit, the ones past it by their corners' spread alone (the rest by their facet). */
  spread: number;
  /** The judged triangles' worst angle in degrees (0 where none was judged). */
  worst: number;
  /** Mesh areas of the same. */
  area: number;
  missedArea: number;
  spreadArea: number;
  excludedArea: number;
  unmeasuredArea: number;
}

/**
 * Each triangle of a face (triangles `ts`, indices into r.indices) against the angle limit `limit` (degrees), from
 * surface row `surface`'s unit normals at its corners' feet (each vertex inverted over the surface's whole domain
 * within `tol`): its angle is the most its corners' normals spread (pairwise), or its facet's normal turns from a
 * corner's, whichever is more; past `limit` it misses. The facet's normal is taken on the side the face's triangles
 * mostly face (area-weighted against their corners' normals), so a triangle folded against the rest shows near
 * 180 degrees whichever way the backend winds the face; a triangle of no area is judged by its corners alone.
 * Triangles with a corner whose foot is at a singularity (or whose normal can't be had) are left out, as are those
 * with a corner not inverted. `each`, if given, gets each judged triangle's angle.
 */
export function faceAngles(g: Inverter, surface: number, r: TessellationResult, ts: readonly number[], tol: number,
  limit: number, each?: (k: number, deg: number) => void): FaceAngles {
  const out: FaceAngles = { triangles: ts.length, missed: 0, excluded: 0, unmeasured: 0, spread: 0, worst: 0, area: 0,
    missedArea: 0, spreadArea: 0, excludedArea: 0, unmeasuredArea: 0 };
  const p = r.positions, o = r.origin, ix = r.indices;
  for (const k of ts) out.area += triangleArea(p, ix[k]!, ix[k + 1]!, ix[k + 2]!);
  const info = g.surfaceInfo(surface);
  if (info.status !== 'ok') {
    out.unmeasured = ts.length, out.unmeasuredArea = out.area;
    return out;
  }
  const slot = new Map<number, number>();
  for (const k of ts) for (let c = 0; c < 3; c++) if (!slot.has(ix[k + c]!)) slot.set(ix[k + c]!, slot.size);
  const pts = new Float64Array(3 * slot.size);
  for (const [v, s] of slot) for (let c = 0; c < 3; c++) pts[3 * s + c] = o[c]! + p[3 * v + c]!;
  const inv = g.invertSurface(surface, pts, [info.u[0], info.u[1], info.v[0], info.v[1]], tol);
  // Per vertex: 0 judged, 1 singular, 2 not inverted; normals where judged.
  const state = new Uint8Array(slot.size);
  for (let s = 0; s < slot.size; s++) {
    state[s] = inv.statuses[s] !== 0 || !Number.isFinite(inv.params[2 * s]!) || !Number.isFinite(inv.params[2 * s + 1]!)
      ? 2 : inv.flags[s]! & AT_SINGULARITY ? 1 : 0;
  }
  const nrm = g.surfaceNormal(surface, inv.params);
  const normal = new Float64Array(3 * slot.size);
  for (let s = 0; s < slot.size; s++) {
    if (state[s] !== 0) continue;
    const v = nrm.values.subarray(3 * s, 3 * s + 3);
    if (nrm.status !== 'ok' || nrm.statuses[s] !== 0 || !(Math.hypot(v[0]!, v[1]!, v[2]!) > 0.5)) state[s] = 1;
    else normal.set(v, 3 * s);
  }
  const corners = (k: number) => [0, 1, 2].map((c) => slot.get(ix[k + c]!)!);
  const facet = (k: number) => {
    const a = ix[k]!, b = ix[k + 1]!, c = ix[k + 2]!;
    const ux = p[3 * b]! - p[3 * a]!, uy = p[3 * b + 1]! - p[3 * a + 1]!, uz = p[3 * b + 2]! - p[3 * a + 2]!;
    const vx = p[3 * c]! - p[3 * a]!, vy = p[3 * c + 1]! - p[3 * a + 1]!, vz = p[3 * c + 2]! - p[3 * a + 2]!;
    return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
  };
  const judged: number[] = [];
  let side = 0;
  for (const k of ts) {
    const cs = corners(k), a = triangleArea(p, ix[k]!, ix[k + 1]!, ix[k + 2]!);
    if (cs.some((s) => state[s] === 1)) out.excluded++, out.excludedArea += a;
    else if (cs.some((s) => state[s] === 2)) out.unmeasured++, out.unmeasuredArea += a;
    else {
      judged.push(k);
      const f = facet(k);
      for (const s of cs) side += f[0]! * normal[3 * s]! + f[1]! * normal[3 * s + 1]! + f[2]! * normal[3 * s + 2]!;
    }
  }
  const sign = side < 0 ? -1 : 1;
  for (const k of judged) {
    const cs = corners(k), n = cs.map((s) => normal.subarray(3 * s, 3 * s + 3));
    const spread = Math.max(angleBetween(n[0]!, n[1]!), angleBetween(n[1]!, n[2]!), angleBetween(n[2]!, n[0]!));
    let deg = spread;
    const f = facet(k).map((x) => sign * x);
    if (Math.hypot(f[0]!, f[1]!, f[2]!) > 0) for (const m of n) deg = Math.max(deg, angleBetween(f, m));
    each?.(k, deg);
    out.worst = Math.max(out.worst, deg);
    if (deg <= limit) continue;
    const a = triangleArea(p, ix[k]!, ix[k + 1]!, ix[k + 2]!);
    out.missed++, out.missedArea += a;
    if (spread > limit) out.spread++, out.spreadArea += a;
  }
  return out;
}

/** The normals' check's tallies over a set of faces (faceAngles' results, summed by addAngles). */
export const freshAngles = () => ({
  faces: 0, facesMissed: 0, facesSpread: 0, facesExcluded: 0, triangles: 0, missed: 0, spread: 0, excluded: 0,
  unmeasured: 0, area: 0, missedArea: 0, spreadArea: 0, excludedArea: 0, unmeasuredArea: 0,
  // Faces past the limit by their worst triangle's excess over it, and by their mesh area's share past it.
  excess: EXCESS_BOUNDS.map(() => 0), share: AREA_BOUNDS.map(() => 0),
  // Faces whose sampled deviation is within the deflection, and those of them past the limit (the caller's).
  within: 0, withinMissed: 0,
});
export type Angles = ReturnType<typeof freshAngles>;

/** One face's faceAngles (at `limit`, degrees) into A; a face past it with no area counts as all its area past. */
export function addAngles(A: Angles, f: FaceAngles, limit: number): void {
  A.faces++;
  if (f.missed) {
    A.facesMissed++, A.excess[excessBin(f.worst - limit)]!++;
    A.share[areaBin(f.area > 0 ? f.missedArea / f.area : 1)]!++;
  }
  if (f.spread) A.facesSpread++;
  if (f.excluded) A.facesExcluded++;
  A.triangles += f.triangles, A.missed += f.missed, A.spread += f.spread, A.excluded += f.excluded;
  A.unmeasured += f.unmeasured;
  A.area += f.area, A.missedArea += f.missedArea, A.spreadArea += f.spreadArea, A.excludedArea += f.excludedArea;
  A.unmeasuredArea += f.unmeasuredArea;
}

function triangleArea(p: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = p[3 * b]! - p[3 * a]!, uy = p[3 * b + 1]! - p[3 * a + 1]!, uz = p[3 * b + 2]! - p[3 * a + 2]!;
  const vx = p[3 * c]! - p[3 * a]!, vy = p[3 * c + 1]! - p[3 * a + 1]!, vz = p[3 * c + 2]! - p[3 * a + 2]!;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  return 0.5 * Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/** A quantile (0..1) of a binned tally, as its bin's upper edge from `edge(bin)`; NaN where it's empty. */
export function quantile(bins: readonly number[], q: number, edge: (bin: number) => number): number {
  const total = bins.reduce((s, x) => s + x, 0);
  if (!total) return NaN;
  let acc = 0;
  for (let k = 0; k < bins.length; k++) {
    acc += bins[k]!;
    if (acc > 0 && acc >= q * total) return edge(k);
  }
  return edge(bins.length - 1);
}
export const angleEdge = (k: number) => Math.min(60, (k + 1) * ANGLE_STEP);
export const aspectEdge = (k: number) => k === ASPECT_BINS - 1 ? Infinity : 10 ** ((k + 1) / ASPECT_PER_DECADE);
