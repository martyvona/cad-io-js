// The mesh survey beside coverage_corpus.ts: over the faces every backend meshes, each backend's triangles' shapes
// in 3D (smallest angle, aspect), its triangles per face against SMLib's, and each face's worst sampled deviation
// from its surface. Tallies are fixed-length number arrays, so runner.ts's addInto sums them across children.
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

/** What deviation sampling needs of cad-geom's Geometry (a stand-in in tests). */
export interface Inverter {
  surfaceInfo(row: number): { status: string; u: [number, number]; v: [number, number] };
  invertSurface(row: number, points: ArrayLike<number>, box: ArrayLike<number>, tol: number):
    { status: string; distance: Float64Array; statuses: Uint8Array };
}

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
